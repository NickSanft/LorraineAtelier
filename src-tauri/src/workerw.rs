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

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use windows::core::{w, BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, FALSE, TRUE, WPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, HDC, HMONITOR,
    MONITORINFO, MONITOR_DEFAULTTONEAREST,
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

/// Is the DESKTOP the exposed top surface at this screen point (vs. an app window
/// on top)? True only when the window under `pt` resolves to a shell desktop class
/// (Progman / WorkerW / SHELLDLL_DefView) or to one of OUR OWN windows (the
/// wallpaper host lives under WorkerW). This is the gate that makes desktop widgets
/// interactive ONLY when nothing covers them — apps always keep priority. Fail-safe:
/// any uncertainty (null hit, unknown class) returns false → the click passes to
/// whatever is there. Mirrors `monitor_covered`'s class/PID logic.
pub fn desktop_exposed_at(pt: POINT) -> bool {
    unsafe {
        let hit = WindowFromPoint(pt);
        if hit.0.is_null() {
            return false;
        }
        let root = GetAncestor(hit, GA_ROOT);
        let top = if root.0.is_null() { hit } else { root };
        // Our own wallpaper host (a WS_CHILD under WorkerW) counts as desktop.
        let mut pid = 0u32;
        GetWindowThreadProcessId(top, Some(&mut pid));
        if pid == std::process::id() {
            return true;
        }
        let mut cls = [0u16; 64];
        let n = GetClassNameW(top, &mut cls);
        let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        matches!(class.as_str(), "Progman" | "WorkerW" | "SHELLDLL_DefView")
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

struct ActivateState {
    targets: Vec<String>,
    found: bool,
}

unsafe extern "system" fn activate_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let st = &mut *(lparam.0 as *mut ActivateState);
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    if GetWindowTextLengthW(hwnd) == 0 {
        return TRUE; // no title → tool window / shell surface, skip
    }
    // Never foreground the desktop or taskbar (also explorer.exe-owned).
    let mut cls = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut cls);
    let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
    if matches!(
        class.as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow"
    ) {
        return TRUE;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return TRUE;
    }
    if let Ok(hp) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        let mut buf = [0u16; 260];
        let mut sz = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(hp, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut sz).is_ok();
        let _ = CloseHandle(hp);
        if ok {
            let full = String::from_utf16_lossy(&buf[..sz as usize]);
            let base = full.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
            if st.targets.iter().any(|t| *t == base) {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                } else {
                    let _ = ShowWindow(hwnd, SW_SHOW);
                }
                let _ = SetForegroundWindow(hwnd);
                st.found = true;
                return FALSE; // stop enumeration
            }
        }
    }
    TRUE
}

/// Find a visible, titled top-level window belonging to any of `exe_names`
/// (basename, case-insensitive), restore it if minimized, and bring it to the
/// foreground. Returns true if one was activated. Shell surfaces (desktop/taskbar)
/// are excluded so an explorer.exe match never foregrounds the desktop. Used to
/// "focus the running app" before falling back to launching a new instance.
pub fn activate_window_for(exe_names: &[&str]) -> bool {
    let mut st = ActivateState {
        targets: exe_names.iter().map(|s| s.to_lowercase()).collect(),
        found: false,
    };
    unsafe {
        let _ = EnumWindows(Some(activate_proc), LPARAM(&mut st as *mut _ as isize));
    }
    st.found
}

// ---------------------------------------------------------------------------
// Casting overlay: a normal top-level window shown ON DEMAND (the casting slate /
// storybook), NOT always-shown. An always-shown top-level WebView2 window keeps
// seizing the foreground (WebView2 grabs focus on load; a topmost window re-wins
// it) and SetForegroundWindow can't reliably hand it back — that jams all keyboard
// and taskbar input. So the overlay stays hidden at rest; opening casting shows +
// focuses it as a modal, and closing hides it and restores the prior foreground.
// (Desktop dock/buddy interaction is handled outside this window.)
// ---------------------------------------------------------------------------

static OVERLAY_CASTING: AtomicBool = AtomicBool::new(false);
// The foreground window the user was on before casting, so we can hand it back.
static PREV_FOREGROUND: AtomicIsize = AtomicIsize::new(0);
// Set when a cast just brought its target app to the foreground, so the next
// `restore_foreground()` leaves that app focused rather than clawing the foreground
// back to the pre-cast window.
static CAST_FOREGROUND: AtomicBool = AtomicBool::new(false);

/// Whether the casting slate is currently open.
pub fn set_overlay_casting(active: bool) {
    OVERLAY_CASTING.store(active, Ordering::Relaxed);
}

pub fn overlay_casting() -> bool {
    OVERLAY_CASTING.load(Ordering::Relaxed)
}

/// Remember the window the user is on right now (called before casting takes
/// focus) so close_casting can return them to it.
pub fn snapshot_foreground() {
    unsafe {
        let fg = GetForegroundWindow();
        PREV_FOREGROUND.store(fg.0 as isize, Ordering::Relaxed);
    }
}

/// A guaranteed-valid window to hand the foreground to: the captured candidate if
/// it's still a live window, else the shell desktop (Progman).
fn unjam_target(candidate: isize) -> Option<HWND> {
    unsafe {
        if candidate != 0 {
            let h = HWND(candidate as *mut core::ffi::c_void);
            if IsWindow(Some(h)).as_bool() {
                return Some(h);
            }
        }
        let shell = GetShellWindow();
        if shell.0 as isize != 0 {
            return Some(shell);
        }
        None
    }
}

/// Called by a cast that has just focused (or launched) its target app, so the next
/// `restore_foreground()` is suppressed and the cast app keeps the foreground.
pub fn note_cast_foreground() {
    CAST_FOREGROUND.store(true, Ordering::Relaxed);
}

/// Hand the foreground back to whatever the user was using before casting (falling
/// back to the shell desktop). This is the allowed direction for SetForegroundWindow:
/// we currently own the foreground (the casting overlay), so we may pass it on. If a
/// cast just brought its app forward, skip the hand-back so the app stays focused.
pub fn restore_foreground() {
    let cast_took_fg = CAST_FOREGROUND.swap(false, Ordering::Relaxed);
    let h = PREV_FOREGROUND.swap(0, Ordering::Relaxed);
    if cast_took_fg {
        return; // the cast's app owns the foreground now — leave it there
    }
    if let Some(t) = unjam_target(h) {
        unsafe {
            let _ = SetForegroundWindow(t);
        }
    }
}

/// Place a top-level window so it covers the monitor under the cursor (so the
/// casting slate appears where the user is, not centred across a monitor seam).
/// Falls back to the whole virtual desktop if the monitor can't be resolved.
pub fn cover_active_monitor(hwnd: HWND) {
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut mi).as_bool() {
            let r = mi.rcMonitor;
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        } else {
            cover_virtual_screen(hwnd);
        }
    }
}
