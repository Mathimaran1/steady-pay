import "./polyfills.js";
import "./style.css";
import {
  signIn as walletSignIn,
  CONTRACT_ID, EXPLORER_TX, EXPLORER_ACCOUNT, MIN_CREATE_DEPOSIT,
  nearToYocto, yoctoToNear, big, getVault, initWallet, getAccountId, onAccountChange,
  signOut, call, cleanError, rememberTx, recentTxs,
} from "./near.js";

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

function signIn() {
  try { walletSignIn(); } catch (e) { setToast("err", e.message); }
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

function shell(inner) {
  return `
  <header class="top">
    <a href="#/" class="brand"><span class="logo">∿</span> Steady Pay</a>
    <span class="tagline">A salary for people who don't have one.</span>
    <div class="who">
      ${me ? `<span class="acct">${esc(me)}</span><button id="signout" class="ghost">Sign out</button>`
           : `<button id="signin">Connect wallet</button>`}
    </div>
  </header>
  <div id="toast"></div>
  <main>${inner}</main>
  <footer>Testnet only · ${CONTRACT_ID ? `Vault: <a href="${EXPLORER_ACCOUNT}${esc(CONTRACT_ID)}" target="_blank" rel="noopener">${esc(CONTRACT_ID)}</a>` : "No contract set (VITE_CONTRACT_ID)"}</footer>`;
}

function bindShell() {
  $("#signin")?.addEventListener("click", signIn);
  $("#signout")?.addEventListener("click", async () => { await signOut(); });
  renderToast();
}

// ---------- pages ----------

function homeLoggedOut() {
  return `
  <section class="hero">
    <h1>Get paid in lumps.<br><em>Live on a salary.</em></h1>
    <p>Clients pay you whenever they pay. Steady Pay sets your tax aside the moment money lands,
       keeps the rest in a salary pot, and pays you the same amount every payday — even in quiet months.</p>
    <button id="signin2" class="big">Connect wallet to start</button>
  </section>
  <section class="steps">
    <div class="step"><b>1</b><h3>Set up once</h3><p>Pick a salary, a tax percent and a tax wallet.</p></div>
    <div class="step"><b>2</b><h3>Share your pay link</h3><p>Clients pay you through it.</p></div>
    <div class="step"><b>3</b><h3>Auto split</h3><p>Tax goes to locked tax savings, the rest to your salary pot.</p></div>
    <div class="step"><b>4</b><h3>Claim every payday</h3><p>Same salary each period until the pot runs out.</p></div>
  </section>
  <section class="rules">
    <div><h4>🔒 Tax is safe</h4><p>Tax savings can only go to your tax wallet.</p></div>
    <div><h4>↓ Salary only goes down</h4><p>You can lower your salary, never raise it.</p></div>
    <div><h4>🪙 No overspending</h4><p>You can only take your fixed salary from the pot.</p></div>
  </section>`;
}

function setupPage() {
  return `
  <section class="card narrow">
    <h2>Set up your salary</h2>
    <p class="muted">You do this once. Rules are enforced on chain and cannot be loosened later.</p>
    <form id="setup">
      <label>Salary each payday (NEAR)
        <input name="salary" inputmode="decimal" required placeholder="e.g. 1" value="1"></label>
      <details class="suggest">
        <summary>Not sure? Suggest a salary from your recent income</summary>
        <p class="muted">Enter what you earned in recent months (NEAR). We suggest your lowest month after tax — a salary your income has always covered.</p>
        <div class="months">${[1,2,3,4,5,6].map((i) => `<input data-month inputmode="decimal" placeholder="Month ${i}">`).join("")}</div>
        <p id="suggestion" class="muted"></p>
      </details>
      <label>Payday
        <select name="period">${PERIODS.map((p) => `<option value="${p.ms}">${p.label}</option>`).join("")}</select></label>
      <label>Tax percent <span class="muted">(0–50)</span>
        <input name="tax" type="number" min="0" max="50" step="1" value="30" required></label>
      <label>Tax wallet <span class="muted">(where tax savings can go — nowhere else)</span>
        <input name="taxWallet" required placeholder="e.g. mytax.testnet" autocomplete="off"></label>
      <label>Starting money (NEAR, optional)
        <input name="start" inputmode="decimal" placeholder="0" value="">
        <small class="muted">0.01 NEAR is kept to pay for storage. Anything you add here is split like a client payment.</small></label>
      <div id="preview" class="preview"></div>
      <button class="big" type="submit">Create my salary vault</button>
    </form>
  </section>`;
}

function bindSetup() {
  const f = $("#setup");
  const months = [...app.querySelectorAll("[data-month]")];
  const updateSuggest = () => {
    const vals = months.map((m) => m.value.trim()).filter(Boolean);
    const out = $("#suggestion");
    try {
      if (!vals.length) { out.textContent = ""; return; }
      const ys = vals.map((v) => big(nearToYocto(v)));
      const low = ys.reduce((a, b) => (b < a ? b : a));
      const tax = BigInt(Math.max(0, Math.min(50, parseInt(f.tax.value || "0", 10))));
      const after = (low * (100n - tax)) / 100n;
      out.innerHTML = `Lowest month: <b>${yoctoToNear(low)} NEAR</b> → after ${tax}% tax: <b>${yoctoToNear(after)} NEAR</b>.
        <button type="button" class="ghost small" id="useSuggest">Use ${yoctoToNear(after)}</button>`;
      $("#useSuggest").onclick = () => { f.salary.value = yoctoToNear(after, 24).replace(/,/g, ""); updatePreview(); };
    } catch (e) { out.textContent = e.message; }
  };
  const updatePreview = () => {
    try {
      const sal = big(nearToYocto(f.salary.value || "0"));
      const tax = BigInt(parseInt(f.tax.value || "0", 10));
      const example = 1000n * 10n ** 24n;
      const toTax = (example * tax) / 100n, toPot = example - toTax;
      const months = sal > 0n ? toPot / sal : 0n;
      $("#preview").innerHTML = `Example: a client pays <b>1,000 NEAR</b> → <b>${yoctoToNear(toTax)}</b> to tax savings,
        <b>${yoctoToNear(toPot)}</b> to your salary pot → <b>${months.toLocaleString()}</b> paydays of ${yoctoToNear(sal)} NEAR.`;
    } catch { $("#preview").textContent = ""; }
  };
  months.forEach((m) => (m.oninput = updateSuggest));
  f.salary.oninput = updatePreview;
  f.tax.oninput = () => { updatePreview(); updateSuggest(); };
  updatePreview();

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    let salary, deposit;
    try {
      salary = nearToYocto(f.salary.value);
      if (big(salary) === 0n) throw new Error("Salary must be more than zero");
      deposit = (MIN_CREATE_DEPOSIT + big(f.start.value.trim() ? nearToYocto(f.start.value) : "0")).toString();
    } catch (e) { return setToast("err", e.message); }
    await act(f.querySelector("button[type=submit]"), "Create vault", () =>
      call("create_vault", {
        salary,
        period_ms: Number(f.period.value),
        tax_percent: Number(f.tax.value),
        tax_wallet: f.taxWallet.value.trim(),
      }, { depositYocto: deposit }));
  };
}

