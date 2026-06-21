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

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub mode: String,                      // "night" | "day"
    pub mappings: HashMap<String, String>, // element key → launch target
    pub pause_on_fullscreen: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { mode: "night".into(), mappings: default_mappings(), pause_on_fullscreen: false }
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

pub fn set_mapping(key: String, target: String) {
    store().lock().unwrap().mappings.insert(key, target);
    save();
}

pub fn reset_mappings() {
    store().lock().unwrap().mappings = default_mappings();
    save();
}
