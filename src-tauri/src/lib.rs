#[cfg(windows)]
mod host;
#[cfg(windows)]
mod workerw;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Number of wallpaper windows declared in tauri.conf.json (labels
/// "wallpaper-0".."wallpaper-3"). We attach one per monitor, up to this many.
const MAX_WALLPAPER: usize = 4;

fn log(app: &AppHandle, msg: impl Into<String>) {
    let m = msg.into();
    println!("[lorraine] {m}");
    let _ = app.emit("log", m);
}

// ---------------------------------------------------------------------------
// Overlay (casting surface)
// ---------------------------------------------------------------------------

fn overlay_toggle(app: &AppHandle) {
    let Some(w) = app.get_webview_window("overlay") else {
        return;
    };
    let visible = w.is_visible().unwrap_or(false);
    if visible {
        let _ = w.hide();
        log(app, "overlay: hidden");
    } else {
        #[cfg(windows)]
        if let Ok(h) = w.hwnd() {
            workerw::cover_virtual_screen(h);
        }
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.show();
        let _ = w.set_focus();
        log(app, "overlay: shown");
    }
}

// ---------------------------------------------------------------------------
// Wallpaper windows (declared in config; attached to monitors here)
// ---------------------------------------------------------------------------

/// Whether each monitor's wallpaper controller is currently homed in its host.
#[cfg(windows)]
static ATTACHED: [std::sync::atomic::AtomicBool; MAX_WALLPAPER] =
    [const { std::sync::atomic::AtomicBool::new(false) }; MAX_WALLPAPER];

/// The native host HWND (as isize) for each monitor, or 0 if none. A non-zero
/// value that no longer refers to a live window means a host we created has died
/// (explorer restart) — the trigger to recreate that slot's webview.
#[cfg(windows)]
static HOSTS: [std::sync::atomic::AtomicIsize; MAX_WALLPAPER] =
    [const { std::sync::atomic::AtomicIsize::new(0) }; MAX_WALLPAPER];

/// Whether each monitor's wallpaper is currently paused (foreground fullscreen).
#[cfg(windows)]
static PAUSED: [std::sync::atomic::AtomicBool; MAX_WALLPAPER] =
    [const { std::sync::atomic::AtomicBool::new(false) }; MAX_WALLPAPER];

/// Power-saving option: when true, pause a monitor's wallpaper while a fullscreen
/// window covers it. **Default OFF** — resuming re-composites the WebView2, which
/// causes a brief flash, so out of the box we just keep rendering (the idle cost
/// of a hidden wallpaper is small). Opt-in via `set_pause_on_fullscreen` (e.g. on
/// a laptop). Wired to a Settings toggle in Phase 7.
#[cfg(windows)]
static PAUSE_ON_FULLSCREEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Incrementing generation for unique runtime wallpaper-window labels.
#[cfg(windows)]
static RECREATE_GEN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The current webview-window label per monitor slot. Starts as the config
/// windows (`wallpaper-0..3`); on recovery we create runtime replacements.
#[cfg(windows)]
fn slot_labels() -> &'static std::sync::Mutex<Vec<String>> {
    static L: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    L.get_or_init(|| {
        std::sync::Mutex::new((0..MAX_WALLPAPER).map(|i| format!("wallpaper-{i}")).collect())
    })
}

/// The monitor geometry `(x, y, w, h, dpi)` each slot's host was last placed for.
/// A mismatch vs the live monitor means a resolution/DPI change → rebuild the slot.
#[cfg(windows)]
fn slot_rects() -> &'static std::sync::Mutex<Vec<(i32, i32, i32, i32, u32)>> {
    static R: std::sync::OnceLock<std::sync::Mutex<Vec<(i32, i32, i32, i32, u32)>>> =
        std::sync::OnceLock::new();
    R.get_or_init(|| std::sync::Mutex::new(vec![(0, 0, 0, 0, 0); MAX_WALLPAPER]))
}

