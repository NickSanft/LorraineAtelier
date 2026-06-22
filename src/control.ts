// Control window: the Atelier's settings panel. Toggles drive Rust commands and
// stay in sync with the tray (which can toggle the same state). The Spell Bindings
// panel edits the persisted sigil→app mappings.
const logEl = document.getElementById("log")!;
function append(line: string) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${line}\n` + logEl.textContent;
}

const modeBtn = document.getElementById("mode") as HTMLButtonElement;
const attuneBtn = document.getElementById("attune") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const interactBtn = document.getElementById("interact") as HTMLButtonElement;
const colorblindBtn = document.getElementById("colorblind") as HTMLButtonElement;
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

interface SettingsDto {
  mode: string;
  pauseOnFullscreen: boolean;
  desktopInteractive: boolean;
  mappings: Record<string, string>;
  discovered: Record<string, number>;
  secretFound: boolean;
  firstRun: boolean;
  colorblind: boolean;
  buddySprite: string;
}

async function main() {
  let core: typeof import("@tauri-apps/api/core");
  let event: typeof import("@tauri-apps/api/event");
  try {
    core = await import("@tauri-apps/api/core");
    event = await import("@tauri-apps/api/event");
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
    buildBindings(s.mappings || {});
    buildTomes(s);
    if (s.firstRun) {
      const wp = document.getElementById("welcomePanel")!;
      wp.style.display = "flex";
      document.getElementById("welcomeBegin")!.addEventListener("click", () => {
        wp.style.display = "none";
        invoke("dismiss_welcome").then(() => append("welcome dismissed"));
      });
    }
  } catch (e) {
    append("get_settings ✗ " + e);
  }
  try { attuned = !!(await invoke<boolean>("viz_status")); } catch { /* */ }
  renderMode(); renderAttune(); renderPause(); renderInteract(); renderColorblind();

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

  document.getElementById("resetBindings")!.addEventListener("click", async () => {
    await invoke("reset_mappings");
    const s = await invoke<SettingsDto>("get_settings");
    buildBindings(s.mappings || {});
    append("bindings reset to defaults");
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

  document.getElementById("preview")!.addEventListener("click", () => invoke("preview_storybook").then(() => append("previewing dedication")));
  document.getElementById("previewSilver")!.addEventListener("click", () => invoke("preview_silvereve").then(() => append("previewing Silver Eve")));

  document.getElementById("reattach")!.addEventListener("click", () => invoke("reattach_wallpaper").then(() => append("re-attach requested")));
  document.getElementById("overlay")!.addEventListener("click", () => invoke("toggle_overlay"));
  document.getElementById("detach")!.addEventListener("click", () => invoke("detach_wallpaper").then(() => append("detached")));

  // Stay in sync when the same state is toggled from the tray.
  await event.listen<string>("settings:mode", (e) => { mode = e.payload === "day" ? "day" : "night"; renderMode(); });
  await event.listen<boolean>("settings:interactive", (e) => { interactOn = !!e.payload; renderInteract(); });
  await event.listen<boolean>("settings:colorblind", (e) => { colorblindOn = !!e.payload; renderColorblind(); });
  await event.listen<{ attuned: boolean }>("viz:source-changed", (e) => { attuned = !!e.payload.attuned; renderAttune(); });
  // Tower of Tomes: refresh on a new cast / secret-found; surface it on the dock click.
  await event.listen("tomes:changed", () => { void refreshTomes(); });
  await event.listen("open:tomes", () => {
    void refreshTomes();
    tomesPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    tomesPanel.classList.remove("flash"); void tomesPanel.offsetWidth; tomesPanel.classList.add("flash");
  });
  await event.listen<string>("log", (e) => append(e.payload));
  append("control ready");
}

main();
