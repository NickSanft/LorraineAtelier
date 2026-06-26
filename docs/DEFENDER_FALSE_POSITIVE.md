# Windows Defender false positive — playbook

On 2026-06-26 the installed build was quarantined by Microsoft Defender as
**`Trojan:Win32/Bearfoos.B!ml`**. The **`!ml`** suffix means this is a **cloud
machine-learning guess, not a signature match** — a well-documented false-positive
class for *unsigned, freshly built* Tauri/NSIS desktop apps with no PE version
metadata and zero file reputation (the same FP hit Microsoft's own APM binary and
the OpenAI Codex CLI). It is **not** a real infection — this is our own code,
compiled from this repo.

What Defender flagged: the installed `lorraine-atelier.exe` plus its Start-Menu
shortcut and uninstall registry entry (the self-installing-with-persistence
footprint), scanned at install time before the app even ran.

---

## 1. Unblock a machine that already flagged it (dev box, or Lorraine's during setup)

Needs **admin**. In an **elevated PowerShell** (changing AV settings is a deliberate,
user-run action):

```powershell
# Stop Defender from re-quarantining the install + dev build outputs
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Lorraine Atelier"
Add-MpPreference -ExclusionPath "C:\Users\nicho\Documents\GitHub\LorraineAtelier\src-tauri\target"
# Restore the quarantined build (or just reinstall after the exclusions are set)
& "$env:ProgramFiles\Windows Defender\MpCmdRun.exe" -Restore -Name "Trojan:Win32/Bearfoos.B!ml"
```

UI route: **Windows Security → Virus & threat protection → Protection history →**
the Bearfoos item **→ Actions → Restore/Allow**, then add the same folder exclusions.

> An exclusion only helps *that* machine. It does **not** fix the gift on Lorraine's
> PC — for that, use the submission (below) on the **final** build.

---

## 2. Submit the false positive to Microsoft (free — the real fix)

This is the only free action that turns the detection off for **all** Defender users
(via a cloud/definition update). Do it for the **final** distributed build.

1. Go to **https://www.microsoft.com/en-us/wdsi/filesubmission** and **sign in** with a
   free Microsoft account (required since 2024 for a tracked, rescannable submission).
2. Submission type: **Software developer** (not Home customer).
   Reason: **Incorrectly detected as malware/malicious**.
