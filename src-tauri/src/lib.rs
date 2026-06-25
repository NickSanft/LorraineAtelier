#[cfg(windows)]
mod host;
#[cfg(windows)]
mod workerw;
/// Desktop-layer interactivity (global low-level mouse hook): clickable pills/cast
/// + draggable buddy, gated so app windows always keep priority.
#[cfg(windows)]
mod hook;

/// Pure stroke recognizer (no platform deps) — public so the golden-corpus parity
/// integration test can exercise it. See `tests/recognizer_parity.rs`.
pub mod recognizer;

/// Casting IPC (recognition wrappers + the atomic `fire_spell`) and the launch
/// targets it resolves. Platform-agnostic; the launch impl is Windows-gated.
mod casting;
mod launcher;

/// WASAPI loopback audio capture for the "Attune to your music" visualizer.
#[cfg(windows)]
mod audio;

/// Persisted settings (day/night mode, spell bindings, pause) for the control UI.
mod settings;

/// Run-at-startup: we own the HKCU Run key write (quoted path) rather than the
/// auto-launch crate, which writes it unquoted and breaks on the install path's space.
mod autostart;
#[cfg(windows)]
mod power;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// True when this process was launched at login (the autostart Run key appends
/// `--minimized`). Such launches boot straight to the tray instead of showing
/// the control window.
fn launched_minimized() -> bool {
    std::env::args().any(|a| a == "--minimized")
}

/// Apply the persisted `run_at_startup` preference to the OS Run key. The setting
/// is the source of truth, so a manually-removed Run key (or a fresh install) is
/// brought back into line. Only acts when they disagree.
fn sync_autostart() {
    let want = settings::get().run_at_startup;
    if autostart::is_enabled() != want {
        let _ = if want { autostart::enable() } else { autostart::disable() };
    }
}

/// Append a breadcrumb to the CWD-independent startup log
/// (`%APPDATA%\com.divora.lorraineatelier\startup.log`). A logon launch can't be
/// watched live, so this trail shows how far startup got before any silent exit
/// (e.g. a non-fatal WebView2 failure that hides the only window and tears down).
fn log_startup(msg: &str) {
    let Some(appdata) = std::env::var_os("APPDATA") else { return };
    let dir = std::path::PathBuf::from(appdata).join("com.divora.lorraineatelier");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("startup.log");
    // Keep it bounded — start fresh once it grows past 64 KiB.
    if std::fs::metadata(&path).map(|m| m.len() > 64 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{secs} {msg}");
    }
}

/// Append a bounded crash/diagnostic breadcrumb to crash.log (local only, no
/// telemetry). Written by the panic hook and the per-tick `guard`s so an unattended
/// failure on the recipient's machine leaves a clue — without ever taking the
/// wallpaper down. Crash-resilience (Phase 13.4).
fn log_crash(msg: &str) {
    let Some(appdata) = std::env::var_os("APPDATA") else { return };
    let dir = std::path::PathBuf::from(appdata).join("com.divora.lorraineatelier");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("crash.log");
    if std::fs::metadata(&path).map(|m| m.len() > 64 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{secs} {msg}");
    }
}

/// Run `f`, catching any panic so one bad tick can't take the app (or its recovery
/// loop) down — the loop just continues next tick. The panic hook records the
/// message/location; this records which guarded section recovered.
fn guard<F: FnOnce()>(name: &str, f: F) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        log_crash(&format!("recovered from a panic in '{name}'"));
    }
}
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

