# CLAUDE.md

Instructions for Claude Code working in this repository.

## Project

Steady Pay is a NEAR HACKATHON entry (Real-World Money, Autonomous Business tracks). A NEAR smart contract holds a freelancer's lumpy income and pays it back as a fixed salary each period. Every client payment is split on arrival: tax percent to a tax bucket (only withdrawable to a fixed tax wallet), the rest to a salary pot.

Read `README.md` for the product and `ARCHITECTURE.md` for the design and build plan before starting work.

**Deadline: 14 Nov 2026, 23:59 UTC.** Submission needs a public GitHub repo and an X post tagging @NEARProtocol and #NEARHackathon. Prefer a small, working, honestly documented project over a big unfinished one.

## Layout

```
contract/          Rust smart contract (near-sdk 5.30)
  src/lib.rs       contract + unit tests
web/               Vite web page (src/main.js UI, src/near.js RPC + wallet)
README.md          product, run steps, honest status
ARCHITECTURE.md    design, screens, build order, demo script
```

## Commands

```bash
# Contract tests (must stay green)
cd contract && cargo test

# Build wasm (plain `cargo build --release` is blocked by near-sdk on purpose)
rustup target add wasm32-unknown-unknown
cd contract && cargo near build non-reproducible-wasm
# Output: contract/target/near/steady_pay.wasm

# Deploy to testnet (near-cli-rs)
near contract deploy <ACCOUNT>.testnet use-file target/near/steady_pay.wasm \
  with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

## Current status

- Done: contract (`contract/src/lib.rs`, near-sdk 5.30.1) with 61 passing unit tests (NEAR + token vaults, savings date lock, instant/salary payout modes, demo yield); wasm builds with cargo-near 0.23.0 (`target/near/steady_pay.wasm`, ~163 KB). Deployed to `sp11091716-vault.testnet`; NEAR and USDC CLI walkthrough hashes are in README.md.
- Written: `web/` (Vite + Wallet Selector 10); `npm run build` passes; pages render live testnet data in headless Chrome. Wallet sign-in works (Meteor). Sending transactions from the page not yet verified by hand.
- Hosted: https://steady-pay-pi.vercel.app (Vercel project root `web`, env `VITE_CONTRACT_ID`; redeploys on push to `main`).
- Not done: hand test of pay-link and token flows from the page, demo video, X post, submission.
- Toolchain on this machine: Rust 1.99.1, cargo-near 0.23.0, near-cli-rs 0.31.1 (all in ~/.cargo/bin). Network here is flaky; use `CARGO_NET_RETRY=10`.
- Web uses `web/src/polyfills.js` (Buffer/global) — keep it as the first import in `main.js`.

## Build order

Follow `ARCHITECTURE.md` "Build order":
1. Build wasm and deploy to testnet.
2. Run the CLI walkthrough in `README.md` and save transaction hashes.
3. Build `web/` (Vite + NEAR Wallet Selector, static, no backend).
4. Deploy the page (Vercel or Netlify).
5. Update `README.md` with real links, then demo video, X post, submit.

## Contract rules (do not break)

- `deposit(owner)`: anyone can pay; `to_tax = amount * tax_percent / 100`, rest to the pot.
- `claim_salary()`: fails before payday; pays `min(salary * periods_owed, pot)`; advances payday by `periods * period`; updates state before transferring.
- `withdraw_tax(amount?)`: only to `tax_wallet`, never more than the bucket, never before the savings unlock date (stored under key `unl:<owner>`, outside `Vault`). `tax_wallet` defaults to the owner.
- Payout mode per vault: `instant` (key `ins:<owner>`) forwards the non-savings share on every payment (state updated first, failed forward goes back to the pot, `claim_salary` collects it any time); otherwise the salary-pot rules above apply.
- Demo yield: NEAR-vault savings earn `DEMO_YIELD_APY_BPS` (8%), books under `yld:<owner>`, paid on `withdraw_tax` from the reserve (`rsv`, topped up by `fund_yield_reserve`), capped by the reserve. Always call it "demo yield" in the UI and README; it is not staking.
- Payouts carry a readable message: `ft_transfer` memo for tokens, plus a log line for every payout.
- `lower_salary(new)`: only lower, never higher.
- Each vault is paid in one coin: NEAR (`token` null) or a NEP-141 token. The token is stored under key `tok:<owner>`, outside `Vault`, so the old state layout keeps working. Token payments arrive via `ft_on_transfer` with `msg` = owner; only the vault's own token is accepted.
- `create_vault`: needs ≥ 0.01 NEAR attached, one vault per account, period 60 s to 366 days, tax 0–50%, optional `savings_unlock_ms` in the future and ≤ 10 years ahead.
- Amounts are `U128` strings in the vault coin's smallest unit (yoctoNEAR, or the token's base unit; USDC = 6 decimals). `next_payday_ms` is Unix milliseconds.

When changing the contract, add or update a unit test for the behavior and run `cargo test` before finishing.

## Web page conventions

- Static site, no backend or database. The contract is the only source of truth.
- Views via plain `fetch` (`query` / `call_function`), sent to `test.rpc.fastnear.com` and `rpc.testnet.near.org` at the same time; the first good answer wins (the public RPC is often slow). Changes via NEAR Wallet Selector.
- Keep the first page load small: three.js (`scene.js`) and the wallet selector are loaded with dynamic `import()`, never statically from `main.js`.
- Contract ID from `VITE_CONTRACT_ID`.
- Convert NEAR to yocto with string math, never floats.
- Plain user-facing words: "salary pot", "savings", "savings wallet", "next payday". The page never says "tax" (the contract's tax bucket is shown as "savings"; `cleanError` in `near.js` rewords the contract messages that mention tax). Avoid "yocto" and "contract" in the main UI.
- Show the contract's error messages as-is (except the tax → savings rewording above); they are already plain English.
- Link each transaction to `https://testnet.nearblocks.io/txns/<hash>`.
- Use 60-second periods for the demo so several "months" pass in a few minutes.

## Honesty rules for README.md

Judges first screen every project with Claude Code and Codex to check it runs and does what the README says.

- Only list a feature under "Real and working" once it actually works.
- Never invent transaction hashes, contract accounts, URLs or test counts. Use `TODO` until real.
- There is no AI feature. Do not describe the salary suggestion (lowest recent month) as AI.
- Keep the "Known limits" section accurate.

## Security

- Never commit private keys, seed phrases or `.env` files. near-cli-rs keeps keys in the system keychain.
- Use testnet only. Do not use the prize payout wallet for testing.
