// Control window: the Atelier's settings panel. Toggles drive Rust commands and
// stay in sync with the tray (which can toggle the same state). The Spell Bindings
// panel edits the persisted sigil→app mappings.
const logEl = document.getElementById("log")!;
// Cap the in-memory log. The control window is hidden (not destroyed), so it lives for
// the whole app run; every Rust `log` event (incl. each cast/pill tap) and settings
// toggle calls append(). Prepending onto textContent forever grew the text node without
// bound — instead keep only the most recent LOG_MAX lines, newest first.
const LOG_MAX = 200;
const logLines: string[] = [];
const statusEl = document.getElementById("statusLine");
// The prominent one-line status maps the few genuinely-bad log strings to in-world copy;
// everything else (benign, already friendly) shows as-is. The raw timestamped history
// stays in the collapsed "Scribe's ledger" for troubleshooting.
function friendlyStatus(line: string): string {
  const l = line.toLowerCase();
  if (/host create failed|did not take|re-inscribe failed|reattach failed/.test(l))
    return "The mural would not take to the wall — try “Re-inscribe the mural”, or restart the Atelier.";
  if (/attune failed/.test(l)) return "The Atelier could not hear the music just now.";
  if (/get_settings ✗|thread spawn failed|registry error/.test(l))
    return "Something went awry — the ledger below has the details.";
  return line;
}
function append(line: string) {
  const t = new Date().toLocaleTimeString();
  logLines.unshift(`[${t}] ${line}`);
  if (logLines.length > LOG_MAX) logLines.length = LOG_MAX;
  logEl.textContent = logLines.join("\n");
  if (statusEl) statusEl.textContent = friendlyStatus(line);
}

const modeBtn = document.getElementById("mode") as HTMLButtonElement;
const attuneBtn = document.getElementById("attune") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const interactBtn = document.getElementById("interact") as HTMLButtonElement;
const colorblindBtn = document.getElementById("colorblind") as HTMLButtonElement;
const startupBtn = document.getElementById("startup") as HTMLButtonElement;
const frameRateSel = document.getElementById("frameRate") as HTMLSelectElement;
const ringSpeedSel = document.getElementById("ringSpeed") as HTMLSelectElement;
const primaryOnlyBtn = document.getElementById("primaryOnly") as HTMLButtonElement;
const buddyEnabledBtn = document.getElementById("buddyEnabled") as HTMLButtonElement;
const quietToggleBtn = document.getElementById("quietToggle") as HTMLButtonElement;
const quietStartInput = document.getElementById("quietStart") as HTMLInputElement;
const quietEndInput = document.getElementById("quietEnd") as HTMLInputElement;
const previewQuietBtn = document.getElementById("previewQuiet") as HTMLButtonElement;
const bindingsEl = document.getElementById("bindings")!;
const tomesEl = document.getElementById("tomes")!;
const tomesHintEl = document.getElementById("tomesHint")!;
const forbiddenEl = document.getElementById("forbiddenPage")!;
const tomesPanel = document.getElementById("tomesPanel")!;

const ELEMENTS = [
  { key: "fire", glyph: "△", name: "Fire", hue: "#e8954a" },
  { key: "water", glyph: "▽", name: "Water", hue: "#5a93f0" },
  { key: "wind", glyph: "○", name: "Wind", hue: "#2fd6c6" },
  { key: "earth", glyph: "□", name: "Earth", hue: "#c79a4c" },
];

let mode: "day" | "night" = "night";
let attuned = false;
let pauseOn = false;
let interactOn = false;
let colorblindOn = false;
let startupOn = false;
let primaryOnlyOn = true;
let buddyEnabledOn = true;
let quietEnabledOn = true;

