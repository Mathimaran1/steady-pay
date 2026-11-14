import "./polyfills.js";
import "./style.css";
import {
  signIn as walletSignIn,
  CONTRACT_ID, EXPLORER_TX, EXPLORER_ACCOUNT, MIN_CREATE_DEPOSIT,
  nearToYocto, yoctoToNear, toUnits, fromUnits, big, getVault, initWallet, getAccountId, onAccountChange,
  signOut, call, cleanError, rememberTx,
  TOKENS, isMintable, NEAR_COIN, getCoin, cachedVault, getPockets, ftBalance, nearBalance, vaultActivity, isRegistered, registerWithToken, mintTestTokens, payWithToken,
} from "./near.js";
import { CHAPTERS, mountStory } from "./story.js";
import { setAmbient } from "./ambient.js";
import { mountHelper, setHelperContext } from "./helper.js";

const app = document.getElementById("app");
const PERIODS = [
  { ms: 60_000, label: "Every minute (demo)" },
  { ms: 7 * 86_400_000, label: "Every week" },
  { ms: 30 * 86_400_000, label: "Every 30 days" },
];

let me = null;        // signed-in account id
let vault = null;     // my vault view
let timer = null;     // dashboard refresh timer
let toast = null;     // { kind, text, hash }
let renderSeq = 0;    // drops stale renders when two refreshes overlap
let unmount = null;   // cleanup for the home page scroll story
let lastPageKey = null;   // hash of the page currently on screen
let payCoinChoice = null; // coin picked on the pay page: "" = NEAR, else a token contract
let walletChecked = false; // true once the wallet selector has loaded and told us who is signed in

/** Did this browser sign in before? (wallet selector keeps the chosen wallet in localStorage) */
function seemsSignedIn() {
  try { return !!localStorage.getItem("near-wallet-selector:selectedWalletId"); } catch { return false; }
}

function signIn() {
  walletSignIn().catch((e) => setToast("err", "Wallet setup failed: " + cleanError(e)));
}