/// The overlay is ALWAYS shown (a top-most, click-through interactive layer).
/// The casting overlay is hidden at rest and shown only here, as a focusable modal.
/// "Toggling" opens (show + focus the active monitor) or closes (hide + return the
/// user's prior foreground) the slate.
fn overlay_toggle(app: &AppHandle) {
    #[cfg(windows)]
    {
        if workerw::overlay_casting() {
            close_casting_impl(app);
        } else {
            open_casting_impl(app);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(windows)]
fn open_casting_impl(app: &AppHandle) {
    // Remember the user's current window BEFORE we take focus, so we can give it
    // back when casting ends.
    workerw::snapshot_foreground();
    workerw::set_overlay_casting(true);
    if let Some(w) = app.get_webview_window("overlay") {
        if let Ok(h) = w.hwnd() {
            workerw::cover_active_monitor(h); // size to the monitor under the cursor
        }
        let _ = w.show();
        let _ = w.set_focus(); // normal modal activation (mouse + Escape reach the slate)
    }
    let _ = app.emit("overlay:mode", "casting");
}

/// Open casting from a desktop cast-glyph click (no-op if already casting).
#[cfg(windows)]
pub(crate) fn hook_cast(app: &AppHandle) {
    if !workerw::overlay_casting() {
        open_casting_impl(app);
    }
}

/// Toggle day/night from the dock's mode indicator (emits settings:mode, so the
/// wallpaper transitions and the control panel/tray stay in sync).
#[cfg(windows)]
pub(crate) fn hook_toggle_mode(app: &AppHandle) {
    let next = if settings::get().mode == "day" { "night" } else { "day" };
    settings::set_mode(app, next.to_string());
}

/// Toggle "Attune to music" from the seal's pill (mirrors the tray arm; audio
/// start/stop emits viz:source-changed, updating the pill and control panel).
#[cfg(windows)]
pub(crate) fn hook_toggle_attune(app: &AppHandle) {
    if audio::is_capturing() {
        audio::stop();
    } else {
        audio::start(app.clone());
    }
}

/// Open the Tower of Tomes from the dock's ❧ button: show the control window and
/// tell it to surface the spellbook panel.
#[cfg(windows)]
pub(crate) fn hook_open_tomes(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("open:tomes", ());
}

#[cfg(windows)]
fn close_casting_impl(app: &AppHandle) {
    // Hiding the window is what truly releases the foreground — a hidden window can
    // never hold it. restore_foreground then returns the user to their prior app.
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
    workerw::restore_foreground();
    workerw::set_overlay_casting(false);
    let _ = app.emit("overlay:mode", "idle");
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

/// Set by a resume-from-sleep to force the next `ensure_attached` to rebuild EVERY
/// attached slot (not just dead/moved ones) — a suspended controller can come back
/// blank while its host window is still alive, which the handle-driven watchdog can't
/// detect. Cleared (swapped false) when consumed.
#[cfg(windows)]
static FORCE_REATTACH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

/// The live monitor list, refreshed each `ensure_attached` pass. The brushbuddy
/// thread reads this to roam in virtual-desktop coordinates and to know which
/// monitor is primary (full widgets) vs secondary (calm art only).
#[cfg(windows)]
fn monitors_store() -> &'static std::sync::Mutex<Vec<workerw::Monitor>> {
    static M: std::sync::OnceLock<std::sync::Mutex<Vec<workerw::Monitor>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

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
    let old = slot_labels().lock().unwrap_or_else(|e| e.into_inner())[i].clone();
    if let Some(w) = app.get_webview_window(&old) {
        let _ = w.close();
    }
    let gen = RECREATE_GEN.fetch_add(1, Ordering::Relaxed);
    let new_label = format!("wp-r{gen}-{i}");
    slot_labels().lock().unwrap_or_else(|e| e.into_inner())[i] = new_label.clone();
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
    // Publish the (capped) monitor list for the brushbuddy thread.
    *monitors_store().lock().unwrap_or_else(|e| e.into_inner()) = monitors[..n].to_vec();

    // A resume-from-sleep forces every attached slot to rebuild (a suspended
    // controller can return blank under a still-live host). Consume the flag once.
    let forced = FORCE_REATTACH.swap(false, Ordering::Relaxed);

    // Tear down hosts for slots whose monitor was unplugged (count decreased).
    for i in n..MAX_WALLPAPER {
        let h = HOSTS[i].swap(0, Ordering::Relaxed);
        if h != 0 {
            host::destroy_host(HWND(h as *mut core::ffi::c_void));
            ATTACHED[i].store(false, Ordering::Relaxed);
            slot_rects().lock().unwrap_or_else(|e| e.into_inner())[i] = (0, 0, 0, 0, 0);
            log(app, format!("wallpaper-{i}: monitor removed — host destroyed"));
        }
    }

    for i in 0..n {
        let Some(mon) = monitors.get(i) else { continue };
        let cur = (mon.x, mon.y, mon.width, mon.height, mon.dpi);

        let mut host_raw = HOSTS[i].load(Ordering::Relaxed);
        let mut host_alive =
            host_raw != 0 && workerw::is_window(HWND(host_raw as *mut core::ffi::c_void));
        let stored = slot_rects().lock().unwrap_or_else(|e| e.into_inner())[i];
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
        let display_changed = host_alive && attached && (stored != cur || forced);

        if host_died || display_changed {
            if display_changed {
                let reason = if forced && stored == cur {
                    "forced re-attach (resume)".to_string()
                } else {
                    format!("display changed {stored:?} -> {cur:?}")
                };
                log(app, format!("wallpaper-{i}: {reason} — rebuilding"));
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

        slot_rects().lock().unwrap_or_else(|e| e.into_inner())[i] = cur;
        let label = slot_labels().lock().unwrap_or_else(|e| e.into_inner())[i].clone();
        reparent_controller(app, i, &label, host, mon.width, mon.height);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.hide(); // the empty shell; the webview now lives in the host
        }
    }

    // If a cast is in progress, the monitor the overlay was covering may have just been
    // unplugged — re-anchor it to a still-live monitor so it can't be orphaned off-screen
    // (or left spanning two displays) with no way to dismiss it.
    if workerw::overlay_casting() {
        if let Some(w) = app.get_webview_window("overlay") {
            if let Ok(h) = w.hwnd() {
                workerw::cover_active_monitor(h);
            }
            let _ = w.set_focus();
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
            let label = slot_labels().lock().unwrap_or_else(|e| e.into_inner())[i].clone();
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
            guard("watchdog", || {
                ensure_attached(&app2);
                update_pause(&app2);
            });
        });
    });
}

/// Resume from sleep/hibernate (from `power.rs`, on the main thread): force a full
/// re-attach so the wallpaper is guaranteed clean even if a controller came back
/// blank under a still-live host while suspended.
#[cfg(windows)]
pub(crate) fn power_resume(app: &AppHandle) {
    FORCE_REATTACH.store(true, std::sync::atomic::Ordering::Relaxed);
    ensure_attached(app);
    update_pause(app);
    log(app, "power: resume — forced re-attach");
    log_startup("power: resume — forced re-attach"); // persisted breadcrumb
}

/// Session became active again — unlock / logon (from `power.rs`, on the main
/// thread): a normal validation pass that recreates any host that died while locked
/// but leaves healthy controllers untouched (no reload on routine unlocks).
#[cfg(windows)]
pub(crate) fn power_session_active(app: &AppHandle) {
    ensure_attached(app);
    update_pause(app);
    log(app, "power: session active — validated");
    log_startup("power: session active — validated"); // persisted breadcrumb
}

/// In-world nudge that teaches drawing-to-cast (Phase 13.2): a dip-pen traces a sigil
/// on the primary wallpaper with the line "Magic is not spoken here — it is drawn."
/// Gated so it never nags — never once she has cast anything (the `discovered` map is
/// non-empty), and at most a few times total — then never again.
#[cfg(windows)]
fn maybe_show_cast_hint(app: &AppHandle) {
    const SHOW_LIMIT: u32 = 3;
    let s = settings::get();
    if !s.discovered.is_empty() || s.cast_hint_shown >= SHOW_LIMIT {
        return;
    }
    settings::set_cast_hint_shown(s.cast_hint_shown + 1);
    let _ = app.emit("gift:casthint", ());
    log(app, format!("cast-hint shown ({}/{SHOW_LIMIT})", s.cast_hint_shown + 1));
}

// ---------------------------------------------------------------------------
// The gift: secret storybook surfacing + birthday auto-bloom
// ---------------------------------------------------------------------------

/// Show the casting overlay carrying the storybook (used by the birthday auto-bloom
/// and the "Preview dedication" button): position + show + focus the overlay, emit
/// `gift:birthday` so it swaps to the storybook view, and `gift:bloom` for a
/// celebratory wallpaper bloom on every monitor.
fn surface_storybook(app: &AppHandle) {
    #[cfg(windows)]
    open_casting_impl(app); // make the overlay interactive on the active monitor
    let _ = app.emit("gift:birthday", ()); // overlay swaps to the storybook view
    let _ = app.emit("gift:bloom", ());
}

#[cfg(windows)]
fn local_ymd() -> (i32, u16, u16, u16) {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let st = unsafe { GetLocalTime() };
    (st.wYear as i32, st.wMonth, st.wDay, st.wDayOfWeek) // wDayOfWeek: 0=Sun..6=Sat
}

/// Surface the dedication once on the configured birthday (local time), guarded by
/// `lastBirthdayYear` so it fires at most once per year.
fn check_birthday(app: &AppHandle) {
    let gift = settings::get().gift;
    if gift.birthday.trim().is_empty() {
        return;
    }
    #[cfg(windows)]
    {
        let (year, m, d, _wd) = local_ymd();
        let today = format!("{m:02}-{d:02}");
        if today == gift.birthday && settings::get().last_birthday_year != year {
            settings::set_last_birthday_year(year);
            settings::set_secret_found(true);
            log(app, "birthday: surfacing the Hidden Page");
            surface_storybook(app);
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Surface the Silver-Eve festival (the Night of the Falling Stars) once on the
/// configured date (local time), guarded by `lastSilvereveYear` so it fires at most
/// once per year. Cosmetic — a drift of gold/silver star-motes on every monitor.
#[cfg(windows)]
fn check_silvereve(app: &AppHandle) {
    let eve = settings::get().gift.silver_eve;
    let eve = eve.trim();
    if eve.is_empty() {
        return;
    }
    let (year, m, d, wd) = local_ymd();
    // "weekends": a recurring festival every Sat/Sun, guarded per-day (wDayOfWeek
    // 0=Sun, 6=Sat) so it fires once each weekend day rather than once per year.
    if eve.eq_ignore_ascii_case("weekends") {
        if wd == 0 || wd == 6 {
            let today = format!("{year:04}-{m:02}-{d:02}");
            if settings::get().last_silvereve_day != today {
                settings::set_last_silvereve_day(today);
                log(app, "silver-eve: the falling stars (weekend)");
                let _ = app.emit("gift:festival", ());
            }
        }
        return;
    }
    // Otherwise an annual "MM-DD" date, guarded once per year.
    let today = format!("{m:02}-{d:02}");
    if today == eve && settings::get().last_silvereve_year != year {
        settings::set_last_silvereve_year(year);
        log(app, "silver-eve: the falling stars");
        let _ = app.emit("gift:festival", ());
    }
}

fn spawn_birthday_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            guard("birthday-watch", || {
                check_birthday(&a);
                #[cfg(windows)]
                check_silvereve(&a);
            });
        });
        std::thread::sleep(std::time::Duration::from_secs(60));
    });
}

