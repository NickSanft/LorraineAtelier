//! Casting orchestration: the IPC surface the casting overlay calls. Recognition
//! is authoritative in Rust (wraps the pure `recognizer`); `fire_spell` is the
//! sole side-effecting, atomic commit — it rolls the cursed misfire, spends ink,
//! emits `cast:fire` to bloom every wallpaper monitor, and launches (or, for a
//! reversed ring, dismisses). Persistence of mappings/ink/discovered is Phase 7;
//! for now the spell table + defaults are built in and ink is a process atomic.

use crate::launcher;
use crate::recognizer::{self, Pt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

/// Ink reservoir (percent). Matches the dock's default fill; Phase 7 persists it.
static INK: AtomicI32 = AtomicI32::new(78);

/// A point as sent from the overlay canvas (camelCase-free, plain x/y).
#[derive(Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

fn to_pts(v: &[Point]) -> Vec<Pt> {
    v.iter().map(|p| Pt { x: p.x, y: p.y }).collect()
}

struct Spell {
    key: &'static str,
    sigil: &'static str,
    element: &'static str,
    glyph: &'static str,
    app: &'static str,
    verb: &'static str,
    hue: &'static str,
}

const SPELLS: &[Spell] = &[
    Spell { key: "fire", sigil: "triangle-up", element: "Fire", glyph: "△", app: "Steam", verb: "kindled", hue: "#e8954a" },
    Spell { key: "water", sigil: "triangle-down", element: "Water", glyph: "▽", app: "Discord", verb: "summoned", hue: "#5a93f0" },
    Spell { key: "wind", sigil: "circle", element: "Wind", glyph: "○", app: "Browser", verb: "unfurled", hue: "#2fd6c6" },
    Spell { key: "earth", sigil: "square", element: "Earth", glyph: "□", app: "Files", verb: "unearthed", hue: "#c79a4c" },
    // Light: the canon Fire-sigil VARIANT (triangle + a centre dot — detected in the
    // overlay as a small central mark, so it never collides with Fire in find_spell,
    // which is keyed off the recognizer's shape). v1 effect is a cosmetic
    // illumination bloom (no app); bindable in Phase 7. Blooms as the fire triangle.
    Spell { key: "light", sigil: "triangle-up", element: "Light", glyph: "✦", app: "the atelier", verb: "brightened", hue: "#f5d27e" },
];

/// Mirror of the prototype's `spells.find(s=>s.sigil===kind) || ...startsWith(base)`.
fn find_spell(kind: &str, base: &str) -> Option<&'static Spell> {
    SPELLS
        .iter()
        .find(|s| s.sigil == kind)
        .or_else(|| SPELLS.iter().find(|s| s.sigil.starts_with(base)))
}

/// Try to focus an already-running instance of the element's app (restoring it if
/// minimized) before launching a new one. Browser is left to its URL open (which
/// focuses it anyway); Explorer matches a real File-Explorer window (shell
/// surfaces are excluded in `activate_window_for`). Returns true if one was found.
fn activate_for_key(key: &str) -> bool {
    #[cfg(windows)]
    {
        let names: &[&str] = match key {
            "fire" => &["steam.exe"],
            "water" => &["discord.exe"],
            "earth" => &["explorer.exe"],
            _ => &[],
        };
        if names.is_empty() {
            return false;
        }
        crate::workerw::activate_window_for(names)
    }
    #[cfg(not(windows))]
    {
        let _ = key;
        false
    }
}