/// Move a wallpaper window's WebView2 controller into `host` and size it to fill
/// it. `with_webview` queues the closure until the webview is ready, so this is
/// safe to call right after creating a fresh window. Sets ATTACHED/EVER_ATTACHED
/// on success; the watchdog retries until it sticks.
#[cfg(windows)]
fn reparent_controller(
    app: &AppHandle,
    i: usize,
    label: &str,
    host: windows::Win32::Foundation::HWND,
    w_px: i32,
    h_px: i32,
) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let host_i = host.0 as isize;
    let _ = win.with_webview(move |pw| {
        use std::sync::atomic::Ordering;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Controller, ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
        };
        use windows::core::Interface;
        use windows::Win32::Foundation::{HWND, RECT};
        let controller: ICoreWebView2Controller = pw.controller();
        unsafe {
            // Dark default background (matches the wallpaper #0b0914) so any
            // pre-paint moment shows dark instead of a white flash.
            if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
                let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                    A: 255,
                    R: 0x0b,
                    G: 0x09,
                    B: 0x14,
                });
            }
            match controller.SetParentWindow(HWND(host_i as *mut core::ffi::c_void)) {
                Ok(()) => {
                    let _ = controller.SetBounds(RECT {
                        left: 0,
                        top: 0,
                        right: w_px,
                        bottom: h_px,
                    });
                    let _ = controller.SetIsVisible(true.into());
                    ATTACHED[i].store(true, Ordering::Relaxed);
                    // A fresh/re-homed controller starts visible; let the pause
                    // pass re-evaluate fullscreen occlusion from a known state.
                    PAUSED[i].store(false, Ordering::Relaxed);
                }
                Err(e) => {
                    // ERROR_INVALID_STATE here means the controller was invalidated
                    // by its host dying; ensure_attached will recreate the window.
                    println!("[lorraine] reparent {i}: SetParentWindow failed 0x{:08X}", e.code().0);
                }
            }
        }
    });
}

/// Recreate the webview window for a slot whose controller was invalidated by an
/// explorer restart. Closes the old (dead) window and builds a fresh runtime one
/// with a new unique label; its fresh controller is reparented by the caller.
#[cfg(windows)]
fn recreate_window(app: &AppHandle, i: usize, mon: &workerw::Monitor) {
    use std::sync::atomic::Ordering;
    let old = slot_labels().lock().unwrap()[i].clone();
    if let Some(w) = app.get_webview_window(&old) {
        let _ = w.close();
    }
    let gen = RECREATE_GEN.fetch_add(1, Ordering::Relaxed);
    let new_label = format!("wp-r{gen}-{i}");
    slot_labels().lock().unwrap()[i] = new_label.clone();
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        &new_label,
        tauri::WebviewUrl::App("wallpaper.html".into()),
    )
    .title("atelier-wallpaper")
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
    )
    .inner_size(mon.width.max(1) as f64, mon.height.max(1) as f64)
    .build();
    log(app, format!("wallpaper-{i}: recreated webview as {new_label}"));
}

