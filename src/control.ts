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
const bindingsEl = document.getElementById("bindings")!;

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

interface SettingsDto { mode: string; pauseOnFullscreen: boolean; desktopInteractive: boolean; mappings: Record<string, string> }

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
      g.className = "bg"; g.textContent = el.glyph; g.style.color = el.hue;
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

  try {
    const s = await invoke<SettingsDto>("get_settings");
    mode = s.mode === "day" ? "day" : "night";
    pauseOn = !!s.pauseOnFullscreen;
    interactOn = !!s.desktopInteractive;
    buildBindings(s.mappings || {});
  } catch (e) {
    append("get_settings ✗ " + e);
  }
  try { attuned = !!(await invoke<boolean>("viz_status")); } catch { /* */ }
  renderMode(); renderAttune(); renderPause(); renderInteract();

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

  document.getElementById("resetBindings")!.addEventListener("click", async () => {
    await invoke("reset_mappings");
    const s = await invoke<SettingsDto>("get_settings");
    buildBindings(s.mappings || {});
    append("bindings reset to defaults");
  });

  document.getElementById("preview")!.addEventListener("click", () => invoke("preview_storybook").then(() => append("previewing dedication")));

  document.getElementById("reattach")!.addEventListener("click", () => invoke("reattach_wallpaper").then(() => append("re-attach requested")));
  document.getElementById("overlay")!.addEventListener("click", () => invoke("toggle_overlay"));
  document.getElementById("detach")!.addEventListener("click", () => invoke("detach_wallpaper").then(() => append("detached")));

  // Stay in sync when the same state is toggled from the tray.
  await event.listen<string>("settings:mode", (e) => { mode = e.payload === "day" ? "day" : "night"; renderMode(); });
  await event.listen<boolean>("settings:interactive", (e) => { interactOn = !!e.payload; renderInteract(); });
  await event.listen<{ attuned: boolean }>("viz:source-changed", (e) => { attuned = !!e.payload.attuned; renderAttune(); });
  await event.listen<string>("log", (e) => append(e.payload));
  append("control ready");
}

main();
