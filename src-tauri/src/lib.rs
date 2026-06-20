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

/// Whether each wallpaper window is currently attached. We track this in Rust
/// rather than via GetParent, because GetParent cannot read our window's
/// cross-process WorkerW parent (it returns null), which would otherwise make
/// us re-attach every tick.
#[cfg(windows)]
static ATTACHED: [std::sync::atomic::AtomicBool; MAX_WALLPAPER] =
    [const { std::sync::atomic::AtomicBool::new(false) }; MAX_WALLPAPER];

/// Attach one wallpaper window per monitor under WorkerW (each once). Also the
/// watchdog path: detects when an explorer restart has destroyed a window.
#[cfg(windows)]
fn ensure_attached(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let monitors = workerw::enum_monitors();
    let n = monitors.len().min(MAX_WALLPAPER);

    for i in 0..n {
        let Some(w) = app.get_webview_window(&format!("wallpaper-{i}")) else {
            continue;
        };
        let Ok(h) = w.hwnd() else { continue };

        if !workerw::is_window(h) {
            // Explorer restart destroys the WorkerW and, with it, our child
            // wallpaper windows. Recreating a config webview window at runtime
            // isn't wired yet (see docs/SLICE1_NOTES) — mark detached so we
            // don't spin, and surface it.
            if ATTACHED[i].swap(false, Ordering::Relaxed) {
                log(app, format!("wallpaper-{i}: destroyed (explorer restart?) — recreation TODO"));
            }
            continue;
        }

        if ATTACHED[i].load(Ordering::Relaxed) {
            continue; // already attached
        }

        if let Some(mon) = monitors.get(i) {
            let worker = workerw::cached_workerw();
            let ok = workerw::attach(h, worker, mon);
            let _ = w.show();
            if ok {
                ATTACHED[i].store(true, Ordering::Relaxed);
            }
            log(
                app,
                format!(
                    "wallpaper-{i}: attach={ok} {}x{}@({},{}) dpi={}",
                    mon.width, mon.height, mon.x, mon.y, mon.dpi
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
        for i in 0..MAX_WALLPAPER {
            if let Some(w) = app.get_webview_window(&format!("wallpaper-{i}")) {
                if let Ok(h) = w.hwnd() {
                    workerw::detach(h);
                    let _ = w.hide();
                }
            }
            ATTACHED[i].store(false, std::sync::atomic::Ordering::Relaxed);
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