/// Ensure each monitor has a live host with its wallpaper controller homed in it.
/// Runs at startup and from the watchdog.
///
/// Recovery model: a host we created that is now a dead window (explorer restart)
/// means its controller is permanently invalid (ERROR_INVALID_STATE). We detect
/// that purely from the host-handle transition — `HOSTS[i]` non-zero but no longer
/// a live window — recreate the webview ONCE, then clear `HOSTS[i]` so the next
/// pass cold-creates a fresh host and homes the fresh controller. Driving recovery
/// off the host handle (not a separate flag) is robust to rapid repeated restarts
/// and avoids any sync-clear/async-set race.
#[cfg(windows)]
fn ensure_attached(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HWND;

    let monitors = workerw::enum_monitors();
    let n = monitors.len().min(MAX_WALLPAPER);

    // Tear down hosts for slots whose monitor was unplugged (count decreased).
    for i in n..MAX_WALLPAPER {
        let h = HOSTS[i].swap(0, Ordering::Relaxed);
        if h != 0 {
            host::destroy_host(HWND(h as *mut core::ffi::c_void));
            ATTACHED[i].store(false, Ordering::Relaxed);
            slot_rects().lock().unwrap()[i] = (0, 0, 0, 0, 0);
            log(app, format!("wallpaper-{i}: monitor removed — host destroyed"));
        }
    }

    for i in 0..n {
        let Some(mon) = monitors.get(i) else { continue };
        let cur = (mon.x, mon.y, mon.width, mon.height, mon.dpi);

        let mut host_raw = HOSTS[i].load(Ordering::Relaxed);
        let mut host_alive =
            host_raw != 0 && workerw::is_window(HWND(host_raw as *mut core::ffi::c_void));
        let stored = slot_rects().lock().unwrap()[i];
        let attached = ATTACHED[i].load(Ordering::Relaxed);

        if host_alive && attached && stored == cur {
            continue; // healthy and correctly placed
        }

        // Two cases need a fresh webview (the controller is or would be invalid):
        //   - host died (explorer restart): its controller is permanently invalid.
        //   - display geometry/DPI changed while attached: cleanest handled by a
        //     fresh webview that picks up the new resolution/scale (a brief reload
        //     on a rare, deliberate action).
        let host_died = host_raw != 0 && !host_alive;
        let display_changed = host_alive && attached && stored != cur;

        if host_died || display_changed {
            if display_changed {
                log(app, format!("wallpaper-{i}: display changed {stored:?} -> {cur:?} — rebuilding"));
            }
            ATTACHED[i].store(false, Ordering::Relaxed);
            recreate_window(app, i, mon);
            if host_alive {
                host::destroy_host(HWND(host_raw as *mut core::ffi::c_void));
            }
            HOSTS[i].store(0, Ordering::Relaxed);
            host_raw = 0;
            host_alive = false;
        }

        let Some(worker) = workerw::cached_workerw() else {
            log(app, "ensure_attached: WorkerW not found yet");
            continue;
        };

        // Ensure a live host exists for this slot.
        let host = if host_alive {
            HWND(host_raw as *mut core::ffi::c_void)
        } else {
            let Some(h) = host::create_host(worker, mon) else {
                log(app, format!("wallpaper-{i}: host create failed"));
                continue;
            };
            HOSTS[i].store(h.0 as isize, Ordering::Relaxed);
            let (cw, ch) = host::client_size(h);
            log(
                app,
                format!(
                    "wallpaper-{i}: host created {}x{}@({},{}) dpi={} client={cw}x{ch}{}",
                    mon.width, mon.height, mon.x, mon.y, mon.dpi,
                    if cw == mon.width && ch == mon.height { " OK" } else { " MISMATCH" }
                ),
            );
            h
        };

        slot_rects().lock().unwrap()[i] = cur;
        let label = slot_labels().lock().unwrap()[i].clone();
        reparent_controller(app, i, &label, host, mon.width, mon.height);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.hide(); // the empty shell; the webview now lives in the host
        }
    }
}

/// Set a wallpaper window's WebView2 controller visibility — the native pause:
/// `SetIsVisible(false)` stops compositing and throttles the page's rAF, saving
/// CPU/GPU while a fullscreen app is foreground (the window is hidden behind it
/// anyway). No JS or capability changes needed.
#[cfg(windows)]
fn set_controller_visible(app: &AppHandle, label: &str, visible: bool) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let _ = win.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
        let controller: ICoreWebView2Controller = pw.controller();
        unsafe {
            let _ = controller.SetIsVisible(visible.into());
        }
    });
}

/// Pause the wallpaper on a monitor whose foreground window is fullscreen; resume
/// the others. Honors the KEEP_RUNNING override. (Releasing the shared WASAPI
/// capture when all monitors are paused hooks in here in Phase 6.)
#[cfg(windows)]
fn update_pause(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let monitors = workerw::enum_monitors();
    let n = monitors.len().min(MAX_WALLPAPER);
    let enabled = PAUSE_ON_FULLSCREEN.load(Ordering::Relaxed);
    for i in 0..n {
        // && short-circuits: when the option is off we never even probe.
        let want_paused = enabled && workerw::monitor_covered(&monitors[i]);
        if PAUSED[i].swap(want_paused, Ordering::Relaxed) != want_paused {
            let label = slot_labels().lock().unwrap()[i].clone();
            set_controller_visible(app, &label, !want_paused);
            log(
                app,
                format!(
                    "wallpaper-{i}: {}",
                    if want_paused {
                        "paused (covered by fullscreen)"
                    } else {
                        "resumed"
                    }
                ),
            );
        }
    }
}

