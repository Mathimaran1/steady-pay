// "Steady" helper: a small chat bot in the corner. It is rule-based, not AI: it matches the
// question to a topic and answers from built-in text plus the signed-in user's live vault data.

let ctx = { me: null, v: null, coin: null, fmt: null, fmtWhen: null }; // set by main.js on every render
export function setHelperContext(next) { ctx = { ...ctx, ...next }; }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function money(x) { return ctx.v && ctx.fmt ? `${ctx.fmt(x)} ${ctx.coin?.symbol || "NEAR"}` : ""; }

function dur(ms) {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.round(h / 24)} days`;
}

/** Topics: keywords to match and an answer (string or function of the live context). */
const TOPICS = [
  {
    id: "balance", chip: "My balance",
    words: ["balance", "how much", "have", "pot", "money", "total"],
    answer: () => {
      const { v } = ctx;
      if (!ctx.me) return "Connect your wallet and I can tell you exactly what's in your vault.";
      if (!v) return "You don't have a vault yet. Fill in the setup form on the Dashboard to create one.";
      return v.instant
        ? `So far ${money(v.total_salary_paid)} has been sent straight to your wallet. Your locked savings: ${money(v.tax_bucket)}.`
        : `Your salary pot holds ${money(v.pot)} (covers ${v.periods_covered} more payday${v.periods_covered === 1 ? "" : "s"}). Your savings: ${money(v.tax_bucket)}.`;
    },
  },
  {
    id: "claim", chip: "Can I claim?",
    words: ["claim", "payday", "salary", "paid", "when do i get"],
    answer: () => {
      const { v } = ctx;
      if (!v) return "Once you have a vault, you claim your salary on the Dashboard every payday.";
      if (v.instant) return "Your vault is instant: there's nothing to claim. The non-savings part of every payment goes straight to your wallet.";
      const left = v.next_payday_ms - Date.now();
      if (BigInt(v.claimable_now) > 0n) return `Yes! You can claim ${money(v.claimable_now)} now. Press "Claim salary" on the Dashboard.`;
      if (BigInt(v.pot) === 0n) return "Your salary pot is empty, so there's nothing to claim. Share your pay link; paydays resume once a client pays.";
      return `Not yet. Your next payday is in ${dur(left)} (${ctx.fmtWhen(v.next_payday_ms)}). You'll get ${money(v.salary)}.`;
    },
  },
  {
    id: "unlock", chip: "When do savings unlock?",
    words: ["unlock", "savings", "locked", "release", "withdraw"],
    answer: () => {
      const { v } = ctx;
      if (!v) return "When you create a vault you pick a date. Your savings stay locked until then; after that you release them back to your account.";
      if (!v.savings_unlock_ms) return `Your savings (${money(v.tax_bucket)}) have no date lock. You can release them any time.`;
      const left = v.savings_unlock_ms - Date.now();
      return left > 0
        ? `Your savings (${money(v.tax_bucket)}) unlock in ${dur(left)}, on ${ctx.fmtWhen(v.savings_unlock_ms)}. Nobody can move them before then, not even you.`
        : `Your savings are unlocked. Press "Release" on the Dashboard to get ${money(v.tax_bucket)} back${v.yield_apy_bps ? " plus the demo yield" : ""}.`;
    },
  },
  {
    id: "yield", chip: "What is the yield?",
    words: ["yield", "apy", "interest", "earn"],
    answer: () => "Savings in NEAR vaults earn a demo yield of 8% a year, counted every second and paid with your savings when you release them. It's a demo: the yield comes from a reserve the Steady Pay team tops up, not from staking. USDC and USDT vaults don't earn yield yet.",
  },
  {
    id: "paylink", chip: "How do clients pay me?",
    words: ["client", "pay me", "link", "invoice", "send money", "receive"],
    answer: () => ctx.v
      ? `Copy your pay link on the Dashboard and send it to your client. They open it, connect any NEAR wallet and pay. ${ctx.v.tax_percent}% goes to your savings automatically.`
      : "After you create a vault you get a pay link. Clients open it, connect their NEAR wallet and pay. The split happens automatically.",
  },
  {
    id: "modes", chip: "Instant vs salary",
    words: ["instant", "mode", "difference", "salary vault"],
    answer: () => "Instant: your savings share is locked and the rest goes straight to your wallet on every payment. Salary: the rest waits in a salary pot and you claim the same amount every payday, so quiet months still pay.",
  },
  {
    id: "fees", chip: "Fees",
    words: ["fee", "gas", "cost", "price"],
    answer: () => "Steady Pay takes no cut. Creating a vault costs a one-time 0.01 NEAR setup fee (it stores your vault on NEAR). Every action also has a tiny network fee (gas), shown in your wallet before you approve.",
  },
  {
    id: "safe", chip: "Is it safe?",
    words: ["safe", "secure", "trust", "scam", "risk", "hack"],
    answer: () => "The rules live in the vault's code on NEAR: your money can only go to you, savings can't move before your date, and nobody else can touch your vault. It's a testnet demo and not audited, so use test money only.",
  },
  {
    id: "coins", chip: "Which coins?",
    words: ["usdc", "usdt", "coin", "token", "stablecoin", "near"],
    answer: () => "Each vault is paid in one coin you pick at setup: NEAR, USDC or USDT (testnet versions). For USDC or USDT you register your account with the token once, and you can grab free test tokens with the 'Get 100 test' button.",
  },
];