// ---------------------------------------------------------------------------
// Brushbuddy — a single ink companion that roams ACROSS all monitors.
// ---------------------------------------------------------------------------
//
// The buddy lives in virtual-desktop coordinates (the same physical-pixel space
// the monitors are placed in). One thread ticks a gentle wander state machine
// ~30 Hz and, for each monitor's wallpaper webview, emits a `buddy` event with
// the buddy's position in THAT window's local coordinates. The buddy is only
// `visible` on the monitor whose horizontal range currently contains it (its
// "owner"), so it appears to walk off the edge of one screen and onto the next.
// Its y eases toward the owner monitor's ground line, so crossing a seam between
// vertically-offset monitors makes it rise/dip into place.

/// Payload pushed to each wallpaper webview ~30 Hz. Coordinates are the buddy's
/// CENTER in that window's local pixels; the frontend offsets by the sprite half-
/// size and applies its own ui-scale.
#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuddyMsg {
    /// Destination webview label. Tauri 2.11's `EventTarget::Any` listeners bypass
    /// `emit_to` label filtering (every webview sees every emit), so the frontend
    /// also filters on this — it acts only on the message addressed to its label.
    label: String,
    x: f64,
    y: f64,
    visible: bool,
    flip: f64,
    eye: f64,
    primary: bool,
    held: bool, // currently being dragged → frontend shows a "picked up" effect
    // Taskbar/appbar safe-area insets for this monitor, in physical px. The
    // frontend insets the whole scene into the work area so the dock/widgets/art
    // sit above a space-reserving taskbar (0 when it auto-hides).
    inset_top: f64,
    inset_bottom: f64,
    inset_left: f64,
    inset_right: f64,
}

/// Tiny xorshift64* PRNG — avoids pulling in the `rand` crate just for a wander.
#[cfg(windows)]
struct Rng(u64);
#[cfg(windows)]
impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.unit() * (hi - lo)
    }
}

