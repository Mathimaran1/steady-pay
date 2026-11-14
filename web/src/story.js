// Scroll story for the home page. Text chapters on top, a WebGL particle scene behind
// (see scene.js). `mountStory(root)` returns a cleanup function.

export const CHAPTERS = [
  { title: "Income", caption: "Clients pay whenever they pay, in NEAR, USDC or USDT. Every payment lands in your vault on NEAR." },
  { title: "The Split", caption: "The moment it arrives, a share is set aside as savings." },
  { title: "Savings", caption: "Your savings stay locked until the date you choose, earning a demo yield while they wait. Not even you can touch them early." },
  { title: "The Pot", caption: "The rest waits in your salary pot. You can only take your salary." },
  { title: "Payday", caption: "The same amount, every period. Lower it if you need to. Never raise it." },
  { title: "Quiet Months", caption: "Even when no one pays, payday still comes." },
  { title: "Steady", caption: "A salary for people who don't have one." },
];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export function mountStory(root) {
  const canvas = root.querySelector(".scene");
  const glow = root.querySelector(".glow");
  const track = root.querySelector(".track");
  const chapters = [...root.querySelectorAll(".chapter")];
  const ticks = [...root.querySelectorAll(".rail button")];
  const cursor = root.querySelector(".rail__cursor b");
  const hint = root.querySelector(".scroll-hint");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const N = chapters.length;
  let scene = null; // the 3D scene loads in the background; the text works without it
  import("./scene.js").then(({ createScene }) => {
    if (!alive) return;
    scene = createScene(canvas);
    scene?.resize(canvas.clientWidth, canvas.clientHeight);
  });
  let raf = 0, active = -1, alive = true, smooth = 0;
  const t0 = performance.now();

  /** Scroll position in chapter units: 0 at the top, N-1 at the last chapter. */
  const chapterPos = () => {
    const max = track.offsetHeight - innerHeight;
    return clamp(scrollY / Math.max(1, max)) * (N - 1);
  };

  function setActive(i) {
    if (i === active) return;
    active = i;
    chapters.forEach((el, k) => el.classList.toggle("is-active", k === i));
    ticks.forEach((el, k) => el.classList.toggle("is-active", k === i));
    if (cursor) cursor.textContent = String(i + 1).padStart(2, "0");
  }

  function frame(now) {
    const target = chapterPos();
    smooth += (target - smooth) * (reduce ? 1 : 0.08); // eased scroll, feels heavier
    if (Math.abs(target - smooth) < 0.0005) smooth = target;
    setActive(Math.round(target));
    if (hint) hint.style.opacity = String(1 - clamp(target / 0.3));
    if (glow) {
      glow.style.setProperty("--glow", String(0.5 + 0.25 * clamp((smooth - 3.5) / 2.5)));
      // the warm glow follows the design from side to side
      const wideScreen = innerWidth >= 900;
      glow.style.setProperty("--gx", `${wideScreen ? 50 + 11 * Math.cos(Math.PI * smooth) : 50}%`);
    }
    scene?.render(smooth, now - t0, reduce);
    if (alive) raf = requestAnimationFrame(frame);
  }

  const onResize = () => scene?.resize(canvas.clientWidth, canvas.clientHeight);
  const onMove = (e) => scene?.pointer(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5);
  ticks.forEach((b, k) => (b.onclick = () => {
    const max = track.offsetHeight - innerHeight;
    scrollTo({ top: (k / (N - 1)) * max, behavior: reduce ? "auto" : "smooth" });
  }));

  onResize();
  addEventListener("resize", onResize);
  if (!reduce) addEventListener("pointermove", onMove, { passive: true });
  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    removeEventListener("resize", onResize);
    removeEventListener("pointermove", onMove);
    scene?.dispose();
    scene = null;
  };
}