function renderMode() {
  modeBtn.textContent = mode === "night" ? "☾ Night" : "☀ Day";
  modeBtn.classList.toggle("on", mode === "day");
}
function renderAttune() {
  attuneBtn.textContent = attuned ? "♪ Resonance" : "▶ Attune";
  attuneBtn.classList.toggle("on", attuned);
}
function renderPause() {
  pauseBtn.textContent = `Pause on fullscreen: ${pauseOn ? "on" : "off"}`;
  pauseBtn.classList.toggle("on", pauseOn);
}
function renderInteract() {
  interactBtn.textContent = `Desktop interactivity: ${interactOn ? "on" : "off"}`;
  interactBtn.classList.toggle("on", interactOn);
}
function renderColorblind() {
  colorblindBtn.textContent = `Colorblind palette: ${colorblindOn ? "on" : "off"}`;
  colorblindBtn.classList.toggle("on", colorblindOn);
  document.body.classList.toggle("cb", colorblindOn);
}
function renderStartup() {
  startupBtn.textContent = `Run at startup: ${startupOn ? "on" : "off"}`;
  startupBtn.classList.toggle("on", startupOn);
}
function renderPrimaryOnly() {
  primaryOnlyBtn.textContent = `Animate: ${primaryOnlyOn ? "main screen only" : "every screen"}`;
  primaryOnlyBtn.classList.toggle("on", !primaryOnlyOn); // highlight the richer (all-monitors) mode
}
function renderBuddyEnabled() {
  buddyEnabledBtn.textContent = `Brushbuddy: ${buddyEnabledOn ? "on" : "off"}`;
  buddyEnabledBtn.classList.toggle("on", buddyEnabledOn);
}
function renderQuiet() {
  quietToggleBtn.textContent = `Quiet hours: ${quietEnabledOn ? "on" : "off"}`;
  quietToggleBtn.classList.toggle("on", quietEnabledOn);
}

interface SettingsDto {
  mode: string;
  pauseOnFullscreen: boolean;
  desktopInteractive: boolean;
  mappings: Record<string, string>;
  discovered: Record<string, number>;
  secretFound: boolean;
  firstRun: boolean;
  colorblind: boolean;
  runAtStartup: boolean;
  frameRate: number;
  ringSpeed: number;
  primaryOnly: boolean;
  buddyEnabled: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  buddySprite: string;
  buddyName?: string;
  widgetLayout: Record<string, { x: number; y: number; scale: number; vertical?: boolean }>;
}

