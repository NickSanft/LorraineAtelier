// Control window: the Atelier's settings panel. Toggles drive Rust commands and
// stay in sync with the tray (which can toggle the same state).
const logEl = document.getElementById("log")!;
function append(line: string) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${line}\n` + logEl.textContent;
}

const modeBtn = document.getElementById("mode") as HTMLButtonElement;
const attuneBtn = document.getElementById("attune") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;

let mode: "day" | "night" = "night";
let attuned = false;
let pauseOn = false;

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

  try {
    const s = await invoke<{ mode: string; pauseOnFullscreen: boolean }>("get_settings");
    mode = s.mode === "day" ? "day" : "night";
    pauseOn = !!s.pauseOnFullscreen;
  } catch (e) {
    append("get_settings ✗ " + e);
  }
  try { attuned = !!(await invoke<boolean>("viz_status")); } catch { /* */ }
  renderMode(); renderAttune(); renderPause();

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

  document.getElementById("reattach")!.addEventListener("click", () => invoke("reattach_wallpaper").then(() => append("re-attach requested")));
  document.getElementById("overlay")!.addEventListener("click", () => invoke("toggle_overlay"));
  document.getElementById("detach")!.addEventListener("click", () => invoke("detach_wallpaper").then(() => append("detached")));

  // Stay in sync when the same state is toggled from the tray.
  await event.listen<string>("settings:mode", (e) => { mode = e.payload === "day" ? "day" : "night"; renderMode(); });
  await event.listen<{ attuned: boolean }>("viz:source-changed", (e) => { attuned = !!e.payload.attuned; renderAttune(); });
  await event.listen<string>("log", (e) => append(e.payload));
  append("control ready");
}

main();
