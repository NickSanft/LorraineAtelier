//! Desktop-layer interactivity via a global low-level mouse hook (WH_MOUSE_LL).
//!
//! The pills / cast-glyph / brushbuddy are DRAWN on the wallpaper (which sits below
//! the desktop icons, so the OS never delivers clicks to it). Instead this hook
//! observes the global cursor and acts on a click ONLY when the desktop is the
//! exposed surface at that point (`workerw::desktop_exposed_at`) — so any app on top
//! transparently keeps priority. It shows/activates no window, so it can never steal
//! focus (the casting modal is the only focus-taker, and only when the user invokes
//! it). Gated entirely by the persisted `desktop_interactive` toggle.
//!
//! CHUNK A (this version) is OBSERVE-ONLY: it logs whether each click landed on the
//! exposed desktop and NEVER suppresses an event (always CallNextHookEx), so it
//! physically cannot affect input. Suppression + real actions (launch / cast / drag)
//! layer on in later chunks.
//!
//! Hot-path discipline (LowLevelHooksTimeout silently kills a slow hook): the proc
//! does the bare minimum and hands work to a consumer thread via a channel. Never
//! panic in the proc — a panic unwinding out of this `extern "system"` callback
//! aborts the process at the FFI boundary; only deref lParam on HC_ACTION.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT,
};

use crate::workerw;

/// Whether the hook thread is currently installed/alive.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// The hook thread's id, so we can PostThreadMessage(WM_QUIT) to stop it.
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// One consumer thread, started lazily, owns the Receiver and does the heavy work.
static CONSUMER_STARTED: AtomicBool = AtomicBool::new(false);
/// Hook proc → consumer channel. Mutex only ever locked by the (single) hook thread,
/// so it is never contended.
static SENDER: OnceLock<Mutex<Sender<HookMsg>>> = OnceLock::new();

enum HookMsg {
    /// A confirmed hit on a desktop widget (already gated on the exposed desktop).
    Action(HitTarget),
    /// A buddy drag ended — persist its dropped position (file I/O, off the proc).
    PersistBuddy,
}

/// What a published hit-rect triggers when clicked on the exposed desktop.
#[derive(Clone)]
pub enum HitTarget {
    /// Open the casting slate (the ⚝ cast glyph).
    Cast,
    /// Launch the element's bound app (a spell pill).
    Pill(String),
    /// Toggle day/night (the dock's mode indicator).
    Mode,
    /// Toggle "Attune to music" (the seal's Attune/Resonance pill).
    Attune,
    /// Open the Tower of Tomes spellbook (the dock's ❧ Tomes button).
    Tomes,
}

struct GlobalRect {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    target: HitTarget,
}

fn rects() -> &'static Mutex<Vec<GlobalRect>> {
    static R: OnceLock<Mutex<Vec<GlobalRect>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::new()))
}

/// Replace the published hit-rects (virtual-desktop physical px). lib.rs rebuilds
/// and pushes these whenever a wallpaper reports its dock/cast layout.
pub fn set_global_rects(v: Vec<(i32, i32, i32, i32, HitTarget)>) {
    let mapped = v
        .into_iter()
        .map(|(x0, y0, x1, y1, target)| GlobalRect { x0, y0, x1, y1, target })
        .collect();
    *rects().lock().unwrap_or_else(|e| e.into_inner()) = mapped;
}

/// Push a message to the consumer (the Mutex is only ever locked by the hook
/// thread, so it never contends).
fn send(msg: HookMsg) {
    if let Some(tx) = SENDER.get() {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(msg);
        }
    }
}

/// Cheap point-in-rect test (pure math) — safe to run on the hot path.
fn hit_test(x: i32, y: i32) -> Option<HitTarget> {
    let g = rects().lock().unwrap_or_else(|e| e.into_inner());
    g.iter()
        .find(|r| x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)
        .map(|r| r.target.clone())
}

/// RAII: unhook when the message-loop thread unwinds/exits.
struct HookGuard(HHOOK);
impl Drop for HookGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWindowsHookEx(self.0);
        }
    }
}

