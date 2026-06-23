//! Sleep/wake + lock/unlock resilience (Phase 13.1).
//!
//! A 24/7 wallpaper must survive the machine sleeping, hibernating, and locking every
//! day — a blank or frozen wallpaper one morning would quietly ruin the surprise. The
//! app already recovers from explorer restarts / display changes via the watchdog's
//! `ensure_attached`, but nothing reacts to power/session events: after a resume a
//! host can be dead (or a controller blank) and only the ~600 ms poll might catch it,
//! or — for a live-but-blank controller — never. This module owns a hidden
//! message-only window that receives suspend/resume + session-change notifications and
//! drives an immediate recovery on the main thread: a RESUME forces a full re-attach
//! (guaranteed clean), an UNLOCK runs a normal validation pass (cheap; catches a host
//! that died while locked). Modeled on hook.rs's message pump + host.rs's class.

#![cfg(windows)]

use std::sync::OnceLock;
use tauri::AppHandle;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, MSG, WM_POWERBROADCAST, WNDCLASSW,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

/// Deliver session notifications for the current session only.
const NOTIFY_FOR_THIS_SESSION: u32 = 0;

// Win32 power/session event codes. Stable values, defined locally because this
// windows-rs feature set doesn't surface all of them as bindings.
// PBT_APMRESUMEAUTOMATIC is sent on EVERY resume; PBT_APMRESUMESUSPEND is sent
// ADDITIONALLY on a user-initiated wake — so handling only the former recovers once.
const PBT_APMRESUMEAUTOMATIC: u32 = 0x0012;
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_UNLOCK: u32 = 0x8;
const WTS_SESSION_LOGON: u32 = 0x5;

/// The AppHandle, so the WndProc (on the pump thread) can queue recovery onto main.
static APP: OnceLock<AppHandle> = OnceLock::new();
const WATCH_CLASS: PCWSTR = w!("LorraineSessionWatch");

/// Queue the recovery onto the main thread (WebView2 controller calls require it).
fn dispatch(force: bool) {
    if let Some(app) = APP.get() {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            if force {
                crate::power_resume(&a);
            } else {
                crate::power_session_active(&a);
            }
        });
    }
}

unsafe extern "system" fn watch_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_POWERBROADCAST => {
            let ev = wparam.0 as u32;
            // Resume from sleep/hibernate → force a full re-attach (guaranteed clean).
            if ev == PBT_APMRESUMEAUTOMATIC {
                dispatch(true);
            }
            LRESULT(1) // TRUE — grant the broadcast
        }
        WM_WTSSESSION_CHANGE => {
            let ev = wparam.0 as u32;
            // Unlock / logon → a normal validation pass (catches a host that died
            // while locked; healthy controllers are left untouched — no reload).
            if ev == WTS_SESSION_UNLOCK || ev == WTS_SESSION_LOGON {
                dispatch(false);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Start the power/session watcher. Call once at setup. Spawns a thread that owns a
/// hidden message-only window registered for suspend/resume + session notifications.
pub fn start(app: AppHandle) {
    if APP.set(app).is_err() {
        return; // already started
    }
    std::thread::spawn(move || unsafe {
        let hinst: HINSTANCE = GetModuleHandleW(None).map(HINSTANCE::from).unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(watch_wndproc),
            hInstance: hinst,
            lpszClassName: WATCH_CLASS,
            ..Default::default()
        };
        RegisterClassW(&wc); // 0 if already registered — harmless

        // A hidden TOP-LEVEL window (not message-only): WM_POWERBROADCAST is delivered
        // to top-level windows, but NOT to message-only ones — so suspend/resume only
        // arrives here. WS_EX_TOOLWINDOW keeps it off the taskbar; never shown (no
        // WS_VISIBLE), zero size, so it's invisible — it exists only to receive events.
        let hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW,
            WATCH_CLASS,
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None, // top-level
            None,
            Some(hinst),
            None,
        ) {
            Ok(h) if !h.0.is_null() => h,
            _ => return,
        };

        // Deliver WM_POWERBROADCAST to THIS window (a targeted notification, not a
        // broadcast — message-only windows don't receive broadcasts otherwise). Keep
        // the handle bound for the thread's life so the registration stays active.
        let _power_notify = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);

        // Pump: sent messages (the notifications) are dispatched to the WndProc while
        // the thread sits in GetMessage. Runs for the app's life (no WM_QUIT sent).
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
