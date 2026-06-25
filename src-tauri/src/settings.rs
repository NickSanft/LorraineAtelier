//! Minimal persisted settings (mode / spell mappings / pause) backing the control
//! window's Day-Night and Spell-Bindings panels. The comprehensive Phase-7 store
//! (discovered / ink / castLog / gift) layers on later; this is just the slice
//! those features need now. Single JSON at the app config dir; Rust is sole writer.
//!
//! The path is derived from `%APPDATA%` (no AppHandle) so `load()` can run BEFORE
//! the Tauri windows are created — otherwise the wallpaper webviews query
//! `get_settings` before the store is populated and see stale defaults.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Must match the `identifier` in tauri.conf.json (app config dir name).
const APP_DIR: &str = "com.divora.lorraineatelier";

/// The gift's personalizable dedication — the storybook shown when the secret
/// pentacle is drawn (and surfaced on the birthday). The dev edits these strings
/// before building (or in settings.json); placeholder copy ships so it always
/// renders. `birthday` is "MM-DD" (empty = no auto-surface).
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Gift {
    pub recipient_name: String,
    pub heading: String,
    pub paragraphs: Vec<String>,
    pub signature: String,
    pub birthday: String,
    pub silver_eve: String, // "weekends" (every Sat/Sun), "MM-DD" (annual), or empty = off
}

impl Default for Gift {
    fn default() -> Self {
        Self {
            recipient_name: "Lorraine".into(),
            heading: "A Seal in No Tome".into(),
            paragraphs: vec![
                "In the Atelier, magic is never spoken — it is drawn, slowly and by hand, for the people we hold most dear. This whole small world was drawn for you, and it bears your name: the Lorraine Atelier.".into(),
                "You found the secret star — the one seal written in no tome. It holds a spell that needs no incantation: that you are seen exactly as you are, loved beyond all measure, and that the world is warmer and brighter for your being in it.".into(),
                "Happy birthday, Lorraine. May your year overflow with quiet wonders — and may you never forget how deeply treasured you are.".into(),
            ],
            signature: "— with all my love".into(),
            birthday: "07-25".into(),
            silver_eve: "weekends".into(),
        }
    }
}

/// A widget's user-set placement: top-left position as a percentage of the work
/// area + a size multiplier (on top of the auto monitor-height ui-scale).
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WidgetPos {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub vertical: bool, // dock only: stack the pills vertically instead of in a row
}

