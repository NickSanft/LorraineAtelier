//! Persistent per-monitor native "host" window.
//!
//! Why this exists: a window parented under WorkerW is destroyed when explorer
//! restarts (Slice 1 confirmed `IsWindow=false` afterwards). We can't recreate a
//! Tauri webview window at runtime (its `hwnd()` is never exposed). So instead we
//! own a cheap native host window per monitor (WS_CHILD of WorkerW) and reparent
//! each Tauri window's *WebView2 controller* into it (see lib.rs). On an explorer
//! restart only the host dies — we recreate it and re-home the surviving
//! controller, so the wallpaper comes back without a reload.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, RegisterClassW,
    WINDOW_EX_STYLE, WM_ERASEBKGND, WNDCLASSW, WS_CHILD, WS_VISIBLE,
};

use crate::workerw::Monitor;

const HOST_CLASS: PCWSTR = w!("LorraineWallpaperHost");
static CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn host_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        // We never paint; the embedded WebView2 covers the whole client area.
        // Claiming the erase avoids a white flash on (re)attach.
        WM_ERASEBKGND => LRESULT(1),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn ensure_class() {
    if CLASS_REGISTERED.swap(true, Ordering::Relaxed) {
        return;
    }
    unsafe {
        let hinst: HINSTANCE = GetModuleHandleW(None).map(HINSTANCE::from).unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(host_wndproc),
            hInstance: hinst,
            lpszClassName: HOST_CLASS,
            ..Default::default()
        };
        // Returns 0 (and sets last error) if already registered — harmless.
        RegisterClassW(&wc);
    }
}

/// Create a host window as a WS_CHILD of `parent` (the WorkerW), positioned over
/// `mon`. Coordinates are relative to the parent's client origin.
pub fn create_host(parent: HWND, mon: &Monitor) -> Option<HWND> {
    ensure_class();
    unsafe {
        let hinst: HINSTANCE = GetModuleHandleW(None).ok().map(HINSTANCE::from)?;

        // WorkerW may not start at screen (0,0) on multi-monitor layouts.
        let mut origin = POINT { x: 0, y: 0 };
        let _ = ClientToScreen(parent, &mut origin);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            HOST_CLASS,
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE,
            mon.x - origin.x,
            mon.y - origin.y,
            mon.width,
            mon.height,
            Some(parent),
            None,
            Some(hinst),
            None,
        )
        .ok()?;

        if hwnd.0.is_null() {
            None
        } else {
            Some(hwnd)
        }
    }
}

pub fn destroy_host(hwnd: HWND) {
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
}

/// The host's client size in physical pixels. Used to assert the no-multiply
/// placement actually fills the monitor at fractional DPI.
pub fn client_size(hwnd: HWND) -> (i32, i32) {
    unsafe {
        let mut r = RECT::default();
        if GetClientRect(hwnd, &mut r).is_ok() {
            (r.right - r.left, r.bottom - r.top)
        } else {
            (0, 0)
        }
    }
}
