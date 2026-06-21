//! Windows desktop-shell integration — ported from the JUCE LiveWallpaperPrototype.
//!
//! Strategy (proven on this machine, Win11 26200):
//!   1. Ask Progman to spawn the wallpaper-layer WorkerW (undocumented 0x052C).
//!   2. Locate that WorkerW: first as a child of Progman (Win11), else by
//!      enumerating top-level WorkerW windows for the one WITHOUT a
//!      SHELLDLL_DefView child (Win10/Lively-style); fall back to Progman.
//!   3. Convert our render window from a top-level popup to a WS_CHILD, SetParent
//!      it under the WorkerW, and place it at the monitor's physical rect
//!      (relative to the parent's client origin). WS_CHILD is essential — with
//!      WS_POPUP, HWND_BOTTOM hides the window behind Progman's wallpaper paint.
//!
//! The process is PerMonitorV2-aware, so GetMonitorInfoW / virtual-screen metrics
//! are already in physical pixels — no scale multiply is needed (unlike the JUCE
//! port, which received logical DIPs from JUCE and had to multiply).

#![cfg(windows)]

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, TRUE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};

/// MONITORINFOF_PRIMARY — the `dwFlags` bit marking the primary monitor. Not
/// re-exported in our windows-rs feature set, so we use its documented value.
const MONITORINFOF_PRIMARY: u32 = 1;
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, Debug)]
pub struct Monitor {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub dpi: u32,
    pub primary: bool,
    // Work area (`rcWork`): the monitor minus any space-reserving (pinned, non-
    // auto-hide) taskbar / appbars, in the same physical virtual-desktop coords.
    // Equals the full monitor rect when the taskbar auto-hides (reserves nothing).
    pub work_x: i32,
    pub work_y: i32,
    pub work_w: i32,
    pub work_h: i32,
}

/// Declare PerMonitorV2 awareness. Call before any window is created. Harmless
/// if the windowing layer already set an awareness context (the call just fails).
pub fn set_dpi_awareness() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn is_null(h: HWND) -> bool {
    h.0.is_null()
}

fn window_area(h: HWND) -> i64 {
    unsafe {
        let mut r = RECT::default();
        if GetWindowRect(h, &mut r).is_ok() {
            (r.right - r.left) as i64 * (r.bottom - r.top) as i64
        } else {
            0
        }
    }
}

struct EnumState {
    best: HWND,
    best_area: i64,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let st = &mut *(lparam.0 as *mut EnumState);

    let mut cls = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut cls);
    if n <= 0 {
        return TRUE;
    }
    let name = String::from_utf16_lossy(&cls[..n as usize]);
    if name != "WorkerW" || !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }

    // The wallpaper-layer WorkerW is the one that does NOT host the icons.
    let def = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), PCWSTR::null());
    let has_defview = matches!(def, Ok(h) if !is_null(h));
    if has_defview {
        return TRUE;
    }

    let area = window_area(hwnd);
    if area > st.best_area {
        st.best = hwnd;
        st.best_area = area;
    }
    TRUE
}

pub fn get_progman() -> Option<HWND> {
    unsafe { FindWindowW(w!("Progman"), PCWSTR::null()).ok().filter(|h| !is_null(*h)) }
}


/// Spawn (if needed) and locate the wallpaper-layer WorkerW. Falls back to
/// Progman itself if no suitable WorkerW is found.
pub fn ensure_workerw() -> Option<HWND> {
    unsafe {
        let progman = get_progman()?;

        // Proven on this box: wParam 0xD / lParam 0x1 spawns the WorkerW layer.
        // Idempotent + harmless if one already exists. We never trust the return.
        let mut res: usize = 0;
        SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0xD),
            LPARAM(0x1),
            SMTO_NORMAL,
            1000,
            Some(&mut res as *mut usize),
        );

        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN) as i64;
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN) as i64;
        let min_area = (vw * vh) / 4;

        // Path A (Win11): WorkerW is a direct child of Progman.
        if let Ok(child) = FindWindowExW(Some(progman), None, w!("WorkerW"), PCWSTR::null()) {
            if !is_null(child) && window_area(child) >= min_area {
                return Some(child);
            }
        }

        // Path B (Win10 / Lively): top-level WorkerW without a DefView child.
        let mut st = EnumState { best: HWND::default(), best_area: 0 };
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut st as *mut _ as isize));
        if !is_null(st.best) && st.best_area >= min_area {
            return Some(st.best);
        }

        // Fallback: parent directly to Progman.
        Some(progman)
    }
}

