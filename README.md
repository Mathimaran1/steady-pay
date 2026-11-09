# Steady Pay

**A salary for people who don't have one.** Get paid in lumps. Live on a salary.

Freelancers get paid unevenly: a big invoice one month, nothing the next. Steady Pay is a NEAR smart contract that holds that lumpy income and pays it back to you as a fixed salary every period. Every client payment is split the moment it arrives: your tax percent goes to a locked tax bucket (it can only ever go to your tax wallet), the rest goes to your salary pot.

Built for the NEAR Hackathon (Real-World Money, Autonomous Business tracks).

> Example: a client pays 1,000 NEAR with 30% tax → 300 NEAR to tax savings, 700 NEAR to the salary pot → with a 100 NEAR salary, you're paid for 7 periods, even if no other client pays.

## Links

| | |
|---|---|
| Live page | TODO |
| Contract (testnet) | [`sp11091716-vault.testnet`](https://testnet.nearblocks.io/address/sp11091716-vault.testnet) |
| Demo video | TODO |
| X post | TODO |

## Key rules (enforced on chain)

- **Tax is safe.** Tax savings can only be sent to the tax wallet chosen at setup.
- **Salary can go down, never up.**
- **No overspending.** You can only take your fixed salary per payday, and only after payday.
- **Quiet months still pay.** Missed paydays add up; one claim pays all of them, as long as the pot has money.

## Status

### Real and working
- Smart contract (`contract/`): 27 unit tests passing (`cargo test`); builds to wasm with `cargo near build non-reproducible-wasm`.
- Deployed on NEAR testnet at `sp11091716-vault.testnet`; full flow verified from the CLI (hashes below).
- Web page (`web/`): builds with `npm run build`; reads live vault data from testnet (pay page shows the real split). Signing in with a wallet and sending transactions from the page: not yet verified by hand.

### Not done yet
- Wallet sign-in + transactions from the web page, tested by a human — TODO
- Hosted web page — TODO
- Demo video, X post — TODO

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, method table and demo script.

| Method | Who | What |
|---|---|---|
| `create_vault(salary, period_ms, tax_percent, tax_wallet)` | you, once | attach ≥ 0.01 NEAR |
| `deposit(owner)` | any client | attach the payment |
| `claim_salary()` | you | after payday |
| `withdraw_tax(amount?)` | you | always goes to your tax wallet |
| `lower_salary(new_salary)` | you | lower only |
| `get_vault(owner)` | view | |

Amounts are yoctoNEAR strings (1 NEAR = 10^24 yocto).

## Run it

### Contract

```bash
rustup target add wasm32-unknown-unknown
cd contract
cargo test
cargo near build non-reproducible-wasm   # -> target/near/steady_pay.wasm
```

Deploy to testnet with [near-cli-rs](https://github.com/near/near-cli-rs):

```bash
near contract deploy <ACCOUNT>.testnet use-file target/near/steady_pay.wasm \
  with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

### CLI walkthrough

```bash
C=<CONTRACT>.testnet; ME=<FREELANCER>.testnet; CLIENT=<CLIENT>.testnet; TAX=<TAX_WALLET>.testnet

# 1. Set up: 1 NEAR salary every 60 s, 30% tax
near contract call-function as-transaction $C create_vault \
  json-args "{\"salary\":\"1000000000000000000000000\",\"period_ms\":60000,\"tax_percent\":30,\"tax_wallet\":\"$TAX\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $ME network-config testnet sign-with-keychain send

# 2. Client pays 10 NEAR -> 3 to tax, 7 to pot
near contract call-function as-transaction $C deposit json-args "{\"owner\":\"$ME\"}" \
  prepaid-gas '30 Tgas' attached-deposit '10 NEAR' sign-as $CLIENT network-config testnet sign-with-keychain send

# 3. Look at the vault
near contract call-function as-read-only $C get_vault json-args "{\"owner\":\"$ME\"}" network-config testnet now

# 4. After 60 s: claim salary
near contract call-function as-transaction $C claim_salary json-args '{}' \
  prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send

# 5. Send tax savings to the tax wallet
near contract call-function as-transaction $C withdraw_tax json-args '{}' \
  prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
```

Transaction hashes from a real run on 9 Nov 2026 (`scripts/walkthrough.sh`, 0.5 NEAR salary every 60 s, 30% tax, client pays 3 NEAR):

| Step | Result | Transaction |
|---|---|---|
| `create_vault` | ok | [4WRCPTb8…](https://testnet.nearblocks.io/txns/4WRCPTb8DbVdAmfsyyDef8CsRMZxWFajNkA31Ema4NST) |
| client `deposit` 3 NEAR | ok → 0.9 tax, 2.1 pot | [Ab6fKEwo…](https://testnet.nearblocks.io/txns/Ab6fKEwoUshQ4zBDQmmDGgzfUu6Hk4ggX2BE9oU8fQ5N) |
| `claim_salary` before payday | fails: "It is not payday yet" | [7QRc9fAP…](https://testnet.nearblocks.io/txns/7QRc9fAPrgaKH8kK3dCQqGoZXqBPfEp26TmKed2zRVPi) |
| `claim_salary` after payday | ok, 0.5 NEAR | [2JjxBXc2…](https://testnet.nearblocks.io/txns/2JjxBXc2m8K9CZzdwSBbXvFxZzBY2ZamyPQgS4LUKDDE) |
| `lower_salary` to 0.9 (a raise) | fails: "Salary can only go down, never up" | [AjinoZGE…](https://testnet.nearblocks.io/txns/AjinoZGEaFyBtqQ65S1B16VzCVJRAtT73zxvy9sDiUam) |
| `lower_salary` to 0.4 | ok | [FZ29GskV…](https://testnet.nearblocks.io/txns/FZ29GskVPKoC9w5XFNLmrJGDVXrp3z376tpQBuAPgXQr) |
| `withdraw_tax` | ok, 0.9 NEAR arrived at the tax wallet | [BcxTF6bu…](https://testnet.nearblocks.io/txns/BcxTF6buqyRoLaBgZswu8HFNTevStMXkQCV4XiqXA9oT) |
| wait ~2 min, `claim_salary` | ok, 3 missed paydays paid at once (1.2 NEAR) | [4NF28H24…](https://testnet.nearblocks.io/txns/4NF28H24b8MSpTc3SuXmio3pZBMjmEaZ6k4sxrwySZTM) |

Run it yourself against any deployment: `scripts/walkthrough.sh <contract> <freelancer> <client> <tax_wallet>` (accounts must be in `~/.near-credentials`).

### Web page

```bash
cd web
cp .env.example .env    # set VITE_CONTRACT_ID
npm install
npm run dev             # or: npm run build -> dist/
```

## Known limits

- Testnet only. Not audited.
- No AI. The "suggest a salary" helper is plain arithmetic: the lowest of the monthly incomes you type in, minus your tax percent, computed in your browser.
- There is no way to close a vault or change the tax wallet / period / tax percent after setup.
- 0.01 NEAR of the setup deposit is kept by the contract for storage and is not returned.
- NEAR only (no stablecoins / fungible tokens yet).
- Tax percent is applied with integer math and rounds down by up to 1 yoctoNEAR per payment (in the salary pot's favour); no money is lost.
- Paydays are based on block time, so a claim can be a few seconds later than the countdown.
- "Recent activity" on the dashboard is stored in your browser only.

## License

MIT
