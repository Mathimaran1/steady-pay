// NEAR helpers: amount math (string/BigInt only, no floats), RPC views, wallet calls.
// The wallet code is large, so it is loaded on demand (see initWallet) after the page has rendered.
let core = null; // @near-wallet-selector/core, once loaded

export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || "";
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://test.rpc.fastnear.com";
// Asked at the same time; the first good answer wins (public testnet RPCs are often slow).
const RPC_URLS = [RPC_URL, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"].filter((u, i, a) => a.indexOf(u) === i);
/** Coins offered at setup. Defaults: Ref Finance's testnet USDC and USDT, which anyone can mint. */
export const TOKENS = [
  { id: import.meta.env.VITE_USDC_ID || "usdc.fakes.testnet", label: "USDC" },
  { id: import.meta.env.VITE_USDT_ID || "usdt.fakes.testnet", label: "USDT" },
];
/** Testnet "fake" tokens have a public `mint`, so the page can hand out test tokens. */
export const isMintable = (token) => !!token && token.endsWith(".fakes.testnet");
export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const EXPLORER_ACCOUNT = "https://testnet.nearblocks.io/address/";

const YOCTO_DIGITS = 24;
export const MIN_CREATE_DEPOSIT = 10n ** 22n; // 0.01 NEAR
const TGAS = 10n ** 12n;

// ---------- amounts ----------

/** "1.5" with 24 decimals -> "1500000000000000000000000". Throws on bad input. */
export function toUnits(input, decimals) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) {
    throw new Error("Enter an amount like 10 or 2.5");
  }
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  const y = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return y.toString();
}

/** "1500000000000000000000000" with 24 decimals -> "1.5" (up to `dp` decimals, trailing zeros trimmed). */
export function fromUnits(units, decimals, dp = 4) {
  const y = BigInt(units || 0);
  const one = 10n ** BigInt(decimals);
  dp = Math.min(dp, decimals);
  const whole = y / one;
  const frac = (y % one).toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  if (!frac && whole === 0n && y > 0n) return "<0." + "0".repeat(Math.max(dp - 1, 0)) + "1";
  return frac ? `${w}.${frac}` : w;
}

export const nearToYocto = (input) => toUnits(input, YOCTO_DIGITS);
export const yoctoToNear = (yocto, dp = 4) => fromUnits(yocto, YOCTO_DIGITS, dp);

export const big = (x) => BigInt(x || 0);

// ---------- views ----------

// Identical reads that are already on their way share one request.
const inFlight = new Map();
function rpc(body) {
  const key = JSON.stringify(body);
  if (!inFlight.has(key)) {
    inFlight.set(key, rpcRace(body).finally(() => setTimeout(() => inFlight.delete(key), 1500)));
  }
  return inFlight.get(key);
}