const HELLO = "Hi, I'm Steady. I can tell you your balance, when you can claim, when your savings unlock, and how Steady Pay works.";

function answerFor(text) {
  const q = text.toLowerCase();
  let best = null, score = 0;
  for (const t of TOPICS) {
    const s = t.words.reduce((n, w) => n + (q.includes(w) ? w.length : 0), 0);
    if (s > score) { best = t; score = s; }
  }
  if (!best) return "I'm a simple helper, so I didn't catch that. Try one of the buttons below, or ask about your balance, payday, savings, yield, fees or pay link.";
  const a = best.answer;
  return typeof a === "function" ? a() : a;
}

/** A short tip for the speech bubble, from the live vault when we have one. */
const pick = (list) => list[Math.floor(Math.random() * list.length)];


/** Moves the character around the screen, makes its eyes follow the pointer, blinks and talks. */
function animateBuddy(root, isOpen) {
  const buddy = root.querySelector(".buddy");
  const bubble = root.querySelector(".buddy-bubble");
  const eyes = root.querySelector(".b-eyes");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SIZE = 80, M = 24;
  const home = () => ({ x: innerWidth - SIZE - M, y: innerHeight - SIZE - M - 96 }); // above the chat button
  const saved = (() => { try { return JSON.parse(localStorage.getItem("steadypay.buddy")); } catch { return null; } })();
  const clampPos = (p) => ({ x: Math.max(0, Math.min(innerWidth - SIZE, p.x)), y: Math.max(64, Math.min(innerHeight - SIZE, p.y)) });
  let pos = saved ? clampPos({ x: saved.x * innerWidth, y: saved.y * innerHeight }) : home();
  let target = { ...pos }, vx = 0, vy = 0, mx = innerWidth / 2, my = innerHeight / 2;

  // pick a spot near the edges, where it won't sit on top of the content

  let bubbleTimer = 0;
  const talk = (text, ms = 3200) => {
    bubble.textContent = text;
    buddy.classList.add("talking");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => buddy.classList.remove("talking"), ms);
  };

  addEventListener("pointermove", (e) => { mx = e.clientX; my = e.clientY; }, { passive: true });
  addEventListener("resize", () => { target = clampPos(target); });

  // ---- drag: hold and move it anywhere; it stays where you drop it for a while ----
  const body = root.querySelector(".buddy-body");
  let drag = null, justDragged = false;
  body.style.touchAction = "none";
  body.addEventListener("pointerdown", (e) => {
    drag = { id: e.pointerId, ox: e.clientX - pos.x, oy: e.clientY - pos.y, sx: e.clientX, sy: e.clientY, moved: false, lx: e.clientX, ly: e.clientY };
    body.setPointerCapture(e.pointerId);
  });
  body.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
      drag.moved = true;
      buddy.classList.add("dragging");
    }
    if (!drag.moved) return;
    vx = (e.clientX - drag.lx) * 0.6; vy = (e.clientY - drag.ly) * 0.6;
    drag.lx = e.clientX; drag.ly = e.clientY;
    pos.x = Math.max(0, Math.min(innerWidth - SIZE, e.clientX - drag.ox));
    pos.y = Math.max(64, Math.min(innerHeight - SIZE, e.clientY - drag.oy));
    target = { ...pos };
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 50);
      buddy.classList.remove("dragging");
      target = { ...pos };
      try { localStorage.setItem("steadypay.buddy", JSON.stringify({ x: pos.x / innerWidth, y: pos.y / innerHeight })); } catch {}
    }
    drag = null;
  };
  body.addEventListener("pointerup", endDrag);
  body.addEventListener("pointercancel", endDrag);

  const frame = (now) => {
    if (drag?.moved) {
      buddy.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      buddy.style.setProperty("--tilt", `${Math.max(-25, Math.min(25, vx * 3))}deg`);
      vx *= 0.85;
      requestAnimationFrame(frame);
      return;
    }
    // springy movement
    vx = (vx + (target.x - pos.x) * 0.012) * 0.86;
    vy = (vy + (target.y - pos.y) * 0.012) * 0.86;
    pos.x += vx; pos.y += vy;
    const tilt = Math.max(-14, Math.min(14, vx * 2.2));
    buddy.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    buddy.style.setProperty("--tilt", `${tilt}deg`);
    buddy.classList.toggle("left-side", pos.x < innerWidth / 2);
    // eyes look at the pointer
    const cx = pos.x + SIZE / 2, cy = pos.y + SIZE / 2;
    const a = Math.atan2(my - cy, mx - cx), d = Math.min(1, Math.hypot(mx - cx, my - cy) / 200);
    const ex = Math.cos(a) * 4 * d, ey = Math.sin(a) * 3 * d;
    eyes.setAttribute("transform", `translate(${ex.toFixed(2)} ${ey.toFixed(2)})`);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // blink now and then
  const blink = () => {
    buddy.classList.add("blink");
    setTimeout(() => buddy.classList.remove("blink"), 140);
    setTimeout(blink, 2500 + Math.random() * 4000);
  };
  setTimeout(blink, 2000);

  // say something every so often
  // click: a random trick and a random line
  const TRICKS = ["trick-spin", "trick-jump", "trick-wiggle", "trick-flip", "trick-happy"];
  const react = () => {
    if (justDragged) return; // a drag isn't a click
    TRICKS.forEach((t) => buddy.classList.remove(t));
    void buddy.offsetWidth; // restart the animation
    const t = pick(TRICKS);
    buddy.classList.add(t);
    setTimeout(() => buddy.classList.remove(t), 1000);
    // hop to a new spot right after the trick
  };
  return { talk, react };
}

