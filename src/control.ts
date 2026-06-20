// Control window: a tiny dev harness for Slice 1. Buttons invoke Rust
// commands; a "log" event stream from Rust is mirrored into the panel.
const logEl = document.getElementById("log")!;

function append(line: string) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${line}\n` + logEl.textContent;
}

async function tauri() {
  // Dynamically imported so this page still renders in a plain browser preview.
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  return { core, event };
}

async function main() {
  let core: typeof import("@tauri-apps/api/core");
  let event: typeof import("@tauri-apps/api/event");
  try {
    ({ core, event } = await tauri());
  } catch {
    append("(running outside Tauri — buttons are inert)");
    return;
  }

  const invoke = (cmd: string) =>
    core.invoke(cmd).then(
      (r) => append(`${cmd} → ${r ?? "ok"}`),
      (e) => append(`${cmd} ✗ ${e}`),
    );

  document.getElementById("reattach")!.addEventListener("click", () => invoke("reattach_wallpaper"));
  document.getElementById("overlay")!.addEventListener("click", () => invoke("toggle_overlay"));
  document.getElementById("detach")!.addEventListener("click", () => invoke("detach_wallpaper"));

  await event.listen<string>("log", (e) => append(e.payload));
  append("control window ready");
  invoke("get_status");
}

main();