async function rpcRace(body) {
  const ask = async (url) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Network error (${res.status})`);
    return res.json();
  };
  try {
    return await Promise.any(RPC_URLS.map(ask));
  } catch (e) {
    const last = e?.errors?.at(-1);
    throw new Error("Couldn't reach NEAR testnet. Check your connection and try again. (" + (last?.message || last || e) + ")");
  }
}

export function view(method, args = {}) {
  if (!CONTRACT_ID) throw new Error("VITE_CONTRACT_ID is not set");
  return viewOn(CONTRACT_ID, method, args);
}

/** Read-only call on any contract. */
export async function viewOn(contractId, method, args = {}) {
  const json = await rpc({
    jsonrpc: "2.0",
    id: "steadypay",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  });
  if (json.error) throw new Error(cleanError(json.error.data || json.error.message || "Network error"));
  if (json.result?.error) throw new Error(cleanError(json.result.error));
  const text = new TextDecoder().decode(new Uint8Array(json.result.result));
  return text ? JSON.parse(text) : null;
}

/** Vault view; also remembered in this browser so the next page load can show it instantly. */
export async function getVault(owner) {
  const v = await view("get_vault", { owner });
  try { localStorage.setItem(`steadypay.vault:${owner}`, JSON.stringify(v)); } catch {}
  return v;
}

/** Extra-coin pockets of a vault: payments in coins other than its main coin. */
export const getPockets = (owner) => view("get_pockets", { owner });

/** The last vault view this browser saw for `owner`, or undefined. Only for showing something while fresh data loads. */
export function cachedVault(owner) {
  try {
    const s = localStorage.getItem(`steadypay.vault:${owner}`);
    return s == null ? undefined : JSON.parse(s);
  } catch { return undefined; }
}

/** NEAR balance of an account in yoctoNEAR (string), or null if the account doesn't exist. */
export async function nearBalance(accountId) {
  const json = await rpc({
    jsonrpc: "2.0", id: "steadypay", method: "query",
    params: { request_type: "view_account", finality: "optimistic", account_id: accountId },
  });
  return json.result?.amount ?? null;
}

const NEARBLOCKS_API = "https://api-testnet.nearblocks.io/v1";
const METHOD_LABEL = {
  create_vault: "Created vault", claim_salary: "Claimed salary", withdraw_tax: "Released savings",
  lower_salary: "Lowered salary", deposit: "Paid into a vault", ft_transfer_call: "Paid with tokens",
};

/**
 * This account's Steady Pay actions from the chain (via the NearBlocks indexer), newest first:
 * [{ hash, label, at (ms), ok, receivedYocto }]. receivedYocto is NEAR the vault sent back in that transaction.
 */
export async function vaultActivity(accountId) {
  const res = await fetch(`${NEARBLOCKS_API}/account/${encodeURIComponent(accountId)}/txns?per_page=100`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Activity service error (${res.status})`);
  const { txns = [] } = await res.json();
  const byHash = new Map();
  for (const r of txns) {
    const h = r.transaction_hash;
    if (!byHash.has(h)) byHash.set(h, { hash: h, label: null, at: 0, ok: null, receivedYocto: 0n, touchesVault: false });
    const e = byHash.get(h);
    const method = r.actions?.[0]?.method;
    if (r.predecessor_account_id === accountId && method && METHOD_LABEL[method]) {
      e.label = METHOD_LABEL[method];
      e.ok = r.receipt_outcome?.status ?? null;
      e.at = Number(BigInt(r.block_timestamp) / 1_000_000n);
    }
    if (r.receiver_account_id === CONTRACT_ID || r.predecessor_account_id === CONTRACT_ID) e.touchesVault = true;
    if (r.predecessor_account_id === CONTRACT_ID && r.receiver_account_id === accountId && r.actions?.[0]?.action === "TRANSFER") {
      e.receivedYocto += BigInt(Math.round(Number(r.actions_agg?.deposit || 0)).toLocaleString("fullwide", { useGrouping: false }));
    }
  }
  return [...byHash.values()].filter((e) => e.label && e.touchesVault).sort((a, b) => b.at - a.at);
}

// ---------- coins ----------

export const NEAR_COIN = { token: null, symbol: "NEAR", decimals: YOCTO_DIGITS, dp: 4 };
const coinCache = new Map();

/** { token, symbol, decimals, dp } for a token contract (null = NEAR). */
export async function getCoin(token) {
  if (!token) return NEAR_COIN;
  if (!coinCache.has(token)) {
    try { // token details never change: reuse them across page loads
      const saved = JSON.parse(localStorage.getItem(`steadypay.coin:${token}`) || "null");
      if (saved) { coinCache.set(token, Promise.resolve(saved)); return coinCache.get(token); }
    } catch {}
    coinCache.set(token, viewOn(token, "ft_metadata").then((m) => ({
      token,
      symbol: String(m.symbol || token).replace(/\.e$/, ""),
      decimals: m.decimals,
      dp: Math.min(m.decimals, 4),
    })).then((c) => { try { localStorage.setItem(`steadypay.coin:${token}`, JSON.stringify(c)); } catch {} return c; })
      .catch((e) => { coinCache.delete(token); throw e; }));
  }
  return coinCache.get(token);
}

export const ftBalance = (token, accountId) => viewOn(token, "ft_balance_of", { account_id: accountId });
/** A token contract only holds balances for accounts that paid its storage deposit. */
export const isRegistered = async (token, accountId) => !!(await viewOn(token, "storage_balance_of", { account_id: accountId }));
async function storageMin(token) {
  const b = await viewOn(token, "storage_balance_bounds").catch(() => null);
  return b?.min || "12500000000000000000000"; // 0.0125 NEAR fallback
}

// ---------- wallet ----------

let selector, modal;

let walletLoading = null;
/** Load and set up the wallet selector once; later calls reuse the same promise. */
export function initWallet() {
  walletLoading ??= loadWallet();
  return walletLoading;
}
async function loadWallet() {
  const [c, { setupModal }, { setupMeteorWallet }, { setupIntearWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/modal-ui"),
    import("@near-wallet-selector/meteor-wallet"),
    import("@near-wallet-selector/intear-wallet"),
    import("@near-wallet-selector/modal-ui/styles.css"),
  ]);
  core = c;
  selector = await core.setupWalletSelector({
    network: "testnet",
    modules: [setupMeteorWallet(), setupIntearWallet()],
  });
  modal = setupModal(selector, { contractId: CONTRACT_ID });
  return selector;
}

