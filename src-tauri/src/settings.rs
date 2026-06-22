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
    pub silver_eve: String, // "MM-DD" for the Silver-Eve festival egg (empty = off)
}

impl Default for Gift {
    fn default() -> Self {
        Self {
            recipient_name: String::new(),
            heading: "A Seal in No Tome".into(),
            paragraphs: vec![
                "Some magic isn't drawn for power, but for the people we draw it for.".into(),
                "You found the secret star — so here is the spell with no incantation: a small, glowing wish that you are seen, and treasured, and that the world is a little gentler for your being in it.".into(),
                "Happy birthday. May your year be full of quiet wonders.".into(),
            ],
            signature: "— with love".into(),
            birthday: String::new(),
            silver_eve: String::new(),
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
    pub last_silvereve_year: i32, // guard so Silver-Eve fires at most once/year
    pub discovered: HashMap<String, u32>, // element key → times cast (Tower of Tomes)
    pub first_run: bool, // show the one-time welcome until dismissed
    pub colorblind: bool, // swap element colors to a colorblind-safe palette
    pub buddy_sprite: String, // custom brushbuddy image (path/URL); empty = built-in sprite
    pub widget_layout: HashMap<String, WidgetPos>, // per-widget placement override
    pub run_at_startup: bool, // launch the atelier at login (HKCU Run key)
    pub frame_rate: u32, // wallpaper render cap in fps; 0 = monitor refresh rate
    pub primary_only: bool, // animate only the primary monitor; secondaries get the static OS wallpaper
    pub buddy_enabled: bool, // show + animate the brushbuddy
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
            discovered: HashMap::new(),
            first_run: true,
            colorblind: false,
            buddy_sprite: String::new(),
            widget_layout: HashMap::new(),
            run_at_startup: false, // opt-in; toggled in the control panel / tray
            frame_rate: 30,        // gentle default; lowest GPU/CPU
            primary_only: true,    // default: full scene on primary, static art elsewhere
            buddy_enabled: true,   // the brushbuddy roams by default
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
    if let Ok(mut s) = serde_json::from_str::<Settings>(&txt) {
        for (k, v) in default_mappings() {
            s.mappings.entry(k).or_insert(v);
        }
        *store().lock().unwrap() = s;
    }
}

pub fn get() -> Settings {
    store().lock().unwrap().clone()
}

pub fn mapping_for(key: &str) -> Option<String> {
    store().lock().unwrap().mappings.get(key).cloned()
}

fn save() {
    let s = store().lock().unwrap().clone();
    let Some(p) = file_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(txt) = serde_json::to_string_pretty(&s) {
        let _ = std::fs::write(&p, txt);
    }
}

pub fn set_mode(app: &AppHandle, mode: String) {
    store().lock().unwrap().mode = mode.clone();
    save();
    let _ = app.emit("settings:mode", mode); // wallpaper windows transition to it
}

pub fn set_pause(enabled: bool) {
    store().lock().unwrap().pause_on_fullscreen = enabled;
    save();
}

pub fn set_desktop_interactive(enabled: bool) {
    store().lock().unwrap().desktop_interactive = enabled;
    save();
}

pub fn set_buddy_pos(x: f64, y: f64) {
    {
        let mut s = store().lock().unwrap();
        s.buddy_x = x;
        s.buddy_y = y;
        s.buddy_placed = true;
    }
    save();
}

pub fn set_mapping(key: String, target: String) {
    store().lock().unwrap().mappings.insert(key, target);
    save();
}

pub fn reset_mappings() {
    store().lock().unwrap().mappings = default_mappings();
    save();
}

pub fn set_secret_found(found: bool) {
    store().lock().unwrap().secret_found = found;
    save();
}

pub fn set_first_run(v: bool) {
    store().lock().unwrap().first_run = v;
    save();
}

pub fn set_colorblind(v: bool) {
    store().lock().unwrap().colorblind = v;
    save();
}

pub fn set_buddy_sprite(src: String) {
    store().lock().unwrap().buddy_sprite = src;
    save();
}

pub fn set_run_at_startup(v: bool) {
    store().lock().unwrap().run_at_startup = v;
    save();
}

pub fn set_frame_rate(v: u32) {
    store().lock().unwrap().frame_rate = v;
    save();
}

pub fn set_primary_only(v: bool) {
    store().lock().unwrap().primary_only = v;
    save();
}

pub fn set_buddy_enabled(v: bool) {
    store().lock().unwrap().buddy_enabled = v;
    save();
}

pub fn set_widget_layout(name: String, x: f64, y: f64, scale: f64, vertical: bool) {
    store().lock().unwrap().widget_layout.insert(name, WidgetPos { x, y, scale, vertical });
    save();
}

pub fn clear_widget_layout(name: &str) {
    store().lock().unwrap().widget_layout.remove(name);
    save();
}

/// Record that an element was cast (first cast inscribes it in the Tower of Tomes).
pub fn record_discovery(key: &str) {
    {
        let mut s = store().lock().unwrap();
        *s.discovered.entry(key.to_string()).or_insert(0) += 1;
    }
    save();
}

pub fn set_last_birthday_year(year: i32) {
    store().lock().unwrap().last_birthday_year = year;
    save();
}

pub fn set_last_silvereve_year(year: i32) {
    store().lock().unwrap().last_silvereve_year = year;
    save();
}