function dashboard(v) {
  const now = Date.now();
  const until = v.next_payday_ms - now;
  const claimable = big(v.claimable_now);
  const due = until <= 0;
  const txs = recentTxs();
  return `
  <section class="grid">
    <div class="card stat pot">
      <span class="label">Salary pot</span>
      <span class="value">${yoctoToNear(v.pot)} <small>NEAR</small></span>
      <span class="muted">Covers <b>${v.periods_covered}</b> more payday${v.periods_covered === 1 ? "" : "s"}</span>
    </div>
    <div class="card stat tax">
      <span class="label">Tax savings 🔒</span>
      <span class="value">${yoctoToNear(v.tax_bucket)} <small>NEAR</small></span>
      <span class="muted">Only to <a href="${EXPLORER_ACCOUNT}${esc(v.tax_wallet)}" target="_blank" rel="noopener">${esc(v.tax_wallet)}</a></span>
    </div>
    <div class="card stat payday">
      <span class="label">Next payday</span>
      <span class="value" id="countdown">${due ? "Today!" : fmtDuration(until)}</span>
      <span class="muted">${new Date(v.next_payday_ms).toLocaleString()}</span>
    </div>
    <div class="card stat salary">
      <span class="label">Your salary</span>
      <span class="value">${yoctoToNear(v.salary)} <small>NEAR</small></span>
      <span class="muted">${periodLabel(v.period_ms)} · ${v.tax_percent}% to tax</span>
    </div>
  </section>

  <section class="grid two">
    <div class="card">
      <h3>Get paid</h3>
      ${due && claimable > 0n
        ? `<p>You can claim <b>${yoctoToNear(claimable)} NEAR</b>${v.periods_owed > 1 ? ` (${v.periods_owed} paydays)` : ""}.</p>`
        : due ? `<p class="muted">Payday is here but your salary pot is empty.</p>`
              : `<p class="muted">Your next salary unlocks in <span id="countdown2">${fmtDuration(until)}</span>.</p>`}
      <button id="claim" class="big" ${due && claimable > 0n ? "" : "disabled"}>Claim salary</button>
      <hr>
      <h3>Send tax savings</h3>
      <p class="muted">Moves money from tax savings to ${esc(v.tax_wallet)}. Leave empty to send all.</p>
      <div class="row"><input id="taxAmt" inputmode="decimal" placeholder="All (${yoctoToNear(v.tax_bucket)})">
        <button id="withdrawTax" ${big(v.tax_bucket) > 0n ? "" : "disabled"}>Send to tax wallet</button></div>
      <hr>
      <h3>Lower salary</h3>
      <p class="muted">Make the pot last longer. You can't raise it again.</p>
      <div class="row"><input id="newSalary" inputmode="decimal" placeholder="New salary (NEAR)">
        <button id="lower" class="ghost">Lower salary</button></div>
    </div>
    <div class="card">
      <h3>Your pay link</h3>
      <p class="muted">Send this to clients. They pay with any NEAR wallet; the split happens automatically.</p>
      <div class="row"><input id="link" readonly value="${esc(payLink(v.owner))}"><button id="copy" class="ghost">Copy</button></div>
      <hr>
      <h3>So far</h3>
      <ul class="totals">
        <li><span>Received from clients</span><b>${yoctoToNear(v.total_received)} NEAR</b></li>
        <li><span>Salary paid to you</span><b>${yoctoToNear(v.total_salary_paid)} NEAR</b></li>
        <li><span>Tax sent to tax wallet</span><b>${yoctoToNear(v.total_tax_withdrawn)} NEAR</b></li>
      </ul>
      ${txs.length ? `<hr><h3>Recent activity <span class="muted small">(this browser)</span></h3>
      <ul class="txs">${txs.slice(0, 8).map((t) => `<li><span>${esc(t.label)}</span>
        <a href="${EXPLORER_TX}${esc(t.hash)}" target="_blank" rel="noopener">${esc(t.hash.slice(0, 8))}… ↗</a></li>`).join("")}</ul>` : ""}
    </div>
  </section>`;
}

