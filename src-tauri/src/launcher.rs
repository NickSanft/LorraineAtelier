//! App-launch targets for cast spells. v1 opens via the Windows shell default
//! handler (`cmd /C start` for protocols/URLs, `explorer` for Files). Targets are
//! hard-coded defaults here (not user input), so no shell-injection surface. Phase
//! 7 makes the sigil→target mapping user-editable and may move to
//! tauri-plugin-shell scoping.

#[derive(Clone, Debug)]
pub enum LaunchTarget {
    /// A protocol URI or URL opened by the shell's default handler
    /// (e.g. `steam://open/main`, `discord://`, `https://…`).
    Open(String),
    /// File Explorer (no argument → This PC / Home).
    Files,
}

impl LaunchTarget {
    pub fn launch(&self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use std::process::Command;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000; // don't flash a console for cmd
            match self {
                LaunchTarget::Open(s) => Command::new("cmd")
                    // `start "" <target>` lets the shell choose the default handler;
                    // the empty "" is start's (ignored) window-title argument.
                    .args(["/C", "start", "", s])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map(|_| ()),
                LaunchTarget::Files => Command::new("explorer").spawn().map(|_| ()),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = self;
            Ok(())
        }
    }
}

/// Default launch target for each element key. Phase 7 will make these
/// user-configurable in the control window's Spell Bindings panel.
pub fn default_target(key: &str) -> LaunchTarget {
    match key {
        "fire" => LaunchTarget::Open("steam://open/main".into()),
        "water" => LaunchTarget::Open("discord://".into()),
        "wind" => LaunchTarget::Open("https://www.google.com".into()),
        "earth" => LaunchTarget::Files,
        _ => LaunchTarget::Files,
    }
}