unsafe extern "system" fn mouse_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    // Only inspect (and only deref lParam) for real action notifications.
    if n_code == HC_ACTION as i32 {
        let msg = w_param.0 as u32;
        if msg == WM_LBUTTONDOWN {
            let info = &*(l_param.0 as *const MSLLHOOKSTRUCT);
            let (x, y) = (info.pt.x, info.pt.y);
            // Cheap rect check FIRST; only on a hit do the (heavier) desktop-exposed
            // query — so the vast majority of clicks cost a pure point-in-rect test.
            if let Some(target) = hit_test(x, y) {
                if workerw::desktop_exposed_at(POINT { x, y }) {
                    send(HookMsg::Action(target));
                    return LRESULT(1); // swallow so the desktop never sees the click
                }
            }
            // The buddy is a moving target Rust owns; grab it if the click is on it
            // and the desktop is exposed there.
            if crate::buddy_hit_test(x, y) && workerw::desktop_exposed_at(POINT { x, y }) {
                crate::buddy_begin_drag(x, y);
                return LRESULT(1); // swallow → no desktop rubber-band while dragging
            }
        } else if msg == WM_MOUSEMOVE {
            if crate::buddy_dragging() {
                let info = &*(l_param.0 as *const MSLLHOOKSTRUCT);
                crate::buddy_drag_to(info.pt.x, info.pt.y);
                // Do NOT suppress moves: a swallowed WM_MOUSEMOVE freezes the system
                // cursor (that's how the cursor advances), which kills the drag. The
                // down was already swallowed, so no desktop rubber-band is active.
            }
        } else if msg == WM_LBUTTONUP {
            if crate::buddy_dragging() {
                crate::buddy_release();
                send(HookMsg::PersistBuddy);
                return LRESULT(1); // swallow the up that ends the drag
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

/// Spawn the consumer once: it classifies each click off the hot path and (for now)
/// just logs whether the desktop was exposed there.
fn ensure_consumer(app: &AppHandle) {
    if CONSUMER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = channel::<HookMsg>();
    let _ = SENDER.set(Mutex::new(tx));
    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match msg {
                HookMsg::Action(HitTarget::Cast) => {
                    let _ = app.emit("dock:tap", "cast"); // flash the tapped cell
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || crate::hook_cast(&app2));
                    let _ = app.emit("log", "hook: cast glyph → open casting");
                }
                HookMsg::Action(HitTarget::Pill(key)) => {
                    let _ = app.emit("dock:tap", format!("pill:{key}"));
                    let _ = crate::casting::test_launch(key.clone());
                    let _ = app.emit("log", format!("hook: pill → {key}"));
                }
                HookMsg::Action(HitTarget::Mode) => {
                    let _ = app.emit("dock:tap", "mode");
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || crate::hook_toggle_mode(&app2));
                }
                HookMsg::Action(HitTarget::Attune) => {
                    let _ = app.emit("dock:tap", "attune");
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || crate::hook_toggle_attune(&app2));
                }
                HookMsg::Action(HitTarget::Tomes) => {
                    let _ = app.emit("dock:tap", "tomes");
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || crate::hook_open_tomes(&app2));
                }
                HookMsg::PersistBuddy => {
                    crate::buddy_persist(); // file I/O, off the hook proc
                }
            }
        }
    });
}

fn spawn_hook_thread(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                RUNNING.store(false, Ordering::SeqCst);
                HOOK_THREAD_ID.store(0, Ordering::SeqCst);
                let _ = app.emit("log", format!("hook: install failed: {e}"));
                return;
            }
        };
        let _guard = HookGuard(hook);
        let _ = app.emit("log", "hook: installed");
        // The low-level hook fires by posting to THIS thread, so it needs a pump.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        HOOK_THREAD_ID.store(0, Ordering::SeqCst);
        let _ = app.emit("log", "hook: removed");
        // _guard drops here → UnhookWindowsHookEx.
    });
}

/// Install or remove the hook to match the toggle. Idempotent.
pub fn set_enabled(app: &AppHandle, on: bool) {
    if on {
        ensure_consumer(app);
        if !RUNNING.swap(true, Ordering::SeqCst) {
            spawn_hook_thread(app.clone());
        }
    } else if RUNNING.swap(false, Ordering::SeqCst) {
        let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}
