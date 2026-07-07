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

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU8, Ordering};
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
    /// The hovered dock cell changed — the consumer verifies the desktop is exposed
    /// there and emits `dock:hover` so the wallpaper can light that cell (empty = leave).
    Hover { x: i32, y: i32, key: String },
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

/// Union bounding box of all hit-rects [x0, y0, x1, y1] in virtual-desktop physical px —
/// a cheap gate so hover hit-testing runs only when the cursor is near the dock. All zero
/// = no rects published (hover off).
static HOVER_AABB: [AtomicI32; 4] =
    [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)];
/// The currently-hovered cell, encoded, so the proc only sends a Hover on a real change.
static LAST_HOVER_CODE: AtomicU8 = AtomicU8::new(0);

/// Replace the published hit-rects (virtual-desktop physical px). lib.rs rebuilds
/// and pushes these whenever a wallpaper reports its dock/cast layout.
pub fn set_global_rects(v: Vec<(i32, i32, i32, i32, HitTarget)>) {
    let (mut ux0, mut uy0, mut ux1, mut uy1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    let mapped: Vec<GlobalRect> = v
        .into_iter()
        .map(|(x0, y0, x1, y1, target)| {
            ux0 = ux0.min(x0);
            uy0 = uy0.min(y0);
            ux1 = ux1.max(x1);
            uy1 = uy1.max(y1);
            GlobalRect { x0, y0, x1, y1, target }
        })
        .collect();
    let (ax0, ay0, ax1, ay1) = if mapped.is_empty() { (0, 0, 0, 0) } else { (ux0, uy0, ux1, uy1) };
    HOVER_AABB[0].store(ax0, Ordering::Relaxed);
    HOVER_AABB[1].store(ay0, Ordering::Relaxed);
    HOVER_AABB[2].store(ax1, Ordering::Relaxed);
    HOVER_AABB[3].store(ay1, Ordering::Relaxed);
    *rects().lock().unwrap_or_else(|e| e.into_inner()) = mapped;
}

/// Encode a hovered target so the proc can dedupe (send only on change) without allocating.
fn hover_code(t: &Option<HitTarget>) -> u8 {
    match t {
        None => 0,
        Some(HitTarget::Cast) => 1,
        Some(HitTarget::Mode) => 2,
        Some(HitTarget::Attune) => 3,
        Some(HitTarget::Tomes) => 4,
        Some(HitTarget::Pill(k)) => match k.as_str() {
            "fire" => 5,
            "water" => 6,
            "wind" => 7,
            "earth" => 8,
            _ => 9,
        },
    }
}

/// The frontend key for a hovered target (mirrors the `dock:tap` payloads); empty = none.
fn hover_string(t: &Option<HitTarget>) -> String {
    match t {
        None => String::new(),
        Some(HitTarget::Cast) => "cast".into(),
        Some(HitTarget::Mode) => "mode".into(),
        Some(HitTarget::Attune) => "attune".into(),
        Some(HitTarget::Tomes) => "tomes".into(),
        Some(HitTarget::Pill(k)) => format!("pill:{k}"),
    }
}

/// Hot-path hover tracking: a cheap union-AABB gate (four atomic loads), then the full
/// point-in-rect test ONLY when the cursor is inside the dock region; hand a Hover to the
/// consumer only when the hovered cell actually changes. The heavier desktop-exposed check
/// happens off the proc, in the consumer.
fn update_hover(x: i32, y: i32) {
    let x0 = HOVER_AABB[0].load(Ordering::Relaxed);
    let y0 = HOVER_AABB[1].load(Ordering::Relaxed);
    let x1 = HOVER_AABB[2].load(Ordering::Relaxed);
    let y1 = HOVER_AABB[3].load(Ordering::Relaxed);
    let inside = x1 > x0 && x >= x0 && x <= x1 && y >= y0 && y <= y1;
    let target = if inside { hit_test(x, y) } else { None };
    let code = hover_code(&target);
    if LAST_HOVER_CODE.swap(code, Ordering::Relaxed) != code {
        send(HookMsg::Hover { x, y, key: hover_string(&target) });
    }
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
            let info = &*(l_param.0 as *const MSLLHOOKSTRUCT);
            if crate::buddy_dragging() {
                crate::buddy_drag_to(info.pt.x, info.pt.y);
                // Do NOT suppress moves: a swallowed WM_MOUSEMOVE freezes the system
                // cursor (that's how the cursor advances), which kills the drag. The
                // down was already swallowed, so no desktop rubber-band is active.
            } else {
                // Track dock hover (cheap AABB gate; full test only over the dock).
                update_hover(info.pt.x, info.pt.y);
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
                HookMsg::Hover { x, y, key } => {
                    // Light a cell only when the desktop is exposed there (an app on top
                    // keeps priority); an empty key is a leave and always clears.
                    let show =
                        !key.is_empty() && workerw::desktop_exposed_at(POINT { x, y });
                    let _ = app.emit("dock:hover", if show { key } else { String::new() });
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
        // Capture our own thread id so teardown only clears the shared slot if it
        // STILL names us. A fast off→on→off toggle can spawn the next hook thread
        // before this one finishes draining WM_QUIT; an unconditional store(0) on
        // exit would then clobber the NEW thread's id, so a later set_enabled(off)
        // reads 0, never posts WM_QUIT, and that new pump thread blocks in
        // GetMessageW forever — leaking the thread and its WH_MOUSE_LL hook (and,
        // since RUNNING is cleared, the next "on" installs yet another live hook).
        let my_tid = GetCurrentThreadId();
        HOOK_THREAD_ID.store(my_tid, Ordering::SeqCst);
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                RUNNING.store(false, Ordering::SeqCst);
                let _ =
                    HOOK_THREAD_ID.compare_exchange(my_tid, 0, Ordering::SeqCst, Ordering::SeqCst);
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
        // Only clear the slot if it still names us — a newer hook thread may have
        // already claimed it during a rapid toggle, and zeroing its id would strand it.
        let _ = HOOK_THREAD_ID.compare_exchange(my_tid, 0, Ordering::SeqCst, Ordering::SeqCst);
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
