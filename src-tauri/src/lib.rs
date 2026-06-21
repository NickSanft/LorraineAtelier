#[cfg(windows)]
mod host;
#[cfg(windows)]
mod workerw;

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
            workerw::cover_active_monitor(h);
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
    // Publish the (capped) monitor list for the brushbuddy thread.
    *monitors_store().lock().unwrap() = monitors[..n].to_vec();

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

#[cfg(windows)]
fn spawn_buddy(app: AppHandle) {
    std::thread::spawn(move || {
        const TICK_MS: u64 = 33; // ~30 Hz
        const GROUND: f64 = 112.0; // px above a monitor's bottom the buddy walks
        const SPEED: f64 = 3.4; // px/tick while walking
        const ARRIVE: f64 = 6.0; // distance to target that counts as "arrived"
        const Y_LERP: f64 = 0.11; // vertical ease toward owner ground (seam rise)
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

        loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));

            let mons = monitors_store().lock().unwrap().clone();
            let n = mons.len();
            if n == 0 {
                started = false;
                continue;
            }

            if !started {
                let p = mons.iter().find(|m| m.primary).unwrap_or(&mons[0]);
                x = p.x as f64 + p.width as f64 * 0.5;
                y = (p.y + p.height) as f64 - GROUND;
                tx = x;
                rest = 40;
                started = true;
            }

            let owner = owner_index(&mons, x);
            let om = mons[owner];
            // Walk along the work-area bottom so the buddy stays above a pinned
            // taskbar (work area == full monitor when the taskbar auto-hides).
            let ground = (om.work_y + om.work_h) as f64 - GROUND;

            if rest > 0 {
                rest -= 1;
                if rest == 0 {
                    napping = false;
                }
            } else {
                let dx = tx - x;
                if dx.abs() <= ARRIVE {
                    // Arrived: rest (sometimes a longer nap), then pick a new target.
                    if rng.unit() < 0.26 {
                        napping = true;
                        rest = rng.range(90.0, 220.0) as i32; // ~3–7 s nap
                    } else {
                        rest = rng.range(18.0, 70.0) as i32; // brief pause
                    }
                    // 45% of the time aim for a DIFFERENT monitor → cross the seam.
                    let tgt = if n > 1 && rng.unit() < 0.45 {
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

            let bob_off = if rest == 0 { bob.sin() * 1.6 } else { 0.0 };

            let labels = slot_labels().lock().unwrap().clone();
            for i in 0..n {
                let Some(label) = labels.get(i) else { continue };
                let m = mons[i];
                let msg = BuddyMsg {
                    label: label.clone(),
                    x: x - m.x as f64,
                    y: y - m.y as f64 + bob_off,
                    visible: i == owner,
                    flip,
                    eye,
                    primary: m.primary,
                    inset_top: (m.work_y - m.y) as f64,
                    inset_bottom: ((m.y + m.height) - (m.work_y + m.work_h)) as f64,
                    inset_left: (m.work_x - m.x) as f64,
                    inset_right: ((m.x + m.width) - (m.work_x + m.work_w)) as f64,
                };
                let _ = app.emit_to(label.as_str(), "buddy", msg);
            }
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
fn set_mapping(key: String, target: String) -> String {
    settings::set_mapping(key.clone(), target.clone());
    format!("{key} -> {target}")
}

/// Restore the default sigil→app bindings.
#[tauri::command]
fn reset_mappings() -> String {
    settings::reset_mappings();
    "mappings reset".into()
}

/// Mark the secret pentacle as discovered (unlocks the Hidden Page / spellbook).
#[tauri::command]
fn mark_secret_found() -> String {
    settings::set_secret_found(true);
    "secret found".into()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let inscribe = MenuItem::with_id(app, "inscribe", "Inscribe (overlay)", true, None::<&str>)?;
    let attune = MenuItem::with_id(app, "attune", "Attune to music (toggle)", true, None::<&str>)?;
    let mode = MenuItem::with_id(app, "mode", "Day / Night (toggle)", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show control", true, None::<&str>)?;
    let reattach = MenuItem::with_id(app, "reattach", "Re-attach wallpaper", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&inscribe, &attune, &mode, &show, &reattach, &quit])?;

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

    // Load persisted settings BEFORE the Builder creates windows, so the wallpaper
    // webviews' early get_settings sees the real mode (not the default).
    settings::load();

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
            set_pause_on_fullscreen,
            get_settings,
            set_mode,
            toggle_mode,
            set_mapping,
            reset_mappings,
            mark_secret_found,
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
                spawn_buddy(_handle.clone());
                // Belt-and-suspenders: re-broadcast the persisted mode once windows
                // exist, in case any wallpaper pulled before settings were loaded.
                let _ = _handle.emit("settings:mode", settings::get().mode);
            }
        });
}