/// Index of the monitor whose horizontal range contains `x`; if `x` is in a gap,
/// the horizontally-nearest monitor.
#[cfg(windows)]
fn owner_index(mons: &[workerw::Monitor], x: f64) -> usize {
    for (i, m) in mons.iter().enumerate() {
        if x >= m.x as f64 && x < (m.x + m.width) as f64 {
            return i;
        }
    }
    let mut best = 0usize;
    let mut best_d = f64::MAX;
    for (i, m) in mons.iter().enumerate() {
        let cx = m.x as f64 + m.width as f64 * 0.5;
        let d = (cx - x).abs();
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

/// Shared brushbuddy state so the mouse hook can drag it while `spawn_buddy` owns
/// the wander. All in virtual-desktop physical px. `spawn_buddy` writes X/Y while
/// roaming and reads them while DRAGGING; the hook writes them during a drag.
#[cfg(windows)]
mod buddy {
    use std::sync::atomic::{AtomicBool, AtomicI64};
    pub static X: AtomicI64 = AtomicI64::new(0); // center
    pub static Y: AtomicI64 = AtomicI64::new(0);
    pub static HW: AtomicI64 = AtomicI64::new(24); // half-width (scaled sprite)
    pub static HH: AtomicI64 = AtomicI64::new(21); // half-height
    pub static VISIBLE: AtomicBool = AtomicBool::new(false);
    pub static DRAGGING: AtomicBool = AtomicBool::new(false);
    pub static GRAB_DX: AtomicI64 = AtomicI64::new(0); // cursor−center at grab
    pub static GRAB_DY: AtomicI64 = AtomicI64::new(0);
    // Virtual-screen union bounds, cached at grab, to clamp the drop point.
    pub static VX0: AtomicI64 = AtomicI64::new(-100_000);
    pub static VY0: AtomicI64 = AtomicI64::new(-100_000);
    pub static VX1: AtomicI64 = AtomicI64::new(100_000);
    pub static VY1: AtomicI64 = AtomicI64::new(100_000);
}

/// Is this screen point on the buddy sprite? (hot-path cheap: atomics only)
#[cfg(windows)]
pub(crate) fn buddy_hit_test(mx: i32, my: i32) -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    if !buddy::VISIBLE.load(Relaxed) {
        return false;
    }
    let (x, y) = (buddy::X.load(Relaxed), buddy::Y.load(Relaxed));
    let (hw, hh) = (buddy::HW.load(Relaxed), buddy::HH.load(Relaxed));
    let (mx, my) = (mx as i64, my as i64);
    mx >= x - hw && mx <= x + hw && my >= y - hh && my <= y + hh
}

/// Begin a drag: record the grab offset and cache clamp bounds.
#[cfg(windows)]
pub(crate) fn buddy_begin_drag(mx: i32, my: i32) {
    use std::sync::atomic::Ordering::Relaxed;
    buddy::GRAB_DX.store(mx as i64 - buddy::X.load(Relaxed), Relaxed);
    buddy::GRAB_DY.store(my as i64 - buddy::Y.load(Relaxed), Relaxed);
    let mons = monitors_store().lock().unwrap_or_else(|e| e.into_inner());
    if !mons.is_empty() {
        buddy::VX0.store(mons.iter().map(|m| m.x).min().unwrap() as i64, Relaxed);
        buddy::VY0.store(mons.iter().map(|m| m.y).min().unwrap() as i64, Relaxed);
        buddy::VX1.store(mons.iter().map(|m| m.x + m.width).max().unwrap() as i64, Relaxed);
        buddy::VY1.store(mons.iter().map(|m| m.y + m.height).max().unwrap() as i64, Relaxed);
    }
    buddy::DRAGGING.store(true, Relaxed);
}

/// Move the buddy to follow the cursor (preserving the grab offset), clamped to the
/// virtual screen so it can never be lost off-edge.
#[cfg(windows)]
pub(crate) fn buddy_drag_to(mx: i32, my: i32) {
    use std::sync::atomic::Ordering::Relaxed;
    let (hw, hh) = (buddy::HW.load(Relaxed), buddy::HH.load(Relaxed));
    let x = (mx as i64 - buddy::GRAB_DX.load(Relaxed))
        .clamp(buddy::VX0.load(Relaxed) + hw, buddy::VX1.load(Relaxed) - hw);
    let y = (my as i64 - buddy::GRAB_DY.load(Relaxed))
        .clamp(buddy::VY0.load(Relaxed) + hh, buddy::VY1.load(Relaxed) - hh);
    buddy::X.store(x, Relaxed);
    buddy::Y.store(y, Relaxed);
}

#[cfg(windows)]
pub(crate) fn buddy_dragging() -> bool {
    buddy::DRAGGING.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(windows)]
pub(crate) fn buddy_release() {
    buddy::DRAGGING.store(false, std::sync::atomic::Ordering::Relaxed);
}

/// Persist the dropped position (does file I/O — call from the consumer, NOT the
/// hook proc).
#[cfg(windows)]
pub(crate) fn buddy_persist() {
    use std::sync::atomic::Ordering::Relaxed;
    settings::set_buddy_pos(buddy::X.load(Relaxed) as f64, buddy::Y.load(Relaxed) as f64);
}

#[cfg(windows)]
fn spawn_buddy(app: AppHandle) {
    std::thread::spawn(move || {
        const TICK_MS: u64 = 33; // ~30 Hz
        const GROUND: f64 = 112.0; // px above a monitor's bottom the buddy walks
        const SPEED: f64 = 3.4; // px/tick while walking
        const ARRIVE: f64 = 6.0; // distance to target that counts as "arrived"
        const Y_LERP: f64 = 0.11; // vertical ease toward the walk line (seam rise)
        const MIN_ABOVE: f64 = 30.0; // keep the buddy at least this far above the bottom
        const TWO_PI: f64 = std::f64::consts::PI * 2.0;

        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15)
            | 1;
        let mut rng = Rng(seed);

        // Buddy state (virtual-desktop coords).
        let mut x = 0.0f64;
        let mut y = 0.0f64;
        let mut tx = 0.0f64;
        let mut flip = 1.0f64;
        let mut rest = 0i32; // ticks remaining at rest (0 = walking)
        let mut napping = false;
        let mut eye = 1.0f64;
        let mut blink = 0i32;
        let mut bob = 0.0f64;
        let mut started = false;
        let mut drag_ticks = 0i32; // backstop against a stuck drag (missed button-up)
        // The line the buddy walks along, as distance ABOVE the work-area bottom.
        // Default = the floor; a drop sets it to the dropped height so the buddy
        // stays where you put it (and keeps that height across monitor seams).
        let mut walk_above = GROUND;
        let mut was_dragging = false;
        // In "primary only" mode the buddy stays on the primary and we stream its
        // position only there, so secondaries produce no damage and stay static.
        let mut last_owner: Option<usize> = None;
        let mut last_roam: Option<bool> = None;
        use std::sync::atomic::Ordering::Relaxed;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));

            let mons = monitors_store().lock().unwrap_or_else(|e| e.into_inner()).clone();
            let n = mons.len();
            if n == 0 {
                started = false;
                continue;
            }
            let s = settings::get();
            let primary_only = s.primary_only;
            // The fudemushi only roams once it has HATCHED (the first-ever cast set
            // buddy_revealed) AND the buddy is enabled. Existing installs auto-reveal
            // via a non-empty `discovered`, so an upgrade never makes it vanish.
            let roam = s.buddy_enabled && (s.buddy_revealed || !s.discovered.is_empty());
            let prim = mons.iter().position(|m| m.primary).unwrap_or(0);

            if !started {
                // Restore the dropped position if the buddy was ever placed; else
                // start at the primary monitor's centre.
                let s = settings::get();
                if s.buddy_placed {
                    x = s.buddy_x;
                    y = s.buddy_y;
                } else {
                    let p = mons.iter().find(|m| m.primary).unwrap_or(&mons[0]);
                    x = p.x as f64 + p.width as f64 * 0.5;
                    y = (p.y + p.height) as f64 - GROUND;
                }
                tx = x;
                rest = 40;
                started = true;
                // Adopt the seeded height as the walk line (so a restored placement
                // keeps its height instead of snapping to the floor).
                let om = mons[owner_index(&mons, x)];
                walk_above = ((om.work_y + om.work_h) as f64 - y)
                    .clamp(MIN_ABOVE, om.work_h as f64 - MIN_ABOVE);
                buddy::X.store(x.round() as i64, Relaxed);
                buddy::Y.store(y.round() as i64, Relaxed);
            }

            let dragging = buddy::DRAGGING.load(Relaxed);
            // Backstop: if a "drag" somehow runs far longer than any real one (a
            // button-up the hook never saw), force-release so it can't get stuck to
            // the cursor and swallow mouse-moves. ~15 s at 30 Hz.
            if dragging {
                drag_ticks += 1;
                if drag_ticks > 450 {
                    buddy::DRAGGING.store(false, Relaxed);
                    settings::set_buddy_pos(x, y);
                    drag_ticks = 0;
                }
            } else {
                drag_ticks = 0;
            }
            let dragging = buddy::DRAGGING.load(Relaxed);
            // On release, adopt the dropped height as the new walk line so the buddy
            // stays where you put it (vertically too) rather than gliding to the floor.
            if was_dragging && !dragging {
                x = buddy::X.load(Relaxed) as f64;
                y = buddy::Y.load(Relaxed) as f64;
                let om = mons[owner_index(&mons, x)];
                walk_above = ((om.work_y + om.work_h) as f64 - y)
                    .clamp(MIN_ABOVE, om.work_h as f64 - MIN_ABOVE);
                tx = x;
            }
            was_dragging = dragging;

            if dragging {
                // The hook owns the position while dragging; follow it, no wander.
                x = buddy::X.load(Relaxed) as f64;
                y = buddy::Y.load(Relaxed) as f64;
                tx = x;
                napping = false;
            } else {
                let owner = owner_index(&mons, x);
                let om = mons[owner];
                // Walk along the buddy's current height line (the floor by default,
                // or wherever it was last dropped), kept above a pinned taskbar.
                let ground = (om.work_y + om.work_h) as f64 - walk_above;

                if rest > 0 {
                    rest -= 1;
                    if rest == 0 {
                        napping = false;
                    }
                } else {
                    let dx = tx - x;
                    if dx.abs() <= ARRIVE {
                        // Arrived: rest (sometimes a longer nap), then a new target.
                        if rng.unit() < 0.26 {
                            napping = true;
                            rest = rng.range(90.0, 220.0) as i32; // ~3–7 s nap
                        } else {
                            rest = rng.range(18.0, 70.0) as i32; // brief pause
                        }
                        // Primary-only: never leave the primary (secondaries stay static).
                        // Otherwise 45% of the time aim for a DIFFERENT monitor → cross the seam.
                        let tgt = if primary_only {
                            mons[prim]
                        } else if n > 1 && rng.unit() < 0.45 {
                            let mut k = (rng.unit() * n as f64) as usize % n;
                            if k == owner {
                                k = (owner + 1) % n;
                            }
                            mons[k]
                        } else {
                            om
                        };
                        let margin = (tgt.width as f64 * 0.10).min(120.0);
                        tx = tgt.x as f64 + rng.range(margin, tgt.width as f64 - margin);
                    } else {
                        x += SPEED.min(dx.abs()) * dx.signum();
                        flip = if dx >= 0.0 { 1.0 } else { -1.0 };
                        bob = (bob + 0.34) % TWO_PI;
                    }
                }

                // Ease y toward the owner monitor's ground (seam rise/dip).
                y += (ground - y) * Y_LERP;
                buddy::X.store(x.round() as i64, Relaxed);
                buddy::Y.store(y.round() as i64, Relaxed);
            }

            // Publish the sprite half-size (scaled like the frontend's --ui-scale)
            // and that the buddy exists, so the hook can hit-test it.
            let owner = owner_index(&mons, x);
            let om = mons[owner];
            let scale = (om.height as f64 / 960.0).clamp(1.0, 2.2);
            buddy::HW.store((24.0 * scale).round() as i64, Relaxed);
            buddy::HH.store((21.0 * scale).round() as i64, Relaxed);
            buddy::VISIBLE.store(roam, Relaxed);

            // Eyes: closed while napping; otherwise the occasional blink.
            let eye_target = if napping {
                0.12
            } else if blink > 0 {
                blink -= 1;
                if blink > 0 { 0.1 } else { 1.0 }
            } else {
                if rng.unit() < 0.012 {
                    blink = 6; // ~0.2 s blink
                }
                1.0
            };
            eye += (eye_target - eye) * 0.4;

            let bob_off = if dragging || rest != 0 { 0.0 } else { bob.sin() * 1.6 };

            let labels = slot_labels().lock().unwrap_or_else(|e| e.into_inner()).clone();
            // Per-frame stream goes to every monitor only when the buddy is enabled AND
            // roaming all monitors. Otherwise (primary-only, or buddy off) we emit to all
            // monitors just on a structural change — owner moved, or the buddy was
            // toggled — so they learn primary/insets and show/hide the buddy; and we
            // stream per-frame to the owner only while the buddy is enabled.
            let structural = Some(owner) != last_owner || Some(roam) != last_roam;
            let emit_all = (roam && !primary_only) || structural;
            for i in 0..n {
                let send = if emit_all { true } else if i == owner { roam } else { false };
                if !send {
                    continue;
                }
                let Some(label) = labels.get(i) else { continue };
                let m = mons[i];
                let msg = BuddyMsg {
                    label: label.clone(),
                    x: x - m.x as f64,
                    y: y - m.y as f64 + bob_off,
                    visible: roam && i == owner,
                    flip,
                    eye,
                    primary: m.primary,
                    held: dragging,
                    inset_top: (m.work_y - m.y) as f64,
                    inset_bottom: ((m.y + m.height) - (m.work_y + m.work_h)) as f64,
                    inset_left: (m.work_x - m.x) as f64,
                    inset_right: ((m.x + m.width) - (m.work_x + m.work_w)) as f64,
                };
                let _ = app.emit_to(label.as_str(), "buddy", msg);
            }
            last_owner = Some(owner);
            last_roam = Some(roam);
        }
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

