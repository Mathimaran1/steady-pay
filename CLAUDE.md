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

- Done: contract (`contract/src/lib.rs`, near-sdk 5.30.1) with 27 passing unit tests; wasm builds with cargo-near 0.23.0 (`target/near/steady_pay.wasm`, ~143 KB).
- Written: `web/` (Vite + Wallet Selector 10); `npm run build` passes and the home page renders in headless Chrome. Not yet tested against a deployed contract.
- Not done: testnet deploy, CLI walkthrough tx hashes, hosted page, demo video, X post, submission.
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
- `withdraw_tax(amount?)`: only to `tax_wallet`, never more than the bucket.
- `lower_salary(new)`: only lower, never higher.
- `create_vault`: needs ≥ 0.01 NEAR attached, one vault per account, period 60 s to 366 days, tax 0–50%.
- Amounts are yoctoNEAR as `U128` strings in JSON. `next_payday_ms` is Unix milliseconds.

When changing the contract, add or update a unit test for the behavior and run `cargo test` before finishing.

## Web page conventions

- Static site, no backend or database. The contract is the only source of truth.
- Views via plain `fetch` to `https://rpc.testnet.near.org` (`query` / `call_function`). Changes via NEAR Wallet Selector.
- Contract ID from `VITE_CONTRACT_ID`.
- Convert NEAR to yocto with string math, never floats.
- Plain user-facing words: "salary pot", "tax savings", "next payday". Avoid "yocto" and "contract" in the main UI.
- Show the contract's error messages as-is; they are already plain English.
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