function bindDashboard(v) {
  $("#claim").onclick = (e) => act(e.currentTarget, "Claim salary", () => call("claim_salary", {}, { tgas: 50 }));
  $("#withdrawTax").onclick = (e) => {
    let amount = null;
    try { if ($("#taxAmt").value.trim()) amount = nearToYocto($("#taxAmt").value); } catch (err) { return setToast("err", err.message); }
    act(e.currentTarget, "Send tax savings", () => call("withdraw_tax", { amount }, { tgas: 50 }));
  };
  $("#lower").onclick = (e) => {
    let new_salary;
    try { new_salary = nearToYocto($("#newSalary").value); } catch (err) { return setToast("err", err.message); }
    act(e.currentTarget, "Lower salary", () => call("lower_salary", { new_salary }));
  };
  $("#copy").onclick = async (e) => {
    try { await navigator.clipboard.writeText($("#link").value); e.currentTarget.textContent = "Copied"; }
    catch { $("#link").select(); }
  };
  const tick = () => {
    const left = v.next_payday_ms - Date.now();
    const c = $("#countdown"), c2 = $("#countdown2");
    if (c) c.textContent = left <= 0 ? "Today!" : fmtDuration(left);
    if (c2) c2.textContent = fmtDuration(left);
    if (left <= 0 && $("#claim")?.disabled && big(v.pot) > 0n) refresh(); // payday arrived: re-read
  };
  timer = setInterval(tick, 1000);
}