/// Leave casting → idle (the always-shown overlay stays; it just stops being the
/// full interactive slate). Called by the overlay's Dismiss/Esc/close-book.
#[tauri::command]
fn close_casting(app: AppHandle) -> String {
    #[cfg(windows)]
    close_casting_impl(&app);
    #[cfg(not(windows))]
    let _ = &app;
    "idle".into()
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

/// Toggle the visualizer source: `true` = "Attune" (WASAPI loopback capture),
/// `false` = generative. The wallpaper falls back to generative if capture fails.
#[tauri::command]
fn set_viz_source(app: AppHandle, attuned: bool) -> String {
    #[cfg(windows)]
    {
        if attuned {
            audio::start(app);
        } else {
            audio::stop();
        }
        return format!("viz attuned={attuned}");
    }
    #[cfg(not(windows))]
    {
        let _ = (app, attuned);
        "noop (non-windows)".into()
    }
}

/// Whether loopback capture is currently running.
#[tauri::command]
fn viz_status() -> bool {
    #[cfg(windows)]
    {
        return audio::is_capturing();
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Power-saving toggle: pause a monitor's wallpaper while a fullscreen window
/// covers it. Default OFF. Persisted in settings.
#[tauri::command]
fn set_pause_on_fullscreen(_app: AppHandle, enabled: bool) -> String {
    settings::set_pause(enabled);
    #[cfg(windows)]
    PAUSE_ON_FULLSCREEN.store(enabled, std::sync::atomic::Ordering::Relaxed);
    format!("pause_on_fullscreen={enabled}")
}

/// A dock/cast hit-rect reported by a wallpaper window, in that window's LOCAL
/// physical px (origin = its monitor's top-left). Rust offsets it by the monitor's
/// virtual-desktop origin to get the screen-space rect the mouse hook tests.
#[derive(Clone, serde::Deserialize)]
struct LocalRect {
    kind: String, // "pill" | "cast"
    #[serde(default)]
    key: Option<String>, // element key for a pill
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

#[cfg(windows)]
fn hit_rects_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<LocalRect>>> {
    static M: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Vec<LocalRect>>>,
    > = std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Rebuild the global (virtual-desktop px) hit-rect list from every wallpaper's
/// locally-reported rects, offsetting each by its monitor origin.
#[cfg(windows)]
fn rebuild_hit_rects() {
    let labels = slot_labels().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let monitors = monitors_store().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let map = hit_rects_map().lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<(i32, i32, i32, i32, hook::HitTarget)> = Vec::new();
    for (label, rects) in map.iter() {
        let Some(idx) = labels.iter().position(|l| l == label) else {
            continue;
        };
        let Some(m) = monitors.get(idx) else { continue };
        for r in rects {
            let target = match r.kind.as_str() {
                "cast" => hook::HitTarget::Cast,
                "pill" => hook::HitTarget::Pill(r.key.clone().unwrap_or_default()),
                "mode" => hook::HitTarget::Mode,
                "attune" => hook::HitTarget::Attune,
                "tomes" => hook::HitTarget::Tomes,
                _ => continue,
            };
            out.push((
                m.x + r.x0.round() as i32,
                m.y + r.y0.round() as i32,
                m.x + r.x1.round() as i32,
                m.y + r.y1.round() as i32,
                target,
            ));
        }
    }
    hook::set_global_rects(out);
}

/// A wallpaper window reports its current dock/cast hit-rects (local physical px).
/// Re-sent on layout changes (resize / insets / primary / mode). Empty list clears.
#[tauri::command]
fn set_hit_rects(label: String, rects: Vec<LocalRect>) {
    #[cfg(windows)]
    {
        hit_rects_map().lock().unwrap_or_else(|e| e.into_inner()).insert(label, rects);
        rebuild_hit_rects();
    }
    #[cfg(not(windows))]
    {
        let _ = (label, rects);
    }
}

/// Toggle desktop-layer interactivity (the global mouse hook). When on, pills/cast
/// are clickable and the buddy is draggable WHEN the desktop is exposed; app windows
/// always keep priority. Persisted; installs/removes the hook live.
#[tauri::command]
fn set_desktop_interactive(app: AppHandle, enabled: bool) -> String {
    settings::set_desktop_interactive(enabled);
    #[cfg(windows)]
    hook::set_enabled(&app, enabled);
    let _ = app.emit("settings:interactive", enabled);
    format!("desktop_interactive={enabled}")
}

/// Toggle the colorblind-safe element palette. Persisted; broadcast so every surface
/// (wallpaper dock, casting overlay, control panel) swaps via a `cb` body class.
#[tauri::command]
fn set_colorblind(app: AppHandle, enabled: bool) -> String {
    settings::set_colorblind(enabled);
    let _ = app.emit("settings:colorblind", enabled);
    format!("colorblind={enabled}")
}

/// Toggle launching the atelier at login. Writes the per-user HKCU Run key via
/// the autostart plugin and persists the setting; broadcast so the tray/control
/// labels stay in sync.
#[tauri::command]
fn set_run_at_startup(app: AppHandle, enabled: bool) -> String {
    settings::set_run_at_startup(enabled);
    let r = if enabled { autostart::enable() } else { autostart::disable() };
    let _ = app.emit("settings:runatstartup", enabled);
    match r {
        Ok(()) => format!("run_at_startup={enabled}"),
        Err(e) => format!("run_at_startup={enabled} (registry error: {e})"),
    }
}

/// Whether the control window should reveal itself on first paint: always on a
/// normal (manual) launch and on first run, but never on an autostart launch
/// (`--minimized`), which boots silently to the tray.
#[tauri::command]
fn should_show_main() -> bool {
    settings::get().first_run || !launched_minimized()
}

/// Set the wallpaper render cap (fps; 0 = monitor refresh). Persisted + broadcast so
/// every wallpaper window retunes its loop live.
#[tauri::command]
fn set_frame_rate(app: AppHandle, fps: u32) -> String {
    settings::set_frame_rate(fps);
    let _ = app.emit("settings:framerate", fps);
    format!("frame_rate={fps}")
}

/// Toggle "primary only" — when on, only the primary monitor runs the animated
/// scene; secondary monitors freeze to static art (~0 GPU) and the buddy stays on
/// the primary. Applied live (no restart): the broadcast retunes the wallpaper
/// windows and the buddy thread reads the setting each tick.
#[tauri::command]
fn set_primary_only(app: AppHandle, enabled: bool) -> String {
    settings::set_primary_only(enabled);
    let _ = app.emit("settings:primaryonly", enabled);
    format!("primary_only={enabled}")
}

/// Toggle the brushbuddy. When off, the buddy thread stops streaming per-frame
/// positions (no damage) and the wallpaper hides it. Applied live.
#[tauri::command]
fn set_buddy_enabled(app: AppHandle, enabled: bool) -> String {
    settings::set_buddy_enabled(enabled);
    let _ = app.emit("settings:buddyenabled", enabled);
    format!("buddy_enabled={enabled}")
}

/// Set a custom brushbuddy sprite (a file path or URL; empty restores the built-in).
/// Persisted + broadcast so every wallpaper swaps the sprite live.
#[tauri::command]
fn set_buddy_sprite(app: AppHandle, src: String) -> String {
    settings::set_buddy_sprite(src.clone());
    let _ = app.emit("settings:buddySprite", src.clone());
    format!("buddy_sprite={src}")
}

/// Set a widget's placement (x/y % of the work area + size multiplier). Persisted +
/// broadcast (whole map) so every wallpaper applies it live.
#[tauri::command]
fn set_widget_layout(app: AppHandle, name: String, x: f64, y: f64, scale: f64, vertical: bool) -> String {
    settings::set_widget_layout(name, x, y, scale, vertical);
    let _ = app.emit("settings:widgetLayout", settings::get().widget_layout);
    "ok".into()
}

/// Reset a widget back to its built-in placement.
#[tauri::command]
fn reset_widget_layout(app: AppHandle, name: String) -> String {
    settings::clear_widget_layout(&name);
    let _ = app.emit("settings:widgetLayout", settings::get().widget_layout);
    "ok".into()
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WidgetSize {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WidgetSizes {
    sizes: std::collections::HashMap<String, WidgetSize>,
    aspect: f64,
}

fn widget_sizes_store() -> &'static std::sync::Mutex<WidgetSizes> {
    static S: std::sync::OnceLock<std::sync::Mutex<WidgetSizes>> = std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(WidgetSizes::default()))
}

/// The (primary) wallpaper reports each widget's rendered size (% of the work area)
/// + the work-area aspect, so the control's layout preview can draw true-proportion
/// chips. Stored + broadcast so the control updates live.
#[tauri::command]
fn report_widget_sizes(app: AppHandle, sizes: std::collections::HashMap<String, WidgetSize>, aspect: f64) {
    let ws = WidgetSizes { sizes, aspect };
    *widget_sizes_store().lock().unwrap_or_else(|e| e.into_inner()) = ws.clone();
    let _ = app.emit("widget:sizes", ws);
}

/// The control window reads the last-reported widget sizes when building its preview.
#[tauri::command]
fn get_widget_sizes() -> WidgetSizes {
    widget_sizes_store().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The current persisted settings (mode / mappings / pause) for the control UI
/// and the wallpaper's initial day/night state.
#[tauri::command]
fn get_settings() -> settings::Settings {
    settings::get()
}

/// Set day/night mode; persists and broadcasts `settings:mode` so every wallpaper
/// window transitions.
#[tauri::command]
fn set_mode(app: AppHandle, mode: String) -> String {
    settings::set_mode(&app, mode.clone());
    format!("mode={mode}")
}

/// Flip day↔night off the AUTHORITATIVE persisted state (not a client-side guess),
/// so a toggle can never set the mode it's already in. Returns the new mode.
#[tauri::command]
fn toggle_mode(app: AppHandle) -> String {
    let next = if settings::get().mode == "day" { "night" } else { "day" };
    settings::set_mode(&app, next.to_string());
    next.to_string()
}

/// Set the launch target for an element key (Spell Bindings panel). Persisted.
#[tauri::command]
fn set_mapping(app: AppHandle, key: String, target: String) -> String {
    settings::set_mapping(key.clone(), target.clone());
    // The dock element-pill labels mirror the live bindings → tell the wallpaper.
    let _ = app.emit("settings:bindings", settings::get().mappings);
    format!("{key} -> {target}")
}

/// Restore the default sigil→app bindings.
#[tauri::command]
fn reset_mappings(app: AppHandle) -> String {
    settings::reset_mappings();
    let _ = app.emit("settings:bindings", settings::get().mappings);
    "mappings reset".into()
}

/// Mark the secret pentacle as discovered (unlocks the Hidden Page / spellbook).
#[tauri::command]
fn mark_secret_found(app: AppHandle) -> String {
    settings::set_secret_found(true);
    let _ = app.emit("tomes:changed", ()); // unlock the Forbidden Page live
    "secret found".into()
}

/// Preview the dedication storybook on demand (for personalizing the gift).
#[tauri::command]
fn preview_storybook(app: AppHandle) -> String {
    surface_storybook(&app);
    "previewing dedication".into()
}

/// Dismiss the one-time first-run welcome (persists so it never shows again).
#[tauri::command]
fn dismiss_welcome() -> String {
    settings::set_first_run(false);
    "welcome dismissed".into()
}

/// Decorative "bird" sigil egg: broadcast so every wallpaper monitor flies a bird.
#[tauri::command]
fn conjure_bird(app: AppHandle) -> String {
    let _ = app.emit("cast:bird", ());
    "a bird takes wing".into()
}

/// Preview the Silver-Eve festival lights on demand (for personalizing the gift).
#[tauri::command]
fn preview_silvereve(app: AppHandle) -> String {
    let _ = app.emit("gift:festival", ());
    "previewing silver eve".into()
}

/// Preview the cursed-misfire Petrification on demand. In play it's a rare (~13%)
/// roll, so this dev hook shows the crystal-eruption + time-stop for polishing it.
#[tauri::command]
fn preview_petrify(app: AppHandle) -> String {
    open_casting_impl(&app); // bring up the casting slate on the active monitor
    let _ = app.emit("preview:petrify", ());
    "previewing misfire".into()
}

/// Preview the in-world casting nudge on demand (it auto-shows only a few times, and
/// only before her first cast — this plays it regardless for review).
#[tauri::command]
fn preview_cast_hint(app: AppHandle) -> String {
    let _ = app.emit("gift:casthint", ());
    "previewing casting nudge".into()
}

/// Update quiet-hours config from the control panel and notify the wallpapers so the
/// change takes effect immediately (each computes the dim from its own local clock).
#[tauri::command]
fn set_quiet_hours(app: AppHandle, enabled: bool, start: String, end: String) -> String {
    settings::set_quiet_hours(enabled, start.clone(), end.clone());
    let _ = app.emit(
        "settings:quiethours",
        serde_json::json!({ "enabled": enabled, "start": start, "end": end }),
    );
    "quiet hours updated".into()
}

/// Preview the quiet-hours "embers" dim on demand — the wallpaper eases into it, then
/// reverts to the real (time-based) state after a few seconds.
#[tauri::command]
fn preview_quiet(app: AppHandle) -> String {
    let _ = app.emit("gift:quietpreview", ());
    "previewing quiet hours".into()
}

/// Preview the floatglow lanterns on demand (they normally fade in at dusk).
#[tauri::command]
fn preview_lanterns(app: AppHandle) -> String {
    let _ = app.emit("gift:lanternpreview", ());
    "previewing lanterns".into()
}

/// Set the visualizer seal's ring-rotation speed (1.0 original / 0.5 half / 0.25
/// quarter) and broadcast it so the wallpaper applies it live.
#[tauri::command]
fn set_ring_speed(app: AppHandle, speed: f32) -> String {
    let s = speed.clamp(0.1, 1.0);
    settings::set_ring_speed(s);
    let _ = app.emit("settings:ringspeed", s);
    format!("ring speed -> {s}")
}

/// Reveal/unreveal the fudemushi directly (the first cast normally hatches it).
/// Persisted + broadcast so the wallpaper shows/hides it live.
#[tauri::command]
fn set_buddy_revealed(app: AppHandle, revealed: bool) -> String {
    settings::set_buddy_revealed(revealed);
    let _ = app.emit("settings:buddyrevealed", revealed);
    format!("buddy_revealed={revealed}")
}

/// Name (or rename) the fudemushi. Trimmed + capped to a sensible length. Persisted +
/// broadcast so the control panel and wallpaper reflect it live.
#[tauri::command]
fn set_buddy_name(app: AppHandle, name: String) -> String {
    let name: String = name.trim().chars().take(24).collect();
    settings::set_buddy_name(name.clone());
    let _ = app.emit("settings:buddyname", name.clone());
    format!("buddy_name={name}")
}

/// Replay the fudemushi's birth (hatch) on demand — a dev preview that re-emits the
/// `buddy:born` signal without changing any state, so the moment can be seen.
#[tauri::command]
fn preview_buddy_birth(app: AppHandle) -> String {
    let _ = app.emit("buddy:born", ());
    "previewing fudemushi birth".into()
}

/// Preview the naming rite (the first-cast hatching ceremony) on demand: position +
/// show + focus the overlay on the active monitor, then emit `gift:naming` so it
/// swaps to the naming view. Does not change any saved state.
#[tauri::command]
fn preview_naming_rite(app: AppHandle) -> String {
    #[cfg(windows)]
    open_casting_impl(&app); // make the overlay interactive on the active monitor
    let _ = app.emit("gift:naming", ());
    "previewing naming rite".into()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let inscribe = MenuItem::with_id(app, "inscribe", "Inscribe (overlay)", true, None::<&str>)?;
    let attune = MenuItem::with_id(app, "attune", "Attune to music (toggle)", true, None::<&str>)?;
    let mode = MenuItem::with_id(app, "mode", "Day / Night (toggle)", true, None::<&str>)?;
    let interact =
        MenuItem::with_id(app, "interact", "Desktop interactivity (toggle)", true, None::<&str>)?;
    let startup =
        MenuItem::with_id(app, "startup", "Run at startup (toggle)", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show control", true, None::<&str>)?;
    let reattach = MenuItem::with_id(app, "reattach", "Re-attach wallpaper", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&inscribe, &attune, &mode, &interact, &startup, &show, &reattach, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id("lorraine-tray")
        .tooltip("Lorraine Atelier")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "inscribe" => overlay_toggle(app),
            "attune" => {
                #[cfg(windows)]
                {
                    let was = audio::is_capturing();
                    println!("[lorraine] tray: Attune clicked (was capturing={was})");
                    if was {
                        audio::stop();
                    } else {
                        audio::start(app.clone());
                    }
                }
            }
            "mode" => {
                let next = if settings::get().mode == "day" { "night" } else { "day" };
                settings::set_mode(app, next.to_string());
            }
            "interact" => {
                let next = !settings::get().desktop_interactive;
                settings::set_desktop_interactive(next);
                #[cfg(windows)]
                hook::set_enabled(app, next);
                let _ = app.emit("settings:interactive", next);
            }
            "startup" => {
                let next = !settings::get().run_at_startup;
                settings::set_run_at_startup(next);
                let _ = if next { autostart::enable() } else { autostart::disable() };
                let _ = app.emit("settings:runatstartup", next);
            }
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
    log_startup(&format!(
        "=== run() start | minimized={} | cwd={:?} | exe={:?}",
        launched_minimized(),
        std::env::current_dir().ok(),
        std::env::current_exe().ok()
    ));

    // Record every panic (message + location + thread) to crash.log before it
    // propagates — diagnostics for an unattended gift. Worker-thread panics now
    // terminate only their thread (panic = unwind), and guarded recovery work carries
    // on; this hook just leaves the breadcrumb. (Phase 13.4.)
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        log_crash(&format!("PANIC [{thread}]: {info}"));
    }));

    // Occlusion-disable is handled per-window via additionalBrowserArgs in
    // tauri.conf.json (identical on every window so they share one WebView2
    // environment — differing args split the environment and break window
    // creation).
    #[cfg(windows)]
    workerw::set_dpi_awareness();

    // Load persisted settings BEFORE the Builder creates windows, so the wallpaper
    // webviews' early get_settings sees the real mode (not the default).
    settings::load();
    log_startup("settings loaded; building app");

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
            close_casting,
            get_status,
            set_pause_on_fullscreen,
            set_desktop_interactive,
            set_hit_rects,
            set_colorblind,
            set_run_at_startup,
            should_show_main,
            set_frame_rate,
            set_primary_only,
            set_buddy_enabled,
            set_buddy_sprite,
            set_widget_layout,
            reset_widget_layout,
            report_widget_sizes,
            get_widget_sizes,
            get_settings,
            set_mode,
            toggle_mode,
            set_mapping,
            reset_mappings,
            mark_secret_found,
            preview_storybook,
            dismiss_welcome,
            conjure_bird,
            preview_silvereve,
            preview_petrify,
            preview_cast_hint,
            set_quiet_hours,
            preview_quiet,
            preview_lanterns,
            set_ring_speed,
            set_buddy_revealed,
            set_buddy_name,
            preview_buddy_birth,
            preview_naming_rite,
            set_viz_source,
            viz_status,
            casting::classify_sigil,
            casting::analyze_ring,
            casting::fire_spell,
            casting::test_launch
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
            #[cfg(windows)]
            PAUSE_ON_FULLSCREEN.store(
                settings::get().pause_on_fullscreen,
                std::sync::atomic::Ordering::Relaxed,
            );
            if let Err(e) = setup_tray(app) {
                log(&handle, format!("tray setup failed: {e}"));
            }

            // Bring the OS Run key in line with the persisted preference. The
            // control window reveals itself on first paint via `should_show_main`
            // (an autostart `--minimized` launch stays hidden in the tray).
            sync_autostart();

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyW);
            match app.global_shortcut().register(shortcut) {
                Ok(_) => log(&handle, "hotkey Ctrl+Alt+W registered"),
                Err(e) => log(&handle, format!("hotkey register failed: {e}")),
            }

            log_startup("setup() done (tray, autostart sync, hotkey)");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lorraine Atelier")
        .run(|_handle, _event| {
            // Attach the wallpaper windows once the event loop is running.
            #[cfg(windows)]
            match _event {
                tauri::RunEvent::Ready => {
                    log_startup("RunEvent::Ready; attaching wallpaper");
                    ensure_attached(_handle);
                    spawn_watchdog(_handle.clone());
                    spawn_buddy(_handle.clone());
                    spawn_birthday_watch(_handle.clone());
                    power::start(_handle.clone()); // sleep/wake + lock/unlock recovery
                    // A gentle in-world nudge so she discovers drawing-to-cast (13.2),
                    // delayed so the scene is up; self-gating so it never nags.
                    {
                        let h = _handle.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(22));
                            maybe_show_cast_hint(&h);
                        });
                    }
                    if settings::get().desktop_interactive {
                        hook::set_enabled(_handle, true);
                    }
                    // Belt-and-suspenders: re-broadcast the persisted mode once windows
                    // exist, in case any wallpaper pulled before settings were loaded.
                    let _ = _handle.emit("settings:mode", settings::get().mode);
                    log_startup("startup complete (attach + watchdog + buddy + hook + power)");
                }
                // If a logon launch dies, this tells us it exited cleanly (vs. a hard
                // mid-startup abort that never reaches here).
                tauri::RunEvent::Exit => log_startup("RunEvent::Exit (shutting down)"),
                _ => {}
            }
        });
}