impl Default for WidgetPos {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale: 1.0, vertical: false }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub mode: String,                      // "night" | "day"
    pub mappings: HashMap<String, String>, // element key → launch target
    pub pause_on_fullscreen: bool,
    pub desktop_interactive: bool, // click pills/cast + drag the buddy on the desktop
    pub buddy_x: f64,              // last dropped buddy center (virtual-desktop px)
    pub buddy_y: f64,
    pub buddy_placed: bool, // false → seed the buddy at the primary monitor centre
    pub gift: Gift,
    pub secret_found: bool,
    pub last_birthday_year: i32, // guard so the birthday surfaces at most once/year
    pub last_silvereve_year: i32, // guard so an annual Silver-Eve fires at most once/year
    pub last_silvereve_day: String, // YYYY-MM-DD guard so a "weekends" Silver-Eve fires once/day
    pub discovered: HashMap<String, u32>, // element key → times cast (Tower of Tomes)
    pub first_run: bool, // show the one-time welcome until dismissed
    pub colorblind: bool, // swap element colors to a colorblind-safe palette
    pub buddy_sprite: String, // custom brushbuddy image (path/URL); empty = built-in sprite
    pub widget_layout: HashMap<String, WidgetPos>, // per-widget placement override
    pub run_at_startup: bool, // launch the atelier at login (HKCU Run key)
    pub frame_rate: u32, // wallpaper render cap in fps; 0 = monitor refresh rate
    pub primary_only: bool, // animate only the primary monitor; secondaries get the static OS wallpaper
    pub buddy_enabled: bool, // show + animate the brushbuddy
    pub buddy_revealed: bool, // the fudemushi has hatched (set on the first-ever cast); gates roaming
    pub buddy_name: String,   // the name given to the fudemushi (empty = still unnamed)
    pub cast_hint_shown: u32, // times the in-world "magic is drawn" nudge has shown (capped, then never)
    pub quiet_hours_enabled: bool, // dim the scene to "embers" during the quiet window
    pub quiet_start: String,       // "HH:MM" local — quiet window start
    pub quiet_end: String,         // "HH:MM" local — quiet window end (may wrap past midnight)
    pub ring_speed: f32,           // visualizer seal rotation speed (1.0 original, 0.5 half, 0.25 quarter)
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: "night".into(),
            mappings: default_mappings(),
            pause_on_fullscreen: true, // gift default: don't animate behind fullscreen games/videos
            desktop_interactive: true, // on by default for the gift; installs the mouse hook
            buddy_x: 0.0,
            buddy_y: 0.0,
            buddy_placed: false,
            gift: Gift::default(),
            secret_found: false,
            last_birthday_year: 0,
            last_silvereve_year: 0,
            last_silvereve_day: String::new(),
            discovered: HashMap::new(),
            first_run: true,
            colorblind: false,
            buddy_sprite: String::new(),
            widget_layout: HashMap::new(),
            run_at_startup: true, // gift default: the atelier should greet her at every login
            frame_rate: 30,        // gentle default; lowest GPU/CPU
            primary_only: true,    // default: full scene on primary, static art elsewhere
            buddy_enabled: true,   // the brushbuddy roams by default
            buddy_revealed: false, // hatches on the first cast (existing casters auto-revealed via `discovered`)
            buddy_name: String::new(), // unnamed until the naming rite
            cast_hint_shown: 0,    // the casting nudge hasn't shown yet
            quiet_hours_enabled: true, // gift default: the atelier rests at night
            quiet_start: "22:00".into(),
            quiet_end: "07:00".into(),
            ring_speed: 0.5, // gift default: the gentler half-speed turn reads as calmer/dreamier
        }
    }
}

/// Default sigil→target bindings. A target is a string the launcher hands to the
/// shell (URL/protocol/path); the sentinel "files" opens File Explorer.
pub fn default_mappings() -> HashMap<String, String> {
    [
        ("fire", "steam://open/main"),
        ("water", "discord://"),
        ("wind", "https://www.google.com"),
        ("earth", "files"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn store() -> &'static Mutex<Settings> {
    static S: OnceLock<Mutex<Settings>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Settings::default()))
}

fn file_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join(APP_DIR).join("settings.json"))
}

/// Load from disk into the in-memory store. Call ONCE at the very start of `run()`
/// (before the Builder creates windows). Missing mapping keys are backfilled.
pub fn load() {
    let Some(p) = file_path() else { return };
    let Ok(txt) = std::fs::read_to_string(&p) else { return };
    match serde_json::from_str::<Settings>(&txt) {
        Ok(mut s) => {
            for (k, v) in default_mappings() {
                s.mappings.entry(k).or_insert(v);
            }
            *store().lock().unwrap_or_else(|e| e.into_inner()) = s;
        }
        Err(_) => {
            // Corrupt or incompatible file: preserve it (so it can be recovered) instead of
            // letting the first save() silently overwrite it with defaults.
            let _ = std::fs::rename(&p, p.with_extension("corrupt.json"));
        }
    }
}

