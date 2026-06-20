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
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
        use windows::Win32::Foundation::{HWND, RECT};
        let controller: ICoreWebView2Controller = pw.controller();
        unsafe {
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

    for i in 0..n {
        let host_raw = HOSTS[i].load(Ordering::Relaxed);
        let host_alive =
            host_raw != 0 && workerw::is_window(HWND(host_raw as *mut core::ffi::c_void));

        if host_alive && ATTACHED[i].load(Ordering::Relaxed) {
            continue; // healthy
        }

        let Some(mon) = monitors.get(i) else { continue };

        // A host we created has died → its controller is invalid. Recreate the
        // webview once, then drop the handle so the cold-create path runs below.
        if host_raw != 0 && !host_alive {
            ATTACHED[i].store(false, Ordering::Relaxed);
            recreate_window(app, i, mon);
            HOSTS[i].store(0, Ordering::Relaxed);
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
            log(
                app,
                format!(
                    "wallpaper-{i}: host created {}x{}@({},{}) dpi={}",
                    mon.width, mon.height, mon.x, mon.y, mon.dpi
                ),
            );
            h
        };

        let label = slot_labels().lock().unwrap()[i].clone();
        reparent_controller(app, i, &label, host, mon.width, mon.height);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.hide(); // the empty shell; the webview now lives in the host
        }
    }
}

#[cfg(windows)]
fn spawn_watchdog(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(600));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || ensure_attached(&app2));
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
            get_status
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