/// Re-style `child` as a WS_CHILD of `parent` and place it over `mon`.
/// Superseded by the host-window + controller-reparent model (see host.rs);
/// kept as reference for a possible direct-attach fallback.
#[allow(dead_code)]
pub fn attach(child: HWND, parent: Option<HWND>, mon: &Monitor) -> bool {
    let Some(parent) = parent else { return false };
    unsafe {
        let mut style = GetWindowLongPtrW(child, GWL_STYLE) as u32;
        style &= !(WS_CAPTION.0
            | WS_THICKFRAME.0
            | WS_MINIMIZEBOX.0
            | WS_MAXIMIZEBOX.0
            | WS_SYSMENU.0
            | WS_BORDER.0
            | WS_DLGFRAME.0
            | WS_POPUP.0);
        style |= WS_CHILD.0 | WS_VISIBLE.0;
        SetWindowLongPtrW(child, GWL_STYLE, style as isize);

        let mut ex = GetWindowLongPtrW(child, GWL_EXSTYLE) as u32;
        ex &= !(WS_EX_TOOLWINDOW.0 | WS_EX_APPWINDOW.0);
        SetWindowLongPtrW(child, GWL_EXSTYLE, ex as isize);

        if SetParent(child, Some(parent)).is_err() {
            return false;
        }

        // Progman may start at a non-(0,0) origin on multi-monitor layouts.
        let mut origin = POINT { x: 0, y: 0 };
        let _ = ClientToScreen(parent, &mut origin);

        SetWindowPos(
            child,
            Some(HWND_BOTTOM),
            mon.x - origin.x,
            mon.y - origin.y,
            mon.width,
            mon.height,
            SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOACTIVATE,
        )
        .is_ok()
    }
}

/// Restore a window to a normal top-level window (used on shutdown).
#[allow(dead_code)]
pub fn detach(child: HWND) {
    unsafe {
        let _ = SetParent(child, None);
    }
}

pub fn is_window(h: HWND) -> bool {
    unsafe { IsWindow(Some(h)).as_bool() }
}

static CACHED_WORKER: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Like `ensure_workerw`, but caches the handle and only re-probes (re-sending
/// the spawn message) when the cached WorkerW is no longer a live window —
/// avoids spamming Progman with 0x052C on every watchdog tick.
pub fn cached_workerw() -> Option<HWND> {
    use std::sync::atomic::Ordering;
    let cached = CACHED_WORKER.load(Ordering::Relaxed);
    if cached != 0 {
        let h = HWND(cached as *mut core::ffi::c_void);
        if is_window(h) {
            return Some(h);
        }
    }
    let w = ensure_workerw();
    CACHED_WORKER.store(w.map(|h| h.0 as isize).unwrap_or(0), Ordering::Relaxed);
    w
}

unsafe extern "system" fn monitor_proc(
    hmon: HMONITOR,
    _hdc: HDC,
    _rc: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let v = &mut *(data.0 as *mut Vec<Monitor>);
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(hmon, &mut mi).as_bool() {
        let r = mi.rcMonitor; // physical pixels (PerMonitorV2 process)
        let wr = mi.rcWork; // monitor minus space-reserving taskbar/appbars
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        v.push(Monitor {
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
            dpi: dx,
            primary: (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
            work_x: wr.left,
            work_y: wr.top,
            work_w: wr.right - wr.left,
            work_h: wr.bottom - wr.top,
        });
    }
    TRUE
}

/// All monitors in physical-pixel virtual-desktop coordinates.
pub fn enum_monitors() -> Vec<Monitor> {
    let mut v: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor_proc), LPARAM(&mut v as *mut _ as isize));
        if v.is_empty() {
            let (vx, vy, vw, vh) = (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            );
            v.push(Monitor {
                x: vx,
                y: vy,
                width: vw,
                height: vh,
                dpi: 96,
                primary: true,
                work_x: vx,
                work_y: vy,
                work_w: vw,
                work_h: vh,
            });
        }
    }
    v
}

/// True if `mon` is fully covered by a non-shell, non-ours top-level window
/// (true / borderless fullscreen). Tests the window at the monitor's CENTRE, so it
/// pauses regardless of focus — a fullscreen window keeps the monitor paused even
/// when you switch to another window/monitor (no flapping), and a fullscreen
/// video on a second monitor pauses that monitor while you work on the first.
/// A *maximized* window leaves the taskbar visible, so it doesn't fully cover the
/// monitor and is correctly ignored.
pub fn monitor_covered(mon: &Monitor) -> bool {
    unsafe {
        let pt = POINT {
            x: mon.x + mon.width / 2,
            y: mon.y + mon.height / 2,
        };
        let hit = WindowFromPoint(pt);
        if hit.0.is_null() {
            return false;
        }
        let root = GetAncestor(hit, GA_ROOT);
        let top = if root.0.is_null() { hit } else { root };

        // Our own wallpaper/overlay never counts.
        let mut pid = 0u32;
        GetWindowThreadProcessId(top, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }
        // The desktop / icons / taskbar never count.
        let mut cls = [0u16; 64];
        let n = GetClassNameW(top, &mut cls);
        let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if matches!(
            class.as_str(),
            "Progman"
                | "WorkerW"
                | "SHELLDLL_DefView"
                | "Shell_TrayWnd"
                | "Shell_SecondaryTrayWnd"
                | "Windows.UI.Core.CoreWindow"
        ) {
            return false;
        }
        let mut r = RECT::default();
        if GetWindowRect(top, &mut r).is_err() {
            return false;
        }
        r.left <= mon.x && r.top <= mon.y && r.right >= mon.x + mon.width && r.bottom >= mon.y + mon.height
    }
}

/// Place a top-level window so it covers the entire virtual desktop (used for
/// the casting overlay when summoned).
pub fn cover_virtual_screen(hwnd: HWND) {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let cx = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let cy = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, cx, cy, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}
