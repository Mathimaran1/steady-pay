// NEAR helpers: amount math (string/BigInt only, no floats), RPC views, wallet calls.
import { setupWalletSelector, internalActionToNaj } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import "@near-wallet-selector/modal-ui/styles.css";

export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || "";
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.testnet.near.org";
// Tried in order if the main RPC is slow or down.
const RPC_URLS = [RPC_URL, "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"].filter((u, i, a) => a.indexOf(u) === i);
export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const EXPLORER_ACCOUNT = "https://testnet.nearblocks.io/address/";

const YOCTO_DIGITS = 24;
const ONE_NEAR = 10n ** 24n;
export const MIN_CREATE_DEPOSIT = 10n ** 22n; // 0.01 NEAR
const TGAS = 10n ** 12n;

// ---------- amounts ----------

/** "1.5" -> "1500000000000000000000000". Throws on bad input. */
export function nearToYocto(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) {
    throw new Error("Enter an amount like 10 or 2.5");
  }
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > YOCTO_DIGITS) throw new Error("Too many decimal places");
  const y = BigInt(whole || "0") * ONE_NEAR + BigInt((frac + "0".repeat(YOCTO_DIGITS)).slice(0, YOCTO_DIGITS) || "0");
  return y.toString();
}

/** "1500000000000000000000000" -> "1.5" (up to `dp` decimals, trailing zeros trimmed). */
export function yoctoToNear(yocto, dp = 4) {
  const y = BigInt(yocto || 0);
  const whole = y / ONE_NEAR;
  const frac = (y % ONE_NEAR).toString().padStart(YOCTO_DIGITS, "0").slice(0, dp).replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  if (!frac && whole === 0n && y > 0n) return "<0." + "0".repeat(dp - 1) + "1";
  return frac ? `${w}.${frac}` : w;
}

export const big = (x) => BigInt(x || 0);

// ---------- views ----------

async function rpc(body) {
  let lastErr;
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Network error (${res.status})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("Couldn't reach NEAR testnet. Check your connection and try again. (" + (lastErr?.message || lastErr) + ")");
}

export async function view(method, args = {}) {
  if (!CONTRACT_ID) throw new Error("VITE_CONTRACT_ID is not set");
  const json = await rpc({
    jsonrpc: "2.0",
    id: "steadypay",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: CONTRACT_ID,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  });
  if (json.error) throw new Error(cleanError(json.error.data || json.error.message || "Network error"));
  if (json.result?.error) throw new Error(cleanError(json.result.error));
  const text = new TextDecoder().decode(new Uint8Array(json.result.result));
  return text ? JSON.parse(text) : null;
}

export const getVault = (owner) => view("get_vault", { owner });

// ---------- wallet ----------

let selector, modal;

export async function initWallet() {
  selector = await setupWalletSelector({
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
export const signIn = () => {
  if (!modal) throw new Error("Wallet is still loading, try again in a moment.");
  modal.show();
};

export async function signOut() {
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/** Call a change method. Returns { hash } (or {} if the wallet redirected away). */
export async function call(method, args, { depositYocto = "0", tgas = 30 } = {}) {
  const wallet = await selector.wallet();
  const action = internalActionToNaj({
    type: "FunctionCall",
    params: {
      methodName: method,
      args,
      gas: (BigInt(tgas) * TGAS).toString(),
      deposit: String(depositYocto),
    },
  });
  const outcome = await wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [action],
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

function findFailure(outcome) {
  const all = [outcome.status, ...(outcome.receipts_outcome || []).map((r) => r.outcome.status)];
  for (const st of all) {
    if (st && st.Failure) return cleanError(JSON.stringify(st.Failure));
  }
  return null;
}

/** Pull the plain-English contract message out of an RPC/wallet error. */
export function cleanError(e) {
  const s = typeof e === "string" ? e : e?.message || String(e);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  if (m) return m[1].trim();
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
