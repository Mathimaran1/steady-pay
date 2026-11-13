// The live 3D vault behind the app pages (setup, dashboard, pay link).
// One canvas, created once and kept, so dashboard refreshes don't restart it.
// The 3D engine is loaded on demand the first time it is needed.

let canvas = null, scene = null, loading = null, raf = 0, mode = null, t0 = 0;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

let lastFrame = 0;
function loop(now) {
  if (!mode || !scene) { raf = 0; return; }
  // ~30 frames a second is plenty for a slow background, and halves the work
  if (now - lastFrame < 30) { raf = requestAnimationFrame(loop); return; }
  lastFrame = now;
  // fade back a little as the page scrolls, so text below stays easy to read
  canvas.style.setProperty("--fade", String(1 - Math.min(1, scrollY / 600) * 0.55));
  scene.render(mode.c, now - t0, reduce);
  raf = reduce ? 0 : requestAnimationFrame(loop);
}

async function ensureScene() {
  if (scene || !canvas) return scene;
  loading ??= import("./scene.js").then(({ createScene }) => {
    scene = createScene(canvas, { particles: 5000 }); // lighter than the home story
    if (!scene) return null;
    t0 = performance.now();
    addEventListener("resize", () => scene.resize(canvas.clientWidth, canvas.clientHeight));
    if (!reduce) addEventListener("pointermove", (e) => scene.pointer(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5), { passive: true });
    return scene;
  });
  return loading;
}

/**
 * Show the vault behind the page, or hide it with `null`.
 * `c` is the story chapter whose shape to show (0 = sphere, 2 = sphere with savings ring);
 * `x`, `scale`, `y` place it on wide screens.
 */
export async function setAmbient(next) {
  mode = next; // the latest request wins, even if an earlier one is still loading
  if (!next) {
    canvas?.classList.remove("on");
    return;
  }
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "ambient";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
  }
  if (!(await ensureScene())) return;
  if (mode !== next) return; // the page changed while the 3D engine was loading
  scene.place(next.x, next.scale, next.y);
  scene.resize(canvas.clientWidth, canvas.clientHeight);
  canvas.classList.add("on");
  if (!raf) raf = requestAnimationFrame(loop);
}