function payPage(owner, v) {
  if (!v) return `<section class="card narrow"><h2>Pay ${esc(owner)}</h2>
    <p>No Steady Pay vault found for <b>${esc(owner)}</b>. Check the link.</p></section>`;
  return `
  <section class="card narrow">
    <h2>Pay ${esc(owner)}</h2>
    <p class="muted">Your payment goes into ${esc(owner)}'s Steady Pay vault on NEAR testnet.
      ${v.tax_percent}% is set aside for their taxes, the rest funds their salary.</p>
    <form id="payForm">
      <label>Amount (NEAR)<input name="amount" inputmode="decimal" required placeholder="e.g. 10"></label>
      <div id="split" class="preview"></div>
      ${me ? `<button class="big" type="submit">Pay ${esc(owner)}</button>`
           : `<button class="big" type="button" id="signin3">Connect wallet to pay</button>`}
    </form>
  </section>`;
}

function bindPay(owner, v) {
  if (!v) return;
  $("#signin3")?.addEventListener("click", signIn);
  const f = $("#payForm");
  const upd = () => {
    try {
      const a = big(nearToYocto(f.amount.value || "0"));
      const t = (a * BigInt(v.tax_percent)) / 100n;
      $("#split").innerHTML = a > 0n ? `→ <b>${yoctoToNear(t)} NEAR</b> to tax savings · <b>${yoctoToNear(a - t)} NEAR</b> to salary pot` : "";
    } catch { $("#split").textContent = ""; }
  };
  f.amount.oninput = upd;
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    let amt;
    try { amt = nearToYocto(f.amount.value); } catch (e) { return setToast("err", e.message); }
    await act(f.querySelector("button[type=submit]"), `Pay ${owner}`, () => call("deposit", { owner }, { depositYocto: amt }));
  };
}

// ---------- render loop ----------

async function refresh() {
  clearInterval(timer);
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  const { page, arg } = route();
  if (!CONTRACT_ID) {
    app.innerHTML = shell(`<section class="card narrow"><h2>Not configured</h2><p>Set <code>VITE_CONTRACT_ID</code> and rebuild.</p></section>`);
    return bindShell();
  }
  try {
    if (page === "pay" && arg) {
      const v = await getVault(arg);
      if (stale()) return;
      app.innerHTML = shell(payPage(arg, v));
      bindShell(); bindPay(arg, v);
      return;
    }
    if (!me) {
      app.innerHTML = shell(homeLoggedOut());
      bindShell(); $("#signin2").onclick = signIn;
      return;
    }
    const v = await getVault(me);
    if (stale()) return;
    vault = v;
    app.innerHTML = shell(vault ? dashboard(vault) : setupPage());
    bindShell();
    vault ? bindDashboard(vault) : bindSetup();
  } catch (e) {
    if (stale()) return;
    app.innerHTML = shell(`<section class="card narrow"><h2>Couldn't load</h2><p>${esc(cleanError(e))}</p><button id="retry">Try again</button></section>`);
    bindShell(); $("#retry").onclick = refresh;
  }
}

function handleRedirectReturn() {
  // Redirect wallets (MyNearWallet) come back with ?transactionHashes=... or ?errorCode=...
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

(async () => {
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
  refresh();
})();