export function getAccountId() {
  const accounts = selector?.store.getState().accounts || [];
  return accounts.find((a) => a.active)?.accountId || accounts[0]?.accountId || null;
}

export function onAccountChange(cb) {
  selector.store.observable.subscribe(() => cb(getAccountId()));
}

export const walletReady = () => !!modal;
export const signIn = async () => {
  await initWallet(); // waits if the wallet code is still downloading
  modal.show();
};

export async function signOut() {
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/** Call a change method on the Steady Pay contract. Returns { hash } (or {} if the wallet redirected away). */
export function call(method, args, opts = {}) {
  return callActions(CONTRACT_ID, [{ method, args, ...opts }]);
}

/** Send one transaction with one or more function calls to `receiverId`. */
export async function callActions(receiverId, calls) {
  const wallet = await selector.wallet();
  if (!core) throw new Error("Wallet is still loading, try again in a moment.");
  const actions = calls.map(({ method, args, depositYocto = "0", tgas = 30 }) => core.internalActionToNaj({
    type: "FunctionCall",
    params: {
      methodName: method,
      args,
      gas: (BigInt(tgas) * TGAS).toString(),
      deposit: String(depositYocto),
    },
  }));
  const outcome = await wallet.signAndSendTransaction({
    receiverId,
    actions,
    callbackUrl: window.location.href,
  });
  if (!outcome) return {};
  const hash = outcome.transaction?.hash || outcome.transaction_outcome?.id;
  const failure = findFailure(outcome);
  if (failure) {
    const err = new Error(failure);
    err.hash = hash;
    throw err;
  }
  return { hash };
}

/** Register `accountId` with a token contract so it can hold that token (paid by the signer). */
export async function registerWithToken(token, accountId) {
  return callActions(token, [{ method: "storage_deposit", args: { account_id: accountId, registration_only: true }, depositYocto: await storageMin(token) }]);
}

/** Testnet only: register if needed and mint test tokens to `accountId`. */
export async function mintTestTokens(token, accountId, units) {
  const calls = [];
  if (!(await isRegistered(token, accountId))) {
    calls.push({ method: "storage_deposit", args: { account_id: accountId, registration_only: true }, depositYocto: await storageMin(token) });
  }
  calls.push({ method: "mint", args: { account_id: accountId, amount: units } });
  return callActions(token, calls);
}

/** Pay a token vault: ft_transfer_call to the Steady Pay contract with the owner in msg. */
export async function payWithToken(token, owner, units) {
  // The vault forwards the non-savings share of a token payment to the owner straight away. If the owner
  // isn't registered with the token yet, that forward fails (the money waits safely in the vault, but the
  // wallet reports the whole payment as failed). So register the owner in the same transaction: one approval.
  const register = (await isRegistered(token, owner).catch(() => true)) ? [] : [{
    method: "storage_deposit",
    args: { account_id: owner, registration_only: true },
    depositYocto: await storageMin(token),
  }];
  return callActions(token, [...register, {
    method: "ft_transfer_call",
    args: { receiver_id: CONTRACT_ID, amount: units, msg: owner },
    depositYocto: "1",
    tgas: 100,
  }]);
}

function findFailure(outcome) {
  const all = [outcome.status, ...(outcome.receipts_outcome || []).map((r) => r.outcome.status)];
  for (const st of all) {
    if (st && st.Failure) return cleanError(JSON.stringify(st.Failure));
  }
  return null;
}

// The page calls the contract's tax bucket "savings". Reword the few contract messages that say "tax".
const WORDING = [
  ["There is no tax money to send", "There are no savings to move"],
  ["That is more than your tax savings", "That is more than your savings"],
  ["Tax percent must be between 0 and 50", "Savings percent must be between 0 and 50"],
];
const plainWords = (msg) => WORDING.reduce((m, [a, b]) => m.replace(a, b), msg);

/** Pull the plain-English contract message out of an RPC/wallet error. */
export function cleanError(e) {
  const s = typeof e === "string" ? e : e?.message || String(e);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  if (m) return plainWords(m[1].trim());
  if (/User (rejected|cancelled|closed)/i.test(s)) return "You cancelled in your wallet.";
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

// ---------- tx history (per browser, convenience only) ----------

const TX_KEY = "steadypay.txs";
export function rememberTx(label, hash) {
  if (!hash) return;
  try {
    const list = JSON.parse(localStorage.getItem(TX_KEY) || "[]");
    list.unshift({ label, hash, at: Date.now() });
    localStorage.setItem(TX_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {}
}
export function recentTxs() {
  try {
    return JSON.parse(localStorage.getItem(TX_KEY) || "[]");
  } catch {
    return [];
  }
}