#[cfg(windows)]
fn spawn_watchdog(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(600));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            ensure_attached(&app2);
            update_pause(&app2);
        });
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn reattach_wallpaper(app: AppHandle) -> String {
    #[cfg(windows)]
    {
        for f in ATTACHED.iter() {
            f.store(false, std::sync::atomic::Ordering::Relaxed);
        }
        ensure_attached(&app);
        return "reattach requested".into();
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        "noop (non-windows)".into()
    }
}

#[tauri::command]
fn detach_wallpaper(app: AppHandle) -> String {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering;
        use windows::Win32::Foundation::HWND;
        let _ = app;
        for i in 0..MAX_WALLPAPER {
            let host_raw = HOSTS[i].swap(0, Ordering::Relaxed);
            if host_raw != 0 {
                host::destroy_host(HWND(host_raw as *mut core::ffi::c_void));
            }
            ATTACHED[i].store(false, Ordering::Relaxed);
        }
        return "detached".into();
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        "noop (non-windows)".into()
    }
}

#[tauri::command]
fn toggle_overlay(app: AppHandle) {
    overlay_toggle(&app);
}

#[tauri::command]
fn get_status() -> String {
    #[cfg(windows)]
    {
        return format!("{} monitor(s) detected", workerw::enum_monitors().len());
    }
    #[cfg(not(windows))]
    "noop (non-windows)".into()
}

/// Power-saving toggle: pause a monitor's wallpaper while a fullscreen window
/// covers it. Default OFF. (Wired to a Settings toggle in Phase 7.)
#[tauri::command]
fn set_pause_on_fullscreen(enabled: bool) -> String {
    #[cfg(windows)]
    {
        PAUSE_ON_FULLSCREEN.store(enabled, std::sync::atomic::Ordering::Relaxed);
        return format!("pause_on_fullscreen={enabled}");
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        "noop (non-windows)".into()
    }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let inscribe = MenuItem::with_id(app, "inscribe", "Inscribe (overlay)", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show control", true, None::<&str>)?;
    let reattach = MenuItem::with_id(app, "reattach", "Re-attach wallpaper", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&inscribe, &show, &reattach, &quit])?;

    let mut builder = TrayIconBuilder::with_id("lorraine-tray")
        .tooltip("Lorraine Atelier")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "inscribe" => overlay_toggle(app),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "reattach" => {
                #[cfg(windows)]
                ensure_attached(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Occlusion-disable is handled per-window via additionalBrowserArgs in
    // tauri.conf.json (identical on every window so they share one WebView2
    // environment — differing args split the environment and break window
    // creation).
    #[cfg(windows)]
    workerw::set_dpi_awareness();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        overlay_toggle(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            reattach_wallpaper,
            detach_wallpaper,
            toggle_overlay,
            get_status,
            set_pause_on_fullscreen
        ])
        .on_window_event(|window, event| {
            // Closing the control window hides it to the tray; the wallpaper and
            // tray keep running. "Quit" in the tray exits for real.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = setup_tray(app) {
                log(&handle, format!("tray setup failed: {e}"));
            }

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyW);
            match app.global_shortcut().register(shortcut) {
                Ok(_) => log(&handle, "hotkey Ctrl+Alt+W registered"),
                Err(e) => log(&handle, format!("hotkey register failed: {e}")),
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lorraine Atelier")
        .run(|_handle, _event| {
            // Attach the wallpaper windows once the event loop is running.
            #[cfg(windows)]
            if let tauri::RunEvent::Ready = _event {
                ensure_attached(_handle);
                spawn_watchdog(_handle.clone());
            }
        });
}