export function mountHelper() {
  const root = document.createElement("div");
  root.className = "helper";
  root.innerHTML = `
    <div class="buddy" aria-hidden="true">
      <div class="buddy-bubble"></div>
      <button class="helper-fab buddy-body" aria-label="Steady the robot: click me">
        <svg viewBox="0 0 100 120" width="80" height="96" aria-hidden="true">
          <defs>
            <radialGradient id="bShell" cx="35%" cy="28%" r="80%">
              <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#ece8e1"/><stop offset="1" stop-color="#b9b2a6"/>
            </radialGradient>
            <linearGradient id="bVisor" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#2a2b33"/><stop offset="1" stop-color="#0b0c10"/>
            </linearGradient>
            <radialGradient id="bPod" cx="40%" cy="35%" r="70%">
              <stop offset="0" stop-color="#ffd9a8"/><stop offset=".6" stop-color="#ff9f3d"/><stop offset="1" stop-color="#b8611a"/>
            </radialGradient>
            <filter id="bGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          <!-- antenna -->
          <line x1="50" y1="14" x2="50" y2="5" stroke="#b9b2a6" stroke-width="2.4" stroke-linecap="round"/>
          <circle class="b-ant" cx="50" cy="5" r="4" fill="url(#bPod)" filter="url(#bGlow)"/>
          <!-- left arm (resting) -->
          <g class="b-arm-l"><path d="M30 80 q-10 6 -11 17" stroke="#8d877c" stroke-width="5" fill="none" stroke-linecap="round"/>
            <circle cx="19" cy="98" r="5.2" fill="url(#bShell)"/></g>
          <!-- right arm (waving) -->
          <g class="b-arm-r"><path d="M70 78 q12 -4 15 -16" stroke="#8d877c" stroke-width="5" fill="none" stroke-linecap="round"/>
            <circle cx="85" cy="60" r="5.6" fill="url(#bShell)"/>
            <path d="M81 56 l-2 -5 M85 54.5 l0 -5.5 M89 56 l2 -5" stroke="#b9b2a6" stroke-width="2" stroke-linecap="round"/></g>
          <!-- body -->
          <ellipse cx="50" cy="94" rx="20" ry="18" fill="url(#bShell)"/>
          <ellipse cx="50" cy="96" rx="7" ry="5" fill="#16150f" opacity=".85"/>
          <circle class="b-core" cx="50" cy="96" r="2.4" fill="#ffb35c" filter="url(#bGlow)"/>
          <!-- ear pods -->
          <rect x="9" y="34" width="10" height="20" rx="5" fill="url(#bPod)"/>
          <rect x="81" y="34" width="10" height="20" rx="5" fill="url(#bPod)"/>
          <!-- head -->
          <rect x="14" y="14" width="72" height="62" rx="28" fill="url(#bShell)"/>
          <path d="M24 26 q12 -9 30 -9" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".9"/>
          <!-- face screen -->
          <rect x="22" y="28" width="56" height="38" rx="18" fill="url(#bVisor)"/>
          <ellipse cx="38" cy="34" rx="9" ry="2.6" fill="#fff" opacity=".12"/>
          <g class="b-eyes" filter="url(#bGlow)">
            <ellipse class="b-eye" cx="40" cy="45" rx="4.6" ry="6" fill="#ffd9a8"/>
            <ellipse class="b-eye" cx="60" cy="45" rx="4.6" ry="6" fill="#ffd9a8"/>
          </g>
          <path class="b-mouth" d="M43 56 q7 5 14 0" stroke="#ffb35c" stroke-width="2.6" fill="none" stroke-linecap="round" filter="url(#bGlow)"/>
        </svg>
      </button>
      <span class="buddy-shadow"></span>
    </div>
    <button class="chat-fab" aria-label="Open Steady chat" aria-expanded="false">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9" cy="10.5" r="1.3" fill="#d9822b"/><circle cx="15" cy="10.5" r="1.3" fill="#d9822b"/></svg>
    </button>
    <section class="helper-panel" role="dialog" aria-label="Steady helper" hidden>
      <header>
        <div><b>Steady</b><span>Helper · answers from your vault · not AI</span></div>
        <button class="helper-close" aria-label="Close">×</button>
      </header>
      <div class="helper-log" aria-live="polite"></div>
      <div class="helper-chips">${TOPICS.slice(0, 6).map((t) => `<button data-topic="${t.id}">${esc(t.chip)}</button>`).join("")}</div>
      <form class="helper-form"><input placeholder="Ask about your vault…" aria-label="Your question" autocomplete="off"><button aria-label="Send">→</button></form>
    </section>`;
  document.body.append(root);

  const fab = root.querySelector(".helper-fab");
  const chatFab = root.querySelector(".chat-fab");
  const panel = root.querySelector(".helper-panel");
  const log = root.querySelector(".helper-log");
  const input = root.querySelector(".helper-form input");

  const say = (who, text) => {
    const el = document.createElement("p");
    el.className = `msg ${who}`;
    el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
  };
  const ask = (q, topic) => {
    say("me", q);
    const t = TOPICS.find((x) => x.id === topic);
    const reply = t ? (typeof t.answer === "function" ? t.answer() : t.answer) : answerFor(q);
    setTimeout(() => say("bot", reply), 250);
  };

  const buddy = animateBuddy(root, () => !panel.hidden);

  const toggle = (open) => {
    panel.hidden = !open;
    chatFab.setAttribute("aria-expanded", String(open));
    root.classList.toggle("open", open);
    if (open && !log.childElementCount) say("bot", HELLO);
    if (open) input.focus();
  };
  fab.onclick = () => buddy.react(); // the robot does a trick; the chat button opens the chat
  chatFab.onclick = () => toggle(panel.hidden);
  root.querySelector(".helper-close").onclick = () => toggle(false);
  root.querySelector(".helper-chips").onclick = (e) => {
    const b = e.target.closest("button[data-topic]");
    if (b) ask(b.textContent, b.dataset.topic);
  };
  root.querySelector(".helper-form").onsubmit = (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    ask(q);
  };
}