3. **Detection name:** `Trojan:Win32/Bearfoos.B!ml` · **Product:** Microsoft Defender Antivirus.
4. Upload the flagged file(s), ≤50 MB. Submit **both** as separate submissions if both
   flag: **(a)** the installer (`*_x64-setup.exe`) and **(b)** the installed
   `lorraine-atelier.exe` (from `%LOCALAPPDATA%\Lorraine Atelier\`).
5. Paste the description below.
6. Track status at **https://www.microsoft.com/en-us/wdsi/submissionhistory**
   (Submitted → In progress → Closed). Use **Rescan** to refresh a determination.
   Official turnaround is hours; real-world can be several days — **submit a few days
   before gifting**, not the night before.

> **Per-hash caveat:** a cleared verdict is tied to the file's SHA-256. Because we're
> unsigned, *rebuilding changes the hash* and can re-flag — so submit the **exact
> binary you will hand over**, and don't rebuild it afterward.

### Ready-to-paste description (≤1900 chars)

```
This is a false positive. "Lorraine Atelier" is a personal desktop live-wallpaper
app I built and compiled myself from my own source (Rust + Tauri 2 + WebView2,
bundled with NSIS). It is unsigned and freshly built — the known trigger for
Defender's machine-learning ("!ml") false positives on low-reputation binaries.

The behaviors that may look suspicious are all legitimate and standard for a
live-wallpaper app:
- It hosts a WebView2 window and reparents it under the desktop's WorkerW so animated
  art renders behind the desktop icons (the standard Windows live-wallpaper technique).
- It installs a low-level MOUSE hook (WH_MOUSE_LL) only so the user can click on-screen
  widgets that sit behind the desktop icons. It captures no keystrokes and logs nothing.
- It can register a per-user startup entry, which is OFF by default and user opt-in.
- It reads/writes only its own settings under %APPDATA%\com.divora.lorraineatelier.

It does NO network communication, NO keystroke/credential capture, NO code injection
into other processes, NO file encryption, and NO system/security modification.
Other major AV engines do not detect it. Please re-clear this file hash. Thank you.
```

(Optional, strengthens the case: upload the binary to VirusTotal and link the report
showing no detections from other reputable engines. Note this shares the sample with
security vendors — it contains no secrets, but it does reveal the app's name.)

---

## 3. Free build-hygiene wins (lower the ML score on future builds)

Ordered by value. "Done" = already in the tree.

- **[done] Autostart is opt-in.** `run_at_startup` now defaults **off**; a fresh install
  writes no logon-persistence entry until the user opts in via the welcome panel
  ("Open the Atelier when I sign in", on by choice). First execution of a
  zero-reputation download is when Defender scrutinizes hardest, so not writing a Run
  key then removes the loudest persistence signal.
- **[done — already covered by Tauri 2] PE version metadata.** Verified on the rc.1 exe:
  Tauri 2 already embeds ProductName, FileDescription, CompanyName, ProductVersion,
  FileVersion, and LegalCopyright from `tauri.conf.json` — the binary is **not** anonymous.
  So `tauri-winres` is unnecessary here (and would risk a duplicate-resource link
  conflict). Only `OriginalFilename`/`InternalName` are blank — a negligible signal.
- **[done] Explicit publisher.** Set `bundle.publisher` ("Divora") in `tauri.conf.json` so
  the exe `CompanyName` and the NSIS installer's Publisher field are deliberate values
  rather than the lowercased identifier segment. Applies to the next installer cut.
- **[verify] Manifest requests `asInvoker`**, not admin (the app needs no elevation;
  elevation requests amplify suspicion + add a UAC prompt). Tauri's default is usually fine.
- **[ok] No packing.** Rust release builds are not UPX/packed — keep it that way
  (runtime self-unpacking is the #1 ML red flag). `strip = true` for symbols is fine.
- **[marginal] Consider the WiX `.msi` target** — reported to trip fewer FPs than the
  NSIS `.exe` stub. Low-effort `tauri.conf.json` change if it helps.

## 4. Signing & reputation (honest notes)

- **Self-signed certs are worthless** here (treated as unsigned).
- **EV certs no longer grant instant SmartScreen reputation** (changed ~2024) — don't
  pay the EV premium just to dodge SmartScreen.
- The cheap modern identity is **Azure Trusted Signing** (~$10/mo, OV-grade, no hardware
  token, CI-friendly): it won't kill the first-download SmartScreen prompt, but it shows
  a real publisher name and lets reputation accrue across versions on one identity, and
  it lowers AV ML suspicion vs fully unsigned. For a single-recipient gift it's optional.
- **Reputation via downloads won't happen** for a ~1-install gift app — rely on the
  metadata hygiene + the FP submission, not prevalence.
- **SmartScreen ("unrecognized app") is a separate system** from the Bearfoos AV
  detection; a clean Defender determination won't remove a browser's
  unrecognized-app/Mark-of-the-Web prompt. Installing from a local file (not a browser
  download) avoids the MOTW prompt entirely.

## Sources
- Submit a file for analysis (WDSI): https://www.microsoft.com/en-us/wdsi/filesubmission
- Defender FP/FN handling: https://learn.microsoft.com/en-us/defender-endpoint/defender-endpoint-false-positives-negatives
- SmartScreen reputation for developers: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Tauri false-positives guide: https://tauri.by.simon.hyll.nu/concepts/security/false_positives/
- tauri-winres (version metadata): https://github.com/tauri-apps/winres
- Bearfoos FP on Microsoft's own binary: https://github.com/microsoft/apm/issues/487
