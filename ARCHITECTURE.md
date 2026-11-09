# Architecture

## Pieces

```
 client wallet ──deposit(owner) + NEAR──▶ ┌──────────── Steady Pay contract ────────────┐
                                          │ vaults: LookupMap<AccountId, Vault>          │
                                          │   split on arrival:                          │
                                          │     tax_percent ─▶ tax_bucket ──withdraw_tax──▶ tax_wallet (fixed)
                                          │     rest        ─▶ pot ───────claim_salary──▶ owner
                                          └──────────────────────────────────────────────┘
                 web/ (static Vite page) ── views via JSON-RPC fetch, changes via Wallet Selector
```

- **Contract** (`contract/src/lib.rs`, near-sdk 5): one contract holds many vaults, one per owner account. It is the only source of truth.
- **Web page** (`web/`): static Vite site, no backend, no database. Reads with plain `fetch` to the testnet RPC (`query` / `call_function`), writes through NEAR Wallet Selector (Meteor, Intear; MyNearWallet was dropped because it no longer accepts app connections).

## Vault state

| Field | Meaning |
|---|---|
| `salary` | yoctoNEAR paid per period. Can only be lowered. |
| `period_ms` | Pay period, 60 s to 366 days. |
| `tax_percent` | 0–50. Applied to every incoming payment. |
| `tax_wallet` | The only account tax savings can be sent to. Set once. |
| `pot` | Salary pot. |
| `tax_bucket` | Tax savings. |
| `next_payday_ms` | Unix ms of the next unclaimed payday. First payday = creation + one period. |
| `storage_deposit`, `total_*`, `created_ms` | Bookkeeping. |

## Methods

| Method | Who | What |
|---|---|---|
| `new()` | deployer | init |
| `create_vault(salary, period_ms, tax_percent, tax_wallet)` | anyone, once | Needs ≥ 0.01 NEAR attached. 0.01 NEAR is kept for storage; any extra is split like a deposit. |
| `deposit(owner)` | anyone | `to_tax = amount * tax_percent / 100` (integer, rounds down), rest to pot. |
| `claim_salary()` | owner | Fails before payday. `periods_owed = (now - next_payday) / period + 1`. Pays `min(salary * periods_owed, pot)`. Advances payday by `periods_owed * period`. State is updated before the transfer. |
| `withdraw_tax(amount?)` | owner | Sends to `tax_wallet` only; never more than the bucket. Omit `amount` for all. |
| `lower_salary(new_salary)` | owner | Must be strictly lower and > 0. |
| `on_payout(...)` | contract only | Callback. If a payout transfer fails (e.g. tax wallet account doesn't exist), the amount and payday are rolled back. |
| `get_vault(owner)` | view | Vault plus `periods_covered`, `periods_owed`, `claimable_now`. |
| `get_vault_count()`, `get_limits()` | view | |

Amounts in JSON are yoctoNEAR strings (`U128`). Each change method logs a NEP-297 style `EVENT_JSON` line (`standard: "steady_pay"`).

## Screens (web/)

1. **Home** (signed out): pitch, 4 steps, key rules, connect button.
2. **Set up** (signed in, no vault): salary, payday, tax percent, tax wallet, optional starting money, live split preview, optional "suggest a salary" helper (lowest of the months you type in, after tax — plain arithmetic, done in the browser).
3. **Dashboard** (signed in, has vault): salary pot, tax savings, next payday countdown, salary; claim salary; send tax savings; lower salary; pay link; totals; recent transactions in this browser (localStorage, convenience only).
4. **Pay page** `#/pay/<owner>`: client enters an amount, sees the split, pays with their wallet.

Every transaction result links to `https://testnet.nearblocks.io/txns/<hash>`. Contract errors are shown as-is.

## Build order

1. Build wasm and deploy to testnet.
2. Run the CLI walkthrough in `README.md` and save transaction hashes.
3. Build `web/` (Vite + NEAR Wallet Selector, static, no backend).
4. Deploy the page (Vercel or Netlify).
5. Update `README.md` with real links, then demo video, X post, submit.

## Demo script (~2 min)

Use a vault with a 60-second period so several "months" pass in a few minutes.

1. Home page → connect wallet (freelancer account).
2. Set up: salary 1 NEAR, every minute, 30% tax, tax wallet = second testnet account. Create.
3. Copy pay link → open in another browser profile signed in as the client → pay 10 NEAR. Show split: 3 to tax savings, 7 to pot ("covers 7 paydays").
4. Back on dashboard: claim is locked, countdown running. Wait for payday → claim 1 NEAR. Open nearblocks link.
5. Wait ~2 minutes without claiming → claim pays 2 paydays at once ("quiet months still pay").
6. Try lowering salary to a higher number → contract error "Salary can only go down, never up". Lower to 0.5 → pot now covers more paydays.
7. Send tax savings → arrives at the tax wallet (show on nearblocks).