async function main() {
  let core: typeof import("@tauri-apps/api/core");
  let event: typeof import("@tauri-apps/api/event");
  let win: typeof import("@tauri-apps/api/window");
  try {
    core = await import("@tauri-apps/api/core");
    event = await import("@tauri-apps/api/event");
    win = await import("@tauri-apps/api/window");
  } catch {
    append("(running outside Tauri — controls are inert)");
    return;
  }
  const invoke = core.invoke;

  function buildBindings(mappings: Record<string, string>) {
    bindingsEl.innerHTML = "";
    for (const el of ELEMENTS) {
      const row = document.createElement("div");
      row.className = "brow";
      const g = document.createElement("span");
      g.className = "bg"; g.textContent = el.glyph; g.style.color = `var(--el-${el.key})`;
      const n = document.createElement("span");
      n.className = "bn"; n.textContent = el.name;
      const inp = document.createElement("input");
      inp.className = "bt"; inp.value = mappings[el.key] ?? ""; inp.spellcheck = false;
      inp.title = "URL, protocol (steam://, discord://), path, or 'files' for Explorer";
      inp.addEventListener("change", () => {
        invoke("set_mapping", { key: el.key, target: inp.value.trim() }).then(() => append(`bind ${el.key} → ${inp.value.trim() || "files"}`));
      });
      const test = document.createElement("button");
      test.className = "test"; test.textContent = "Test";
      test.addEventListener("click", async () => {
        await invoke("set_mapping", { key: el.key, target: inp.value.trim() });
        invoke("test_launch", { key: el.key }).then((r) => append(String(r)));
      });
      row.append(g, n, inp, test);
      bindingsEl.appendChild(row);
    }
    document.getElementById("bindingsPanel")!.style.display = "flex";
  }

  // The Tower of Tomes: each element revealed once first cast (with a running count
  // + its bound target), a 4/4 hint, and the Forbidden Page that unlocks on the
  // secret pentacle (→ the dedication).
  function buildTomes(s: SettingsDto) {
    const disc = s.discovered || {};
    tomesEl.innerHTML = "";
    let known = 0;
    for (const el of ELEMENTS) {
      const n = disc[el.key] ?? 0;
      const row = document.createElement("div");
      row.className = n > 0 ? "trow" : "trow locked";
      const g = document.createElement("span");
      g.className = "tg"; g.textContent = n > 0 ? el.glyph : "❔";
      g.style.color = n > 0 ? `var(--el-${el.key})` : "#6b6080";
      const meta = document.createElement("div");
      meta.className = "tmeta";
      const name = document.createElement("span");
      name.className = "tname"; name.textContent = n > 0 ? el.name : "Unknown seal";
      const sub = document.createElement("span");
      sub.className = "tsub";
      sub.textContent = n > 0 ? "→ " + (s.mappings?.[el.key] || "files") : `Draw the ${el.glyph} sigil to inscribe it`;
      meta.append(name, sub);
      const count = document.createElement("span");
      count.className = "tcount"; count.textContent = n > 0 ? `${n}×` : "";
      row.append(g, meta, count);
      tomesEl.appendChild(row);
      if (n > 0) known++;
    }
    tomesHintEl.textContent = known >= ELEMENTS.length
      ? "✦ Four seals inscribed. They whisper of a fifth — a star, hidden in the slate."
      : `${known}/${ELEMENTS.length} seals inscribed.`;
    forbiddenEl.innerHTML = "";
    forbiddenEl.classList.toggle("unlocked", !!s.secretFound);
    const label = document.createElement("span");
    if (s.secretFound) {
      label.textContent = "✦ The Hidden Page lies open.";
      const btn = document.createElement("button");
      btn.textContent = "Read it"; btn.style.fontSize = "10px"; btn.style.padding = "6px 12px";
      btn.addEventListener("click", () => { invoke("preview_storybook"); });
      forbiddenEl.append(label, btn);
    } else {
      label.textContent = "🔒 The Forbidden Page is sealed — find the secret star.";
      forbiddenEl.append(label);
    }
  }
  async function refreshTomes() {
    try { buildTomes(await invoke<SettingsDto>("get_settings")); } catch { /* */ }
  }

  try {
    const s = await invoke<SettingsDto>("get_settings");
    mode = s.mode === "day" ? "day" : "night";
    pauseOn = !!s.pauseOnFullscreen;
    interactOn = !!s.desktopInteractive;
    colorblindOn = !!s.colorblind;
    startupOn = !!s.runAtStartup;
    primaryOnlyOn = s.primaryOnly !== false; // default true
    buddyEnabledOn = s.buddyEnabled !== false; // default true
    quietEnabledOn = s.quietHoursEnabled !== false; // default on
    if (s.quietStart) quietStartInput.value = s.quietStart;
    if (s.quietEnd) quietEndInput.value = s.quietEnd;
    frameRateSel.value = String(s.frameRate ?? 30);
    ringSpeedSel.value = String(s.ringSpeed ?? 0.5);
    buildBindings(s.mappings || {});
    buildTomes(s);
    if (s.firstRun) {
      const wp = document.getElementById("welcomePanel")!;
      wp.style.display = "flex";
      document.getElementById("welcomeBegin")!.addEventListener("click", async () => {
        wp.style.display = "none";
        // Run-at-startup is now opt-in (default off); honour the welcome checkbox so the
        // login-greeting is a consented choice rather than silent install-time persistence.
        const wantStartup = (document.getElementById("welcomeStartup") as HTMLInputElement | null)?.checked ?? false;
        if (wantStartup) {
          startupOn = true; renderStartup();
          try { await invoke("set_run_at_startup", { enabled: true }); } catch { /* */ }
        }
        invoke("dismiss_welcome").then(() => append("welcome dismissed"));
      });
    }
  } catch (e) {
    append("get_settings ✗ " + e);
  }
  try { attuned = !!(await invoke<boolean>("viz_status")); } catch { /* */ }
  renderMode(); renderAttune(); renderPause(); renderInteract(); renderColorblind(); renderStartup(); renderPrimaryOnly(); renderBuddyEnabled(); renderQuiet();

  // Flip via the authoritative Rust toggle; our label updates from the
  // `settings:mode` broadcast below (so it can't desync from the real state).
  modeBtn.addEventListener("click", () => { invoke("toggle_mode"); });
  attuneBtn.addEventListener("click", async () => {
    attuned = !attuned;
    renderAttune();
    await invoke("set_viz_source", { attuned });
  });
  pauseBtn.addEventListener("click", async () => {
    pauseOn = !pauseOn;
    renderPause();
    await invoke("set_pause_on_fullscreen", { enabled: pauseOn });
  });
  interactBtn.addEventListener("click", async () => {
    interactOn = !interactOn;
    renderInteract();
    await invoke("set_desktop_interactive", { enabled: interactOn });
  });
  colorblindBtn.addEventListener("click", async () => {
    colorblindOn = !colorblindOn;
    renderColorblind();
    await invoke("set_colorblind", { enabled: colorblindOn });
  });
  startupBtn.addEventListener("click", async () => {
    startupOn = !startupOn;
    renderStartup();
    await invoke("set_run_at_startup", { enabled: startupOn });
    append(`run at startup → ${startupOn ? "on" : "off"}`);
  });
  frameRateSel.addEventListener("change", async () => {
    const fps = parseInt(frameRateSel.value, 10) || 0;
    await invoke("set_frame_rate", { fps });
    append(`framerate → ${frameRateSel.options[frameRateSel.selectedIndex].text}`);
  });
  ringSpeedSel.addEventListener("change", async () => {
    const speed = parseFloat(ringSpeedSel.value) || 1;
    await invoke("set_ring_speed", { speed });
    append(`ring speed → ${ringSpeedSel.options[ringSpeedSel.selectedIndex].text}`);
  });
  primaryOnlyBtn.addEventListener("click", async () => {
    primaryOnlyOn = !primaryOnlyOn;
    renderPrimaryOnly();
    await invoke("set_primary_only", { enabled: primaryOnlyOn });
    append(`animate → ${primaryOnlyOn ? "main screen only" : "every screen"}`);
  });
  buddyEnabledBtn.addEventListener("click", async () => {
    buddyEnabledOn = !buddyEnabledOn;
    renderBuddyEnabled();
    await invoke("set_buddy_enabled", { enabled: buddyEnabledOn });
    append(`brushbuddy → ${buddyEnabledOn ? "on" : "off"}`);
  });
  const applyQuietHours = async () => {
    await invoke("set_quiet_hours", { enabled: quietEnabledOn, start: quietStartInput.value || "22:00", end: quietEndInput.value || "07:00" });
    append(`quiet hours → ${quietEnabledOn ? `${quietStartInput.value}–${quietEndInput.value}` : "off"}`);
  };
  quietToggleBtn.addEventListener("click", async () => { quietEnabledOn = !quietEnabledOn; renderQuiet(); await applyQuietHours(); });
  quietStartInput.addEventListener("change", applyQuietHours);
  quietEndInput.addEventListener("change", applyQuietHours);
  previewQuietBtn.addEventListener("click", () => invoke("preview_quiet").then(() => append("previewing quiet hours")));
  document.getElementById("previewLanterns")!.addEventListener("click", () => invoke("preview_lanterns").then(() => append("previewing lanterns")));

  document.getElementById("resetBindings")!.addEventListener("click", async () => {
    await invoke("reset_mappings");
    const s = await invoke<SettingsDto>("get_settings");
    buildBindings(s.mappings || {});
    append("bindings reset to defaults");
  });

  const buddyNameInput = document.getElementById("buddyName") as HTMLInputElement;
  buddyNameInput.value = (await invoke<SettingsDto>("get_settings").then((s) => s.buddyName).catch(() => "")) || "";
  buddyNameInput.addEventListener("change", () => {
    const name = buddyNameInput.value.trim();
    invoke("set_buddy_name", { name }).then(() => append(`fudemushi named → ${name || "(unnamed)"}`));
  });
  const buddySpriteInput = document.getElementById("buddySprite") as HTMLInputElement;
  buddySpriteInput.value = (await invoke<SettingsDto>("get_settings").then((s) => s.buddySprite).catch(() => "")) || "";
  buddySpriteInput.addEventListener("change", () => {
    invoke("set_buddy_sprite", { src: buddySpriteInput.value.trim() }).then(() => append(`buddy sprite → ${buddySpriteInput.value.trim() || "built-in"}`));
  });
  document.getElementById("buddySpriteClear")!.addEventListener("click", () => {
    buddySpriteInput.value = "";
    invoke("set_buddy_sprite", { src: "" }).then(() => append("buddy sprite → built-in"));
  });

  // ---- Widget layout editor: drag chips in a monitor preview + a size slider ----
  interface WPos { x: number; y: number; scale: number; vertical?: boolean }
  const LAYOUT_DEFAULTS: Record<string, { x: number; y: number }> = { clock: { x: 3, y: 7 }, seal: { x: 4, y: 55 }, dock: { x: 28, y: 86 }, titlePill: { x: 3, y: 2 }, glyphsPill: { x: 68, y: 2 } };
  const stage = document.getElementById("layoutStage")!;
  const selNameEl = document.getElementById("selWidgetName")!;
  const selScaleEl = document.getElementById("selWidgetScale") as HTMLInputElement;
  const selScaleOut = document.getElementById("selWidgetScaleOut")!;
  const orientBtn = document.getElementById("dockOrient")!;
  let widgetLayout: Record<string, WPos> = {};
  let selWidget = "clock";
  const chips: Record<string, HTMLElement> = {};
  // The wallpaper reports each widget's ACTUAL geometry (% of the work area) so the
  // preview is WYSIWYG — used for size always, and for position when un-customized.
  let reported: Record<string, { x: number; y: number; w: number; h: number }> = {};
  let draggingName = "";
  const wPos = (n: string): WPos => {
    const l = widgetLayout[n];
    if (l) return l;
    const rep = reported[n];
    return { x: rep ? rep.x : LAYOUT_DEFAULTS[n].x, y: rep ? rep.y : LAYOUT_DEFAULTS[n].y, scale: 1, vertical: false };
  };
  function renderChips() {
    for (const n in chips) {
      const p = wPos(n), rep = reported[n];
      chips[n].style.width = (rep ? Math.max(3, rep.w) : 13) + "%";
      chips[n].style.height = (rep ? Math.max(2.5, rep.h) : 8) + "%";
      if (n !== draggingName) { chips[n].style.left = p.x + "%"; chips[n].style.top = p.y + "%"; }
    }
  }
  let pushTimer = 0;
  const pushLayout = (n: string) => {
    const p = wPos(n);
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => { invoke("set_widget_layout", { name: n, x: p.x, y: p.y, scale: p.scale, vertical: !!p.vertical }); }, 60);
  };
  function selectWidget(n: string) {
    selWidget = n; selNameEl.textContent = n;
    const p = wPos(n); selScaleEl.value = String(p.scale); selScaleOut.textContent = p.scale.toFixed(2);
    orientBtn.style.display = n === "dock" ? "inline-block" : "none";
    orientBtn.textContent = p.vertical ? "Make horizontal" : "Make vertical";
    for (const k in chips) chips[k].style.boxShadow = k === n ? "0 0 0 2px var(--gold)" : "none";
  }
  orientBtn.addEventListener("click", () => {
    const p = wPos("dock"); widgetLayout["dock"] = { x: p.x, y: p.y, scale: p.scale, vertical: !p.vertical };
    pushLayout("dock"); selectWidget("dock");
  });
  function startDrag(e: PointerEvent, n: string) {
    e.preventDefault(); selectWidget(n); draggingName = n;
    const chip = chips[n]; chip.setPointerCapture(e.pointerId); chip.style.cursor = "grabbing";
    const sr0 = stage.getBoundingClientRect(); const cr0 = chip.getBoundingClientRect();
    const offX = ((e.clientX - cr0.left) / sr0.width) * 100; // grab offset within the chip
    const offY = ((e.clientY - cr0.top) / sr0.height) * 100;
    const onMove = (ev: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      const x = Math.max(0, Math.min(99, ((ev.clientX - r.left) / r.width) * 100 - offX));
      const y = Math.max(0, Math.min(99, ((ev.clientY - r.top) / r.height) * 100 - offY));
      chip.style.left = x + "%"; chip.style.top = y + "%";
      const cur = wPos(n);
      widgetLayout[n] = { x, y, scale: cur.scale, vertical: cur.vertical };
      pushLayout(n);
    };
    const onUp = (ev: PointerEvent) => { draggingName = ""; chip.releasePointerCapture(ev.pointerId); chip.style.cursor = "grab"; chip.removeEventListener("pointermove", onMove); chip.removeEventListener("pointerup", onUp); };
    chip.addEventListener("pointermove", onMove); chip.addEventListener("pointerup", onUp);
  }
  function buildLayout() {
    stage.innerHTML = ""; for (const k in chips) delete chips[k];
    for (const n of Object.keys(LAYOUT_DEFAULTS)) {
      const chip = document.createElement("div");
      chip.textContent = n.replace("Pill", "");
      chip.style.cssText = `position:absolute;display:flex;align-items:center;justify-content:center;font-family:'Cinzel',serif;font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#efe6d2;background:rgba(232,184,74,.16);border:1px solid var(--gold);border-radius:5px;cursor:grab;user-select:none;overflow:hidden;box-sizing:border-box;touch-action:none;`;
      chip.addEventListener("pointerdown", (e) => startDrag(e, n));
      stage.appendChild(chip); chips[n] = chip;
    }
    renderChips();
    selectWidget(selWidget);
  }
  selScaleEl.addEventListener("input", () => {
    const s = parseFloat(selScaleEl.value); selScaleOut.textContent = s.toFixed(2);
    const p = wPos(selWidget); widgetLayout[selWidget] = { x: p.x, y: p.y, scale: s, vertical: p.vertical }; pushLayout(selWidget);
  });
  document.getElementById("resetWidget")!.addEventListener("click", () => {
    delete widgetLayout[selWidget];
    invoke("reset_widget_layout", { name: selWidget }).then(() => append(`reset ${selWidget} layout`));
    buildLayout();
  });
  interface SizesDto { sizes: Record<string, { x: number; y: number; w: number; h: number }>; aspect: number }
  Promise.all([
    invoke<SettingsDto>("get_settings").then((s) => { widgetLayout = s.widgetLayout || {}; }).catch(() => {}),
    invoke<SizesDto>("get_widget_sizes").then((ws) => { reported = ws.sizes || {}; if (ws.aspect > 0) stage.style.aspectRatio = String(ws.aspect); }).catch(() => {}),
  ]).then(() => buildLayout());
  await event.listen<SizesDto>("widget:sizes", (e) => { reported = e.payload.sizes || {}; if (e.payload.aspect > 0) stage.style.aspectRatio = String(e.payload.aspect); renderChips(); });

  document.getElementById("preview")!.addEventListener("click", () => invoke("preview_storybook").then(() => append("previewing dedication")));
  document.getElementById("previewSilver")!.addEventListener("click", () => invoke("preview_silvereve").then(() => append("previewing Silver Eve")));
  document.getElementById("previewMisfire")!.addEventListener("click", () => invoke("preview_petrify").then(() => append("previewing misfire (Petrification)")));
  document.getElementById("previewCastHint")!.addEventListener("click", () => invoke("preview_cast_hint").then(() => append("previewing casting nudge")));
  document.getElementById("previewBuddyBirth")!.addEventListener("click", () => invoke("preview_buddy_birth").then(() => append("previewing fudemushi birth")));
  document.getElementById("previewNaming")!.addEventListener("click", () => invoke("preview_naming_rite").then(() => append("previewing naming rite")));

  document.getElementById("reattach")!.addEventListener("click", async () => {
    append("re-inscribing the mural…");
    try {
      await invoke("reattach_wallpaper");
      // Attachment finishes asynchronously, so report the real outcome a beat later.
      setTimeout(async () => {
        try {
          const [n, m] = await invoke<[number, number]>("attach_status");
          append(
            m > 0 && n >= m ? `the mural is drawn on ${m === 1 ? "your screen" : `all ${m} screens`} ✦`
              : n > 0 ? `the mural is drawn on ${n} of ${m} screens`
              : "the mural did not take — try again, or restart the Atelier"
          );
        } catch { /* */ }
      }, 1200);
    } catch (e) { append("re-inscribe failed: " + e); }
  });
  document.getElementById("overlay")!.addEventListener("click", () => invoke("toggle_overlay"));
  // Detach destroys every wallpaper window; it's hidden behind the dev flag (Ctrl+Shift+D)
  // since the watchdog re-attaches automatically and a stray click would blank the gift.
  document.getElementById("detach")!.addEventListener("click", () => invoke("detach_wallpaper").then(() => append("the mural was taken down")));

  // Stay in sync when the same state is toggled from the tray.
  await event.listen<string>("settings:mode", (e) => { mode = e.payload === "day" ? "day" : "night"; renderMode(); });
  await event.listen<boolean>("settings:interactive", (e) => { interactOn = !!e.payload; renderInteract(); });
  await event.listen<boolean>("settings:colorblind", (e) => { colorblindOn = !!e.payload; renderColorblind(); });
  await event.listen<boolean>("settings:runatstartup", (e) => { startupOn = !!e.payload; renderStartup(); });
  const attuneNote = document.getElementById("attuneNote")!;
  let attuneNoteTimer = 0;
  function showAttuneNote(reason: string) {
    // Map the technical reason (from audio.rs) to an in-world line; a bare "stopped" is
    // the user's own toggle-off, so it never shows here.
    const friendly = /device|endpoint|activate|wasapi|hresult|0x/i.test(reason)
      ? "The Atelier could not reach your speakers to listen — is sound playing?"
      : reason === "thread spawn failed"
        ? "The Atelier could not begin listening just now — try Attune again."
        : "The Atelier could not hear the music — is anything playing?";
    attuneNote.textContent = "♪ " + friendly;
    attuneNote.style.display = "block";
    clearTimeout(attuneNoteTimer);
    attuneNoteTimer = window.setTimeout(() => { attuneNote.style.display = "none"; }, 8000);
  }
  await event.listen<{ attuned: boolean; reason?: string }>("viz:source-changed", (e) => {
    attuned = !!e.payload.attuned; renderAttune();
    const reason = e.payload.reason || "";
    if (!attuned && reason && reason !== "stopped") { showAttuneNote(reason); append("attune failed: " + reason); }
    else if (attuned) { attuneNote.style.display = "none"; }
  });
  // Tower of Tomes: refresh on a new cast / secret-found; surface it on the dock click.
  await event.listen("tomes:changed", () => { void refreshTomes(); });
  await event.listen("open:tomes", () => {
    void refreshTomes();
    tomesPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    tomesPanel.classList.remove("flash"); void tomesPanel.offsetWidth; tomesPanel.classList.add("flash");
  });
  await event.listen<string>("log", (e) => append(e.payload));
  append("control ready");

  // The narrative-preview buttons are hidden by default (class `devonly`) so they can
  // never spoil a surprise for the recipient. Ctrl+Shift+D reveals them for the giver's
  // own testing; the reveal is per-session (default hidden on every launch).
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      const on = document.body.classList.toggle("dev");
      append(on ? "dev previews revealed" : "dev previews hidden");
    }
  });

  // Reveal-on-paint: the window is created hidden (so an autostart `--minimized`
  // launch boots silently to the tray). Now that every panel is built, show it
  // unless this launch should stay hidden.
  try {
    if (await invoke<boolean>("should_show_main")) {
      const w = win.getCurrentWindow();
      await w.show();
      await w.setFocus();
    }
  } catch { /* */ }
}

main();
