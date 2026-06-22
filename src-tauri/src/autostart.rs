//! Run-at-startup via a shortcut in the per-user **Startup folder**
//! (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Lorraine Atelier.lnk`).
//!
//! Why a Startup-folder `.lnk` and not an `HKCU\…\Run` value:
//!   1. A `.lnk` stores the target path and arguments as SEPARATE fields, so the
//!      space in the installed path (`%LOCALAPPDATA%\Lorraine Atelier\…`) can never
//!      truncate the command — the failure mode that an unquoted Run value (what
//!      `tauri-plugin-autostart`/`auto-launch` writes) hits at logon.
//!   2. Empirically, an HKCU Run value for THIS exe — valid, quoted, and enabled —
//!      was silently skipped at logon on the dev box, while a Startup-folder
//!      shortcut to the same exe launched it cleanly every time. The shortcut is
//!      the robust mechanism.
//!
//! The shortcut passes `--minimized` so a logon launch boots straight to the tray
//! (see `should_show_main`). The target is `current_exe()`, so the installed build
//! registers its install path automatically.

/// The shortcut's file name in the Startup folder (also its Task Manager label).
pub const LNK_NAME: &str = "Lorraine Atelier.lnk";

#[cfg(windows)]
mod imp {
    use super::LNK_NAME;
    use std::io;
    use std::path::PathBuf;

    /// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`.
    fn startup_dir() -> io::Result<PathBuf> {
        let appdata = std::env::var_os("APPDATA")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "APPDATA not set"))?;
        Ok(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
    }

    fn lnk_path() -> io::Result<PathBuf> {
        Ok(startup_dir()?.join(LNK_NAME))
    }

    pub fn enable() -> io::Result<()> {
        let exe = std::env::current_exe()?;
        let dir = startup_dir()?;
        std::fs::create_dir_all(&dir)?;
        let lnk = dir.join(LNK_NAME);

        let mut link = mslnk::ShellLink::new(&exe)
            .map_err(|e| io::Error::other(format!("mslnk new: {e:?}")))?;
        link.set_arguments(Some("--minimized".to_string()));
        if let Some(parent) = exe.parent() {
            link.set_working_dir(Some(parent.to_string_lossy().into_owned()));
        }
        link.create_lnk(&lnk)
            .map_err(|e| io::Error::other(format!("mslnk create: {e:?}")))?;
        Ok(())
    }

    pub fn disable() -> io::Result<()> {
        let lnk = lnk_path()?;
        match std::fs::remove_file(&lnk) {
            Ok(()) => Ok(()),
            // Already absent — idempotent.
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn is_enabled() -> bool {
        lnk_path().map(|p| p.exists()).unwrap_or(false)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn enable() -> std::io::Result<()> {
        Ok(())
    }
    pub fn disable() -> std::io::Result<()> {
        Ok(())
    }
    pub fn is_enabled() -> bool {
        false
    }
}

pub use imp::{disable, enable, is_enabled};