// ---------- tiny helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel) => app.querySelector(sel);
const route = () => {
  const h = location.hash.replace(/^#\/?/, "");
  const [page, arg] = h.split("/");
  return { page: page || "home", arg: arg ? decodeURIComponent(arg) : null };
};
const payLink = (owner) => `${location.origin}${location.pathname}#/pay/${encodeURIComponent(owner)}`;
const periodLabel = (ms) => PERIODS.find((p) => p.ms === ms)?.label.replace(" (demo)", "") || `Every ${fmtDuration(ms)}`;

function fmtDuration(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Demo yield is tiny over minutes, so show it with more decimals than other amounts (NEAR vaults only). */
const fmtYield = (yocto) => fromUnits(yocto, 24, 10);

/** "14 Nov 2026, 01:29:25" in the viewer's local time. */
function fmtWhen(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setToast(kind, text, hash) {
  toast = { kind, text, hash };
  renderToast();
}
function renderToast() {
  const el = document.getElementById("toast");
  if (!el) return;
  if (!toast) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="toast ${toast.kind}">
    <span>${esc(toast.text)}</span>
    ${toast.hash ? `<a href="${EXPLORER_TX}${esc(toast.hash)}" target="_blank" rel="noopener">View transaction ↗</a>` : ""}
    <button class="x" aria-label="Dismiss">×</button></div>`;
  el.querySelector(".x").onclick = () => { toast = null; renderToast(); };
}

/** Run a wallet call with consistent busy state + messages. */
async function act(btn, label, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Waiting for wallet…"; }
  try {
    sessionStorage.setItem("steadypay.pending", label);
    const { hash } = await fn();
    sessionStorage.removeItem("steadypay.pending");
    rememberTx(label, hash);
    setToast("ok", `${label}: done.`, hash);
    await refresh();
  } catch (e) {
    sessionStorage.removeItem("steadypay.pending");
    if (e.hash) rememberTx(`${label} (failed)`, e.hash);
    setToast("err", cleanError(e), e.hash);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; }
  }
}

// ---------- layout ----------

const MARK = `<svg class="mark" width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
  <rect class="mark-tile" width="32" height="32" rx="7"/>
  <rect class="mark-line" x="5" y="11.5" width="22" height="9" rx="4.5" fill="none" stroke-width="2.2"/>
  <path class="mark-line" d="M11.5 13.6v4.8M20.5 13.6v4.8" stroke-width="1.6" stroke-linecap="round"/>
  <circle class="mark-bubble" cx="16" cy="16" r="2.5"/></svg>`;

function shell(inner, { bare = false } = {}) {
  const who = me ? `<span class="acct">${esc(me)}</span><button id="signout" class="ghost small">Sign out</button>`
                 : `<button id="signin" class="small">Connect wallet</button>`;
  return `
  <header class="top${bare ? " floating" : ""}"><div class="wrap">
    <a href="#/" class="brand">${MARK}<span>Steady Pay</span></a>
    <span class="net">Testnet</span>
    ${me ? `<nav class="tabs">
      <a href="#/" class="${route().page === "home" ? "on" : ""}">Dashboard</a>
      <a href="#/wallet" class="${route().page === "wallet" ? "on" : ""}">Wallet</a>
      <a href="#/activity" class="${route().page === "activity" ? "on" : ""}">Activity</a>
    </nav>` : ""}
    <div class="who">${who}</div>
  </div></header>
  ${bare ? `<div class="toast-float"><div id="toast"></div></div><main class="bare">${inner}</main>`
         : `<main><div class="wrap"><div id="toast"></div>${inner}</div></main>`}
  ${bare ? "" : `<footer><div class="wrap">
    <span>Steady Pay · a salary vault on NEAR</span>
    <span>${CONTRACT_ID ? `Vault account <a class="mono" href="${EXPLORER_ACCOUNT}${esc(CONTRACT_ID)}" target="_blank" rel="noopener">${esc(CONTRACT_ID)}</a>` : "No contract set (VITE_CONTRACT_ID)"}</span>
  </div></footer>`}`;
}

function bindShell() {
  $("#signin")?.addEventListener("click", signIn);
  $("#signout")?.addEventListener("click", async () => { await signOut(); });
  renderToast();
}

// ---------- pages ----------

// --i counts from the left, --j from the right, so letters can arrive from either side
const letters = (t) => [...t].map((ch, i, all) => `<span style="--i:${i};--j:${all.length - 1 - i}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");

function homeLoggedOut() {
  const n = CHAPTERS.length;
  return `
  <section class="story" aria-label="How Steady Pay works">
    <div class="glow" aria-hidden="true"></div>
    <canvas class="scene" aria-hidden="true"></canvas>
    <div class="track" style="height:${n * 70 + 100}vh"></div>
    <div class="overlay">
      ${CHAPTERS.map((c, i) => `
      <article class="chapter ${i % 2 ? "from-right" : "from-left"}${i === 0 ? " is-active" : ""}">
        <div class="chapter__index">${String(i + 1).padStart(2, "0")}</div>
        <h2 class="chapter__title">${letters(c.title)}</h2>
        <p class="chapter__caption">${esc(c.caption)}</p>
        ${i === n - 1 ? `<div class="chapter__cta"><button id="signin2" class="primary big">Connect wallet to start</button>
          <span>Testnet · no sign-up · no backend</span></div>` : ""}
      </article>`).join("")}
      <nav class="rail" aria-label="Chapters">
        <div class="rail__line"></div>
        ${CHAPTERS.map((c, i) => `<button style="top:${(i / (n - 1)) * 100}%" aria-label="${esc(c.title)}"><span>${esc(c.title)}</span></button>`).join("")}
        <div class="rail__cursor"><b>01</b> / ${String(n).padStart(2, "0")}</div>
      </nav>
      <div class="scroll-hint">Scroll</div>
    </div>
  </section>`;
}

function setupPage() {
  return `
  <section class="split-page">
    <div class="page-head">
      <p class="eyebrow">Step 1 of 1</p>
      <h1>Set up your vault</h1>
      <p>You do this once. The rules are enforced on chain and can't be loosened later.</p>
    </div>
    <form id="setup" class="panel">
      <label>Get paid in
        <select name="coin">
          <option value="">NEAR</option>
          ${TOKENS.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} · stablecoin</option>`).join("")}
        </select></label>
      <label>How do you want to be paid?
        <select name="mode">
          <option value="instant">Instantly · the rest goes straight to my wallet</option>
          <option value="salary">As a salary · paid out a fixed amount each payday</option>
        </select>
        <small class="muted" id="modeHint"></small></label>
      <div id="salaryFields">
      <label>Salary each payday (<span class="unit">NEAR</span>)
        <input name="salary" inputmode="decimal" placeholder="e.g. 1" value="1"></label>
      <details class="suggest">
        <summary>Not sure? Work it out from your recent income</summary>
        <p class="muted">Enter what you earned in recent months (<span class="unit">NEAR</span>). We suggest your lowest month after savings: a salary your income has always covered.</p>
        <div class="months">${[1,2,3,4,5,6].map((i) => `<input data-month inputmode="decimal" placeholder="Month ${i}">`).join("")}</div>
        <p id="suggestion" class="muted"></p>
      </details>
      <label>Payday
        <select name="period">${PERIODS.map((p) => `<option value="${p.ms}">${p.label}</option>`).join("")}</select></label>
      </div>
      <label>Savings percent (0–50)
        <input name="tax" type="number" min="0" max="50" step="1" value="30" required>
        <small class="muted">This share of every payment is locked as savings.</small></label>
      <label>Lock savings until
        <select name="unlock">
          <option value="5m">In 5 minutes (demo)</option>
          <option value="1mo">In 1 month</option>
          <option value="taxday">31 March (tax day)</option>
          <option value="1y">In 1 year</option>
          <option value="custom">Pick a date…</option>
        </select>
        <small class="muted" id="unlockHint"></small></label>
      <label id="customUnlock" hidden>Unlock date
        <input name="unlockAt" type="datetime-local"></label>
      <label id="startField">Starting money (NEAR, optional)
        <input name="start" inputmode="decimal" placeholder="0" value="">
        <small class="muted">Money you put in now, split like a client payment. Leave 0 to start empty.<br>Fees: a one-time 0.01 NEAR setup fee (stores your vault on NEAR, not refunded), plus a tiny network fee (gas) shown in your wallet.</small></label>
      <p id="tokenNote" class="muted small" hidden>Fees: a one-time 0.01 NEAR setup fee (stores your vault on NEAR, not refunded), plus a tiny network fee (gas) shown in your wallet. Add starting <span class="unit">USDC</span> afterwards by paying yourself through your pay link.</p>
      <div id="preview" class="preview"></div>
      <button class="primary big block" type="submit">Create my vault</button>
    </form>
  </section>`;
}

/** The savings unlock time (Unix ms) chosen on the setup form, or null. */
function unlockMs(f) {
  const now = new Date();
  switch (f.unlock.value) {
    case "5m": return now.getTime() + 5 * 60_000;
    case "1mo": { const d = new Date(now); d.setMonth(d.getMonth() + 1); return d.getTime(); }
    case "1y": { const d = new Date(now); d.setFullYear(d.getFullYear() + 1); return d.getTime(); }
    case "taxday": { // next 31 March, end of day
      const d = new Date(now.getFullYear(), 2, 31, 23, 59);
      if (d <= now) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
    default: { const t = new Date(f.unlockAt.value).getTime(); return Number.isFinite(t) ? t : null; }
  }
}

function bindSetup() {
  const f = $("#setup");
  const months = [...app.querySelectorAll("[data-month]")];
  let coin = NEAR_COIN;
  const units = (v) => toUnits(v, coin.decimals);
  const fmt = (x) => fromUnits(x, coin.decimals, coin.dp);
  const updateSuggest = () => {
    const vals = months.map((m) => m.value.trim()).filter(Boolean);
    const out = $("#suggestion");
    try {
      if (!vals.length) { out.textContent = ""; return; }
      const ys = vals.map((v) => big(units(v)));
      const low = ys.reduce((a, b) => (b < a ? b : a));
      const tax = BigInt(Math.max(0, Math.min(50, parseInt(f.tax.value || "0", 10))));
      const after = (low * (100n - tax)) / 100n;
      out.innerHTML = `Lowest month: <b>${fmt(low)} ${coin.symbol}</b>. After ${tax}% savings: <b>${fmt(after)} ${coin.symbol}</b>.
        <button type="button" class="ghost small" id="useSuggest">Use ${fmt(after)}</button>`;
      $("#useSuggest").onclick = () => { f.salary.value = fromUnits(after, coin.decimals, coin.decimals).replace(/,/g, ""); updatePreview(); };
    } catch (e) { out.textContent = e.message; }
  };
  const instantMode = () => f.mode.value === "instant";
  const updatePreview = () => {
    try {
      if (instantMode()) {
        const tax = BigInt(parseInt(f.tax.value || "0", 10));
        const example = 1000n * 10n ** BigInt(coin.decimals);
        const toTax = (example * tax) / 100n;
        $("#preview").innerHTML = `If a client pays <b>1,000 ${coin.symbol}</b>: <b>${fmt(toTax)}</b> is locked as savings and
          <b>${fmt(example - toTax)}</b> goes straight to your wallet.`;
        return;
      }
      const sal = big(units(f.salary.value || "0"));
      const tax = BigInt(parseInt(f.tax.value || "0", 10));
      const example = 1000n * 10n ** BigInt(coin.decimals);
      const toTax = (example * tax) / 100n, toPot = example - toTax;
      const n = sal > 0n ? toPot / sal : 0n;
      $("#preview").innerHTML = `If a client pays <b>1,000 ${coin.symbol}</b>: <b>${fmt(toTax)}</b> goes to savings and
        <b>${fmt(toPot)}</b> to your salary pot. That covers <b>${n.toLocaleString()}</b> paydays of ${fmt(sal)} ${coin.symbol}.`;
    } catch { $("#preview").textContent = ""; }
  };
  const setCoin = async () => {
    const token = f.coin.value || null;
    try { coin = await getCoin(token); } catch (e) { coin = NEAR_COIN; f.coin.value = ""; return setToast("err", "Couldn't load the token: " + cleanError(e)); }
    app.querySelectorAll(".unit").forEach((u) => (u.textContent = coin.symbol));
    $("#startField").hidden = !!token || instantMode();
    $("#tokenNote").hidden = !token;
    updatePreview(); updateSuggest();
  };
  f.coin.onchange = setCoin;
  const setMode = () => {
    const inst = instantMode();
    $("#salaryFields").hidden = inst;
    $("#startField").hidden = inst || !!coin.token;
    $("#modeHint").textContent = inst
      ? "Your savings share is locked until your date. Everything else is sent to your wallet the moment a client pays."
      : "Everything except savings waits in your salary pot. You claim the same amount each payday, even in months with no income.";
    updatePreview();
  };
  f.mode.onchange = setMode;
  setMode();
  const showUnlock = () => {
    $("#customUnlock").hidden = f.unlock.value !== "custom";
    const ms = unlockMs(f);
    $("#unlockHint").textContent = ms
      ? `Savings stay locked in the vault until ${fmtWhen(ms)}. After that you can release them back to your account.`
      : "Pick a date.";
  };
  f.unlock.onchange = showUnlock;
  f.unlockAt.oninput = showUnlock;
  showUnlock();
  months.forEach((m) => (m.oninput = updateSuggest));
  f.salary.oninput = updatePreview;
  f.tax.oninput = () => { updatePreview(); updateSuggest(); };
  updatePreview();

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    let salary, deposit, unlock;
    const token = coin.token;
    try {
      // an instant vault has no salary schedule; the contract still takes a (unused) salary and period
      salary = instantMode() ? "1" : units(f.salary.value);
      if (big(salary) === 0n) throw new Error("Salary must be more than zero");
      const start = !token && !instantMode() && f.start.value.trim() ? nearToYocto(f.start.value) : "0";
      deposit = (MIN_CREATE_DEPOSIT + big(start)).toString();
      unlock = unlockMs(f);
      if (!unlock || unlock <= Date.now()) throw new Error("Pick an unlock date in the future");
    } catch (e) { return setToast("err", e.message); }
    await act(f.querySelector("button[type=submit]"), "Create vault", () =>
      call("create_vault", {
        salary,
        period_ms: instantMode() ? 30 * 86_400_000 : Number(f.period.value),
        tax_percent: Number(f.tax.value),
        token,
        savings_unlock_ms: unlock,
        instant: instantMode(),
      }, { depositYocto: deposit }));
  };
}

function dashboard(v, coin, reg) {
  const fmt = (x) => fromUnits(x, coin.decimals, coin.dp);
  const sym = coin.symbol;
  const now = Date.now();
  const until = v.next_payday_ms - now;
  const claimable = big(v.claimable_now);
  const due = until <= 0;
  const pot = big(v.pot), tax = big(v.tax_bucket), total = pot + tax;
  const locked = v.savings_unlock_ms != null && v.savings_unlock_ms > now;
  const toSelf = v.tax_wallet === v.owner;
  const inst = !!v.instant; // instant vault: the non-savings share goes straight to the owner
  return `
  <header class="dash-head">
    <span class="dash-meta">${inst ? "Instant payouts" : "Salary vault"} · paid in ${sym}</span>
  </header>

  ${coin.token && !(reg.owner && (reg.tax || v.tax_wallet === v.owner)) ? `<section class="notice">
    <div>
      <h2>One more step before payday</h2>
      <p>The ${sym} token only pays accounts that are registered with it. Registering costs about 0.0125 NEAR, once per account.
        Until then, salary or savings sent to your account fails and stays safely in your vault.</p>
    </div>
    <div class="notice-actions">
      ${reg.owner ? "" : `<button id="regOwner" class="primary">Register my account</button>`}
      ${reg.tax || v.tax_wallet === v.owner ? "" : `<button id="regTax" class="ghost">Register savings wallet</button>`}
    </div>
  </section>` : ""}

  <section class="figures four">
    <div>
      <span class="label"><i class="dot pot"></i>${inst ? "Sent to your wallet" : "Salary pot"}</span>
      <span class="figure">${fmt(inst ? v.total_salary_paid : v.pot)}<small>${sym}</small></span>
      <span class="sub">${inst ? "So far, straight on every payment" : `Covers ${v.periods_covered} more payday${v.periods_covered === 1 ? "" : "s"}`}</span>
    </div>
    <div>
      <span class="label"><i class="dot tax"></i>Savings</span>
      <span class="figure">${fmt(v.tax_bucket)}<small>${sym}</small></span>
      <span class="sub">${locked ? `Locked until ${fmtWhen(v.savings_unlock_ms)}`
        : toSelf ? "Unlocked · release any time" : `Only to <a href="${EXPLORER_ACCOUNT}${esc(v.tax_wallet)}" target="_blank" rel="noopener">${esc(v.tax_wallet)}</a>`}</span>
      ${v.yield_apy_bps && tax > 0n ? `<span class="yield-line">
        <span class="yield-amt">+<span id="yieldNow" class="mono">${fmtYield(v.yield_earned)}</span> ${sym}</span>
        <span class="yield-rate">${v.yield_apy_bps / 100}% APY yield <span class="demo-tag">demo</span></span>
      </span>` : ""}
    </div>
    ${inst ? `<div>
      <span class="label">Payout</span>
      <span class="figure">Instant</span>
      <span class="sub">Straight to your wallet on every payment</span>
    </div>
    <div>
      <span class="label">Savings share</span>
      <span class="figure">${v.tax_percent}<small>%</small></span>
      <span class="sub">Of every payment, locked as savings</span>
    </div>` : `<div>
      <span class="label">Next payday</span>
      <span class="figure ${due ? "due" : ""}" id="countdown">${due ? "Today" : fmtDuration(until)}</span>
      <span class="sub">${fmtWhen(v.next_payday_ms)}</span>
    </div>
    <div>
      <span class="label">Salary</span>
      <span class="figure">${fmt(v.salary)}<small>${sym}</small></span>
      <span class="sub">${periodLabel(v.period_ms)} · ${v.tax_percent}% to savings</span>
    </div>`}
  </section>



  <section class="cols even">
    <div class="panel">
      ${inst ? `<div class="block-item">
        <h2>Payments</h2>
        ${pot > 0n
          ? `<p>A payment couldn't be sent to your wallet automatically, so it's waiting safely in the vault.</p>
             <div class="claim-amt">${fmt(v.pot)} <small>${sym}</small></div>
             <button id="claim" class="primary big block">Collect it</button>`
          : `<p>Every payment is split on arrival: ${v.tax_percent}% is locked as savings and the rest is sent straight to your wallet. Nothing to claim.</p>`}
      </div>` : `<div class="block-item">
        <h2>Payday</h2>
        ${due && claimable > 0n
          ? `<p>Ready to claim${v.periods_owed > 1 ? ` (${v.periods_owed} paydays)` : ""}.</p>
             <div class="claim-amt">${fmt(claimable)} <small>${sym}</small></div>`
          : due ? `<p>Payday is here, but your salary pot is empty.</p><div class="claim-amt">0 <small>${sym}</small></div>`
                : pot === 0n ? `<p>Your salary pot is empty. Share your pay link: paydays resume as soon as a client pays.</p>
                   <div class="claim-amt">0 <small>${sym}</small></div>`
                : `<p>Your next salary unlocks in <span id="countdown2" class="mono">${fmtDuration(until)}</span>.</p>
                   <div class="claim-amt">${fmt(v.salary)} <small>${sym}</small></div>`}
        <button id="claim" class="primary big block" ${due && claimable > 0n ? "" : "disabled"}>Claim salary</button>
      </div>`}
      ${inst ? "" : `<div class="block-item">
        <h2>Lower salary</h2>
        <p>Make the pot last longer. You can't raise it again.</p>
        <div class="row"><input id="newSalary" inputmode="decimal" placeholder="New salary (${sym})">
          <button id="lower" class="ghost">Lower</button></div>
      </div>`}
    </div>
    <div class="panel">
      <div class="block-item">
        <h2>${toSelf ? "Release savings" : "Move savings"}</h2>
        ${locked
          ? `<p>Locked in the vault until <b>${fmtWhen(v.savings_unlock_ms)}</b>. Unlocks in <span id="unlockIn" class="mono">${fmtDuration(v.savings_unlock_ms - now)}</span>. Nobody can move it before then, not even you.</p>`
          : `<p>${toSelf ? "Sends your savings back to your account" : `Moves money to ${esc(v.tax_wallet)}`}${v.yield_apy_bps ? ", plus the demo yield they earned" : ""}. Leave empty to send all of it.</p>`}
        <div class="row"><input id="taxAmt" inputmode="decimal" placeholder="All (${fmt(v.tax_bucket)} ${sym})" ${locked ? "disabled" : ""}>
          <button id="withdrawTax" class="ghost" ${tax > 0n && !locked ? "" : "disabled"}>${toSelf ? "Release" : "Send"}</button></div>
      </div>
      <div class="block-item">
        <h2>Pay link</h2>
        <p>Send this to clients. They pay with any NEAR wallet and the split happens on arrival.</p>
        <div class="row"><input id="link" readonly value="${esc(payLink(v.owner))}"><button id="copy" class="ghost">Copy</button></div>
        ${isMintable(coin.token) ? `<p class="muted small" style="margin-top:12px">Testing? <button id="mint" class="ghost small">Get 100 test ${sym}</button> then pay yourself through the link.</p>` : ""}
      </div>

    </div>
  </section>`;
}

/** "Other coins" card: payments the vault got in coins other than its main coin. */
function pocketsCard(v, pockets) {
  if (!pockets?.length) return "";
  const locked = v.savings_unlock_ms != null && v.savings_unlock_ms > Date.now();
  return `
  <section class="panel pockets">
    <div class="block-item">
      <h2>Other coins</h2>
      <p>Clients paid you in these too. ${v.tax_percent}% of each payment is locked as savings${locked ? ` until ${fmtWhen(v.savings_unlock_ms)}` : ""}; the rest went straight to your wallet.</p>
      <table class="act-table">
        <thead><tr><th>Coin</th><th class="r">Received</th><th class="r">Savings</th><th class="r">Waiting</th><th class="r"></th></tr></thead>
        <tbody>${pockets.map((p, i) => {
          const f = (x) => fromUnits(x, p.meta.decimals, p.meta.dp);
          const can = BigInt(p.waiting) > 0n || (!locked && BigInt(p.savings) > 0n);
          return `<tr>
            <td>${esc(p.meta.symbol)}</td>
            <td class="r mono">${f(p.received)}</td>
            <td class="r mono">${f(p.savings)}${locked && BigInt(p.savings) > 0n ? ` <span class="demo-tag">locked</span>` : ""}</td>
            <td class="r mono">${f(p.waiting)}</td>
            <td class="r"><button class="ghost small" data-pocket="${i}" ${can ? "" : "disabled"}>${BigInt(p.waiting) > 0n && locked ? "Collect" : "Release"}</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
  </section>`;
}

function bindPockets(pockets) {
  app.querySelectorAll("button[data-pocket]").forEach((b) => (b.onclick = (e) => {
    const p = pockets[Number(b.dataset.pocket)];
    act(e.currentTarget, `Release ${p.meta.symbol}`, () => call("release_pocket", { coin: p.coin }, { tgas: 50 }));
  }));
}

function bindDashboard(v, coin) {
  const units = (x) => toUnits(x, coin.decimals);
  $("#regOwner")?.addEventListener("click", (e) => act(e.currentTarget, `Register with ${coin.symbol}`, () => registerWithToken(coin.token, v.owner)));
  $("#regTax")?.addEventListener("click", (e) => act(e.currentTarget, `Register savings wallet with ${coin.symbol}`, () => registerWithToken(coin.token, v.tax_wallet)));
  $("#mint")?.addEventListener("click", (e) => act(e.currentTarget, `Get test ${coin.symbol}`, () => mintTestTokens(coin.token, me, units("100"))));
  $("#claim")?.addEventListener("click", (e) => act(e.currentTarget, v.instant ? "Collect payment" : "Claim salary", () => call("claim_salary", {}, { tgas: 50 })));
  $("#withdrawTax").onclick = (e) => {
    let amount = null;
    try { if ($("#taxAmt").value.trim()) amount = units($("#taxAmt").value); } catch (err) { return setToast("err", err.message); }
    act(e.currentTarget, v.tax_wallet === v.owner ? "Release savings" : "Move savings", () => call("withdraw_tax", { amount }, { tgas: 50 }));
  };
  if ($("#lower")) $("#lower").onclick = (e) => {
    let new_salary;
    try { new_salary = units($("#newSalary").value); } catch (err) { return setToast("err", err.message); }
    act(e.currentTarget, "Lower salary", () => call("lower_salary", { new_salary }));
  };
  $("#copy").onclick = async (e) => {
    const btn = e.currentTarget, input = $("#link");
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; }
    catch {
      input.select();
      try { ok = document.execCommand("copy"); } catch {}
    }
    btn.textContent = ok ? "Copied ✓" : "Press Ctrl+C";
    setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy"; }, 2000);
  };
  const viewedAt = Date.now();
  const tick = () => {
    const y = $("#yieldNow");
    if (y && v.yield_apy_bps) {
      const ms = BigInt(Math.max(0, Date.now() - viewedAt));
      const grown = (big(v.tax_bucket) * BigInt(v.yield_apy_bps) * ms) / (10_000n * 31_536_000_000n);
      y.textContent = fmtYield(big(v.yield_earned) + grown);
    }
    const left = v.next_payday_ms - Date.now();
    const c = $("#countdown"), c2 = $("#countdown2");
    if (c) c.textContent = left <= 0 ? "Today" : fmtDuration(left);
    if (c2) c2.textContent = fmtDuration(left);
    if (!v.instant && left <= 0 && $("#claim")?.disabled && big(v.pot) > 0n) refresh(); // payday arrived: re-read
    const u = $("#unlockIn");
    if (u) {
      const ul = v.savings_unlock_ms - Date.now();
      if (ul <= 0) refresh(); else u.textContent = fmtDuration(ul); // savings unlocked: re-read
    }
  };
  timer = setInterval(tick, 1000);
}

/** The activity table on the wallet page (or a message when it's empty or failed). */
function activityTable(activity, activityError) {
  return `${activityError ? `<p class="muted">Couldn't load activity right now (${esc(activityError)}). <button id="retryAct" class="ghost small">Try again</button></p>`
        : !activity.length ? `<p class="muted">No Steady Pay activity yet.</p>`
        : `<table class="act-table">
          <thead><tr><th>What</th><th>When</th><th class="r">You received</th><th>Status</th><th class="r">Transaction</th></tr></thead>
          <tbody>${activity.map((a) => `<tr>
            <td>${esc(a.label)}</td>
            <td class="mono">${fmtWhen(a.at)}</td>
            <td class="r mono">${a.receivedYocto > 0n ? `${yoctoToNear(a.receivedYocto)} NEAR` : "—"}</td>
            <td>${a.ok === false ? `<span class="bad">Failed</span>` : `<span class="good">Done</span>`}</td>
            <td class="r"><a class="mono" href="${EXPLORER_TX}${esc(a.hash)}" target="_blank" rel="noopener">${esc(a.hash.slice(0, 8))}… ↗</a></td>
          </tr>`).join("")}</tbody></table>`}`;
}

function activityPage() {
  return `
  <header class="dash-head">
    <span class="dash-meta">From the NEAR blockchain</span>
  </header>
  <section class="panel">
    <div class="block-item">
      <h2>Your Steady Pay actions</h2>
      <div id="activityBody"><p class="muted">Loading activity from the blockchain…</p></div>
      <p class="muted small" style="margin-top:14px">Shows actions you signed (create, claim, release, lower salary, payments you made). Payments clients send you are counted on the <a href="#/wallet">Wallet</a> page. Token payouts (USDC/USDT) show in your wallet balance.</p>
    </div>
  </section>`;
}

function walletPage(data) {
  const { v, coin, balances } = data;
  const fmtV = (x) => fromUnits(x, coin.decimals, coin.dp);
  const sym = coin.symbol;
  const lockedUntil = v?.savings_unlock_ms && v.savings_unlock_ms > Date.now() ? v.savings_unlock_ms : null;
  const cell = (b) => `<div>
      <span class="label"><i class="coin-dot ${b.cls}"></i>${b.label}</span>
      <span class="figure">${b.value == null ? "—" : fromUnits(b.value, b.decimals, 4)}<small>${b.label}</small></span>
      <span class="sub">${b.note}</span>
    </div>`;
  const held = v ? big(v.pot) + big(v.tax_bucket) : 0n;
  return `
  <header class="dash-head">
    <span class="dash-meta">${esc(me)}</span>
  </header>

  <section class="figures four">
    ${balances.map(cell).join("")}
    <div>
      <span class="label"><i class="dot tax"></i>In Steady Pay</span>
      <span class="figure">${v ? fmtV(held) : "—"}<small>${sym}</small></span>
      <span class="sub">${v ? "Salary pot + savings" : `<a href="#/">Set up a vault</a>`}</span>
    </div>
  </section>

  ${v ? `<section class="cols even">
    <div class="panel">
      <div class="block-item">
        <h2>Held now</h2>
        <ul class="ledger">
          <li><span>Salary pot</span><span class="num">${fmtV(v.pot)} ${sym}</span></li>
          <li><span>Savings${lockedUntil ? ` <span class="demo-tag">locked</span>` : ""}</span><span class="num">${fmtV(v.tax_bucket)} ${sym}</span></li>
          <li><span>Savings unlock</span><span class="num">${v.savings_unlock_ms ? fmtWhen(v.savings_unlock_ms) : "Any time"}</span></li>
          <li><span>Demo yield owed${v.yield_apy_bps ? ` <span class="demo-tag">${v.yield_apy_bps / 100}% APY</span>` : ""}</span><span class="num">${v.yield_apy_bps ? `${fmtYield(v.yield_earned)} ${sym}` : "—"}</span></li>
        </ul>
      </div>
    </div>
    <div class="panel">
      <div class="block-item">
        <h2>All time</h2>
        <ul class="ledger">
          <li><span>Received from clients</span><span class="num">${fmtV(v.total_received)} ${sym}</span></li>
          <li><span>${v.instant ? "Sent to your wallet" : "Salary paid to you"}</span><span class="num">${fmtV(v.total_salary_paid)} ${sym}</span></li>
          <li><span>Savings released</span><span class="num">${fmtV(v.total_tax_withdrawn)} ${sym}</span></li>
          <li><span>Demo yield paid</span><span class="num">${v.yield_apy_bps ? `${fmtYield(v.yield_paid)} ${sym}` : "—"}</span></li>
        </ul>
      </div>
    </div>
  </section>` : ""}`;
}

function payPage(owner, v, coin, balance) {
  if (!v) return `<section class="split-page"><div class="page-head"><p class="eyebrow">Pay link</p><h1>Nothing here</h1>
    <p>No Steady Pay vault found for <span class="mono">${esc(owner)}</span>. Check the link.</p></div></section>`;
  const sym = coin.symbol;
  const canMint = me && isMintable(coin.token);
  return `
  <section class="split-page">
    <div class="page-head">
      <p class="eyebrow">Pay link</p>
      <h1>Pay <span class="h1-acct">${esc(owner)}</span></h1>
      <p>Pay in NEAR, USDC or USDT on NEAR testnet. Your payment goes straight into their Steady Pay vault.</p>
    </div>
    <form id="payForm" class="panel">
      <label>Pay with
        <select name="coin">${[{ id: "", label: "NEAR" }, ...TOKENS].map((t) => `<option value="${esc(t.id)}" ${(coin.token || "") === t.id ? "selected" : ""}>${esc(t.label)}${(v.token || "") === t.id ? " · their main coin" : ""}</option>`).join("")}</select></label>
      <label>Amount (${sym})<input name="amount" inputmode="decimal" required placeholder="10"></label>
      ${coin.token && me ? `<p class="muted small balance-line">Your balance: <span class="mono">${balance == null ? "0" : fromUnits(balance, coin.decimals, coin.dp)} ${sym}</span>
        ${canMint ? `<button type="button" id="mint" class="ghost small">Get 100 test ${sym}</button>` : ""}</p>` : ""}
      ${me ? `<button class="primary big block" type="submit">Pay ${esc(owner)}</button>`
           : `<button class="primary big block" type="button" id="signin3">Connect wallet to pay</button>`}
    </form>
  </section>`;
}

function bindPay(owner, v, coin) {
  if (!v) return;
  $("#signin3")?.addEventListener("click", signIn);
  $("#mint")?.addEventListener("click", (e) => act(e.currentTarget, `Get test ${coin.symbol}`, () => mintTestTokens(coin.token, me, toUnits("100", coin.decimals))));
  const f = $("#payForm");
  f.coin.onchange = () => { payCoinChoice = f.coin.value; refresh(); };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    let amt;
    try { amt = toUnits(f.amount.value, coin.decimals); } catch (e) { return setToast("err", e.message); }
    await act(f.querySelector("button[type=submit]"), `Pay ${owner}`, () =>
      coin.token ? payWithToken(coin.token, owner, amt) : call("deposit", { owner }, { depositYocto: amt, tgas: 50 }));
  };
}

// ---------- render loop ----------

async function refresh() {
  clearInterval(timer);
  if (unmount) { unmount(); unmount = null; }
  document.body.classList.remove("on-landing");
  // Changing page: clear the old one straight away instead of leaving it frozen while data loads.
  const pageKey = location.hash || "#/";
  if (pageKey !== lastPageKey) payCoinChoice = null; // a new pay link starts on its main coin
  if (pageKey !== lastPageKey && app.innerHTML) {
    app.innerHTML = shell(`<p class="loading">Loading…</p>`);
    bindShell();
  }
  lastPageKey = pageKey;
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  const { page, arg } = route();
  if (!CONTRACT_ID) {
    app.innerHTML = shell(`<section class="narrow page-head"><h1>Not configured</h1><p>Set <code>VITE_CONTRACT_ID</code> and rebuild.</p></section>`);
    return bindShell();
  }
  try {
    if (page === "wallet" && me) {
      setAmbient({ c: 0, x: 2.6, scale: 0.7, y: 1.3 });
      const [v, near, ...tok] = await Promise.all([
        getVault(me), nearBalance(me).catch(() => null),
        ...TOKENS.map((t) => ftBalance(t.id, me).catch(() => null)),
      ]);
      const [coin, metas] = await Promise.all([
        getCoin(v?.token),
        Promise.all(TOKENS.map((t) => getCoin(t.id).catch(() => ({ decimals: 6 })))),
      ]);
      if (stale()) return;
      const balances = [
        { label: "NEAR", value: near, decimals: 24, cls: "near", note: "In your wallet" },
        ...TOKENS.map((t, i) => ({ label: t.label, value: tok[i] ?? "0", decimals: metas[i].decimals, cls: "stable", note: "In your wallet · test token" })),
      ];
      setHelperContext({ me, v, coin, fmt: (x) => fromUnits(x, coin.decimals, coin.dp), fmtWhen });
      app.innerHTML = shell(walletPage({ v, coin, balances }));
      bindShell();
      return;
    }
    if (page === "activity" && me) {
      setAmbient({ c: 0, x: 2.6, scale: 0.7, y: 1.3 });
      app.innerHTML = shell(activityPage());
      bindShell();
      const act = await vaultActivity(me).then((a) => ({ a }), (e) => ({ e: cleanError(e) }));
      if (stale()) return;
      const body = $("#activityBody");
      if (body) body.innerHTML = activityTable(act.a || [], act.e);
      $("#retryAct")?.addEventListener("click", refresh);
      return;
    }
    if (page === "pay" && arg) {
      const v = await getVault(arg);
      const chosen = payCoinChoice ?? (v?.token || "");
      const [coin, balance] = await Promise.all([
        getCoin(chosen || null),
        chosen && me ? ftBalance(chosen, me).catch(() => null) : null,
      ]);
      if (stale()) return;
      setAmbient({ c: 0, x: 2.4, scale: 1.05 });
      app.innerHTML = shell(payPage(arg, v, coin, balance));
      bindShell(); bindPay(arg, v, coin);
      return;
    }
    if (!me && !walletChecked && seemsSignedIn()) {
      // A returning user: wait for the wallet instead of flashing the logged-out home story.
      app.innerHTML = shell(`<p class="loading">Loading your vault…</p>`);
      bindShell();
      return;
    }
    if (!me) {
      document.body.classList.add("on-landing"); // no robot or chat on the landing page
      setHelperContext({ me: null, v: null });
      setAmbient(null);
      app.innerHTML = shell(homeLoggedOut(), { bare: true });
      bindShell(); $("#signin2").onclick = signIn;
      unmount = mountStory($(".story"));
      return;
    }
    // Show the last known numbers straight away (NEAR vaults; token vaults need extra checks), then refresh.
    const early = cachedVault(me);
    if (early && !early.token && !document.querySelector(".figures") && !stale()) {
      setAmbient({ c: 2, x: 2.2, scale: 0.85, y: 1.1 });
      app.innerHTML = shell(dashboard(early, NEAR_COIN, {}));
      bindShell(); bindDashboard(early, NEAR_COIN);
    }
    const v = await getVault(me);
    clearInterval(timer);
    const pocketsP = v ? getPockets(me).then((list) => Promise.all((list || []).map(async (p) => ({ ...p, meta: await getCoin(p.coin) })))).catch(() => []) : [];
    const [coin, regOwner, regTax, pockets] = await Promise.all([
      getCoin(v?.token),
      v?.token ? isRegistered(v.token, v.owner) : null,
      v?.token && v.tax_wallet !== v.owner ? isRegistered(v.token, v.tax_wallet) : true,
      pocketsP,
    ]);
    const reg = { owner: regOwner, tax: regTax };
    if (stale()) return;
    vault = v;
    setHelperContext({ me, v, coin, fmt: (x) => fromUnits(x, coin.decimals, coin.dp), fmtWhen });
    // dashboard: your vault with its savings ring; setup: the plain sphere
    setAmbient(vault ? { c: 2, x: 2.2, scale: 0.85, y: 1.1 } : { c: 0, x: 2.4, scale: 1.05 });
    app.innerHTML = shell(vault ? dashboard(vault, coin, reg) + pocketsCard(vault, pockets) : setupPage());
    bindShell();
    vault ? (bindDashboard(vault, coin), bindPockets(pockets)) : bindSetup();
  } catch (e) {
    if (stale()) return;
    app.innerHTML = shell(`<section class="narrow page-head"><h1>Couldn't load</h1><p>${esc(cleanError(e))}</p><p style="margin-top:20px"><button id="retry">Try again</button></p></section>`);
    bindShell(); $("#retry").onclick = refresh;
  }
}

function handleRedirectReturn() {
  // Redirect-style wallets come back with ?transactionHashes=... or ?errorCode=...
  const q = new URLSearchParams(location.search);
  const label = sessionStorage.getItem("steadypay.pending") || "Transaction";
  sessionStorage.removeItem("steadypay.pending");
  if (q.get("transactionHashes")) {
    const hash = q.get("transactionHashes").split(",").pop();
    rememberTx(label, hash);
    toast = { kind: "ok", text: `${label}: sent. Check the transaction for the result.`, hash };
  } else if (q.get("errorCode")) {
    toast = { kind: "err", text: decodeURIComponent(q.get("errorMessage") || q.get("errorCode")) };
  }
  if (q.toString()) history.replaceState(null, "", location.pathname + location.hash);
}

// After a new deploy the old code chunks are gone; reload once to pick up the new ones.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  try {
    if (sessionStorage.getItem("steadypay.reloaded")) return;
    sessionStorage.setItem("steadypay.reloaded", "1");
  } catch {}
  location.reload();
});
setTimeout(() => { try { sessionStorage.removeItem("steadypay.reloaded"); } catch {} }, 10_000);

(async () => {
  mountHelper();
  handleRedirectReturn();
  window.addEventListener("hashchange", refresh);
  app.innerHTML = `<p class="loading">Loading…</p>`;
  // Render straight away (pay page and home don't need the wallet), then again once the wallet is ready.
  refresh();
  try {
    await initWallet();
    me = getAccountId();
    onAccountChange((id) => { if (id !== me) { me = id; refresh(); } });
  } catch (e) {
    console.error(e);
    toast = { kind: "err", text: "Wallet setup failed: " + cleanError(e) };
  }
  walletChecked = true;
  refresh();
})();