#[derive(Serialize)]
pub struct SpellDto {
    key: String,
    element: String,
    glyph: String,
    app: String,
    hue: String,
    sigil: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigilDto {
    kind: String,
    base: String,
    score: i32,
    sideways: bool,
    jut_dir: i32,
    secret: bool,
    spell: Option<SpellDto>,
    // Canon neatness axes (0..1) for the HUD meters; Size is derived in the overlay
    // (it needs the slate dimensions). Symmetry also feeds the misfire odds.
    symmetry: f64,
    steadiness: f64,
}

#[derive(Serialize)]
pub struct RingDto {
    closed: bool,
    encloses: bool,
    /// The reversed / dismiss gesture = a counter-clockwise ring.
    inverse: bool,
    score: i32,
    /// Normalized end-to-end gap (0 = perfectly closed). A small-but-open ring is a
    /// canon "prepared" seal the overlay ignites with a closing dot.
    gap: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDto {
    launched: bool,
    cursed: bool,
    dismissed: bool,
    message: String,
    icon: String,
    ink: i32,
    key: String,
}

/// Payload broadcast to every wallpaper webview so each monitor blooms.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CastFireMsg {
    sigil: String,
    score: i32,
    inverse: bool,
    sideways: bool,
    jut_dir: i32,
    hue: String,
    key: String,
    ink: i32,
}

/// Classify the central sigil stroke (overlay phase 1).
#[tauri::command]
pub fn classify_sigil(points: Vec<Point>) -> SigilDto {
    let r = recognizer::classify(&to_pts(&points));
    let spell = if r.secret {
        None
    } else {
        find_spell(&r.kind, &r.base).map(|s| SpellDto {
            key: s.key.into(),
            element: s.element.into(),
            glyph: s.glyph.into(),
            app: s.app.into(),
            hue: s.hue.into(),
            sigil: s.sigil.into(),
        })
    };
    SigilDto {
        kind: r.kind,
        base: r.base,
        score: r.score.round() as i32,
        sideways: r.sideways,
        jut_dir: r.jut_dir,
        secret: r.secret,
        spell,
        symmetry: r.aspect,
        steadiness: r.closure * 0.5 + r.regularity * 0.5,
    }
}

/// Analyze the enclosing ring around the sigil centre (overlay phase 2).
#[tauri::command]
pub fn analyze_ring(points: Vec<Point>, center: Point) -> RingDto {
    let r = recognizer::analyze_ring(&to_pts(&points), Pt { x: center.x, y: center.y });
    // `recognizer.ccw` is `area > 0`, which in screen (y-down) coords is a CLOCKWISE
    // ring — i.e. a normal CAST. The reversed/dismiss gesture is the negation, so a
    // counter-clockwise ring sets `inverse`. (Plan: CW = cast, CCW = dismiss.)
    RingDto { closed: r.closed, encloses: r.encloses, inverse: !r.ccw, score: r.score.round() as i32, gap: r.gap }
}

/// Commit a cast: the sole side-effecting, atomic step (cursed roll + ink + bloom
/// + launch). Splitting this from the preview commands keeps the HUD live without
/// launching, and makes the roll/ink/launch happen exactly once even if the overlay
/// closes mid-bloom.
#[tauri::command]
pub fn fire_spell(
    app: AppHandle,
    key: String,
    score: i32,
    inverse: bool,
    sideways: bool,
    jut_dir: i32,
    symmetry: f64,
) -> FireDto {
    let spell = SPELLS.iter().find(|s| s.key == key);
    let (sigil, glyph, app_name, verb, hue) = match spell {
        Some(s) => (s.sigil, s.glyph, s.app, s.verb, s.hue),
        None => ("circle", "○", "the app", "cast", "#2fd6c6"),
    };

    // Cursed misfire on a confident, non-reversed, non-sideways cast. Canon: a
    // lop-sided (asymmetric) seal is unstable, so low symmetry raises the odds
    // (~10% at perfect symmetry → ~22% at fully lop-sided).
    let misfire_chance = 0.10 + (1.0 - symmetry.clamp(0.0, 1.0)) * 0.12;
    let cursed = !inverse && !sideways && score >= 50 && rng_unit() < misfire_chance;

    let new_ink = (INK.load(Ordering::Relaxed) - 22).max(6);
    INK.store(new_ink, Ordering::Relaxed);

    // Bloom on every wallpaper monitor (global emit — all wallpaper windows react).
    let _ = app.emit(
        "cast:fire",
        CastFireMsg {
            sigil: sigil.into(),
            score,
            inverse,
            sideways,
            jut_dir,
            hue: hue.into(),
            key: key.clone(),
            ink: new_ink,
        },
    );

    let mut launched = false;
    let mut dismissed = false;
    if inverse {
        // v1: themed reversed-bloom + toast only. Best-effort WM_CLOSE on a
        // process-name-matched window is a later enhancement (R-DISMISS).
        dismissed = true;
    } else if key == "light" {
        // Light is a cosmetic illumination (the bloom IS the effect); no app.
    } else {
        // Resolve the user-configurable target. For a still-default binding, focus a
        // running instance first (restore if minimized); for a custom binding just
        // launch it (process-name activation wouldn't match an arbitrary target).
        let target = crate::settings::mapping_for(&key).unwrap_or_else(|| "files".into());
        let is_default = crate::settings::default_mappings().get(&key).map_or(false, |d| *d == target);
        if !(is_default && activate_for_key(&key)) {
            let _ = launcher::LaunchTarget::from_target(&target).launch();
        }
        launched = true;
    }

    // Toast wording ported from the prototype's fireSpell.
    let (message, icon) = if inverse {
        (format!("↺ The ring reversed — {app_name} dismissed."), "↺")
    } else if key == "light" {
        ("✦ Light kindled — the atelier brightens.".to_string(), "✦")
    } else if cursed {
        (format!("The ink curdled — a cursed misfire! …it passes. ({app_name} opened.)"), "◈")
    } else if sideways {
        (format!("{glyph} The lines tilted — {app_name} shot off sideways, then caught."), "↬")
    } else if score >= 70 {
        (format!("{glyph} {app_name} {verb}. A clean seal."), "✦")
    } else if score >= 42 {
        (format!("{glyph} {app_name} {verb}, though the lines wavered."), "✧")
    } else {
        (format!("The seal sputtered — {app_name} opened, barely."), "◌")
    };

    FireDto { launched, cursed, dismissed, message, icon: icon.into(), ink: new_ink, key }
}

/// Launch (or focus) an element's bound app without drawing — for the Spell
/// Bindings panel's per-row "Test" button.
#[tauri::command]
pub fn test_launch(key: String) -> String {
    let target = crate::settings::mapping_for(&key).unwrap_or_else(|| "files".into());
    let is_default = crate::settings::default_mappings().get(&key).map_or(false, |d| *d == target);
    if is_default && activate_for_key(&key) {
        return format!("focused {key}");
    }
    let _ = launcher::LaunchTarget::from_target(&target).launch();
    format!("launched {key} -> {target}")
}

/// Tiny time-seeded xorshift64* for the cursed-misfire roll. Not cryptographic and
/// the load/store isn't strictly atomic-correct under contention — fine for a
/// once-per-cast cosmetic dice roll.
fn rng_unit() -> f64 {
    static STATE: AtomicU64 = AtomicU64::new(0);
    let mut s = STATE.load(Ordering::Relaxed);
    if s == 0 {
        s = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15)
            | 1;
    }
    s ^= s >> 12;
    s ^= s << 25;
    s ^= s >> 27;
    STATE.store(s, Ordering::Relaxed);
    let r = s.wrapping_mul(0x2545_F491_4F6C_DD1D);
    (r >> 11) as f64 / (1u64 << 53) as f64
}