pub fn get() -> Settings {
    store().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn mapping_for(key: &str) -> Option<String> {
    store().lock().unwrap_or_else(|e| e.into_inner()).mappings.get(key).cloned()
}

fn save() {
    let s = store().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(p) = file_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(txt) = serde_json::to_string_pretty(&s) {
        // Atomic write: serialize to a temp sibling, then rename it over the live file.
        // A crash mid-write can then never leave settings.json half-written (which would
        // fail to parse on next load and silently reset to defaults — losing the named
        // fudemushi, discovered tomes, widget layout, etc.). std::fs::rename replaces the
        // destination on Windows, and same-dir rename is atomic on the same volume.
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, &txt).is_ok() {
            if std::fs::rename(&tmp, &p).is_err() {
                let _ = std::fs::write(&p, &txt); // rename failed (rare) → best-effort direct write
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
}

pub fn set_mode(app: &AppHandle, mode: String) {
    store().lock().unwrap_or_else(|e| e.into_inner()).mode = mode.clone();
    save();
    let _ = app.emit("settings:mode", mode); // wallpaper windows transition to it
}

pub fn set_pause(enabled: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).pause_on_fullscreen = enabled;
    save();
}

pub fn set_desktop_interactive(enabled: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).desktop_interactive = enabled;
    save();
}

pub fn set_buddy_pos(x: f64, y: f64) {
    {
        let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
        s.buddy_x = x;
        s.buddy_y = y;
        s.buddy_placed = true;
    }
    save();
}

pub fn set_mapping(key: String, target: String) {
    store().lock().unwrap_or_else(|e| e.into_inner()).mappings.insert(key, target);
    save();
}

pub fn reset_mappings() {
    store().lock().unwrap_or_else(|e| e.into_inner()).mappings = default_mappings();
    save();
}

pub fn set_secret_found(found: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).secret_found = found;
    save();
}

pub fn set_first_run(v: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).first_run = v;
    save();
}

pub fn set_colorblind(v: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).colorblind = v;
    save();
}

pub fn set_buddy_sprite(src: String) {
    store().lock().unwrap_or_else(|e| e.into_inner()).buddy_sprite = src;
    save();
}

pub fn set_run_at_startup(v: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).run_at_startup = v;
    save();
}

pub fn set_frame_rate(v: u32) {
    store().lock().unwrap_or_else(|e| e.into_inner()).frame_rate = v;
    save();
}

pub fn set_primary_only(v: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).primary_only = v;
    save();
}

pub fn set_buddy_enabled(v: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).buddy_enabled = v;
    save();
}

pub fn set_buddy_revealed(v: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).buddy_revealed = v;
    save();
}

pub fn set_buddy_name(name: String) {
    store().lock().unwrap_or_else(|e| e.into_inner()).buddy_name = name;
    save();
}

pub fn set_cast_hint_shown(v: u32) {
    store().lock().unwrap_or_else(|e| e.into_inner()).cast_hint_shown = v;
    save();
}

pub fn set_quiet_hours(enabled: bool, start: String, end: String) {
    {
        let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
        s.quiet_hours_enabled = enabled;
        s.quiet_start = start;
        s.quiet_end = end;
    }
    save();
}

pub fn set_ring_speed(v: f32) {
    store().lock().unwrap_or_else(|e| e.into_inner()).ring_speed = v;
    save();
}

pub fn set_widget_layout(name: String, x: f64, y: f64, scale: f64, vertical: bool) {
    store().lock().unwrap_or_else(|e| e.into_inner()).widget_layout.insert(name, WidgetPos { x, y, scale, vertical });
    save();
}

pub fn clear_widget_layout(name: &str) {
    store().lock().unwrap_or_else(|e| e.into_inner()).widget_layout.remove(name);
    save();
}

/// Record that an element was cast (first cast inscribes it in the Tower of Tomes).
/// Returns `true` when this was the FIRST-EVER cast (the `discovered` map was empty
/// before) — the signal the fudemushi uses to hatch.
pub fn record_discovery(key: &str) -> bool {
    let first_ever = {
        let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
        let was_empty = s.discovered.is_empty();
        *s.discovered.entry(key.to_string()).or_insert(0) += 1;
        was_empty
    };
    save();
    first_ever
}

pub fn set_last_birthday_year(year: i32) {
    store().lock().unwrap_or_else(|e| e.into_inner()).last_birthday_year = year;
    save();
}

pub fn set_last_silvereve_year(year: i32) {
    store().lock().unwrap_or_else(|e| e.into_inner()).last_silvereve_year = year;
    save();
}

pub fn set_last_silvereve_day(day: String) {
    store().lock().unwrap_or_else(|e| e.into_inner()).last_silvereve_day = day;
    save();
}
