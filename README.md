# Steady Pay

**A salary for people who don't have one.** Get paid in lumps. Live on a salary.

Freelancers get paid unevenly: a big invoice one month, nothing the next. Steady Pay is a NEAR smart contract that holds that lumpy income and pays it back to you as a fixed salary every period. Every client payment is split the moment it arrives: your tax percent goes to a locked tax bucket (it can only ever go to your tax wallet), the rest goes to your salary pot.

On the web page the tax bucket is called **savings**, so the wording fits anyone setting money aside; the contract and CLI keep the `tax` names. Savings stay locked in the vault contract (the one shared Steady Pay vault account that holds every user's money, with separate books per user) until an **unlock date** the owner picks at setup, then go back to the owner.

**Demo yield:** savings in NEAR vaults earn a fixed **8% APY demo yield** while locked, paid out with the savings on release. It is paid from a yield reserve the team tops up (`fund_yield_reserve`), so it is a sponsored bonus for the demo, **not** staking or lending, and it stops if the reserve runs out (unpaid yield stays owed). Token (USDC/USDT) vaults earn no yield yet.

Each vault also picks a **payout mode** at setup:

- **Instant** (default on the page): savings % locked until the date, the rest is sent straight to the owner's wallet in the same transaction as the payment.
- **Salary**: the rest waits in the salary pot and the owner claims a fixed salary each period (the original Steady Pay idea: quiet months still pay).

Each vault is paid in one coin, chosen at setup from a dropdown: **NEAR**, **USDC** or **USDT** (any NEP-141 fungible token works; the page offers Ref Finance's testnet `usdc.fakes.testnet` and `usdt.fakes.testnet`).

Built for the NEAR Hackathon (Real-World Money, Autonomous Business tracks).

> Example: a client pays 1,000 NEAR with 30% tax → 300 NEAR to tax savings, 700 NEAR to the salary pot → with a 100 NEAR salary, you're paid for 7 periods, even if no other client pays.

## Links

| | |
|---|---|
| Live page | https://steady-pay-pi.vercel.app (Vercel, NEAR testnet) |
| Contract (testnet) | [`sp11091716-vault.testnet`](https://testnet.nearblocks.io/address/sp11091716-vault.testnet) |
| Demo video | TODO |
| X post | TODO |

## Key rules (enforced on chain)

- **Savings are locked until a date.** Savings can't be moved by anyone before the unlock date chosen at setup (not even the owner), and then only to the savings wallet: by default the owner's own account. Neither the date nor the wallet can be changed later.
- **Salary can go down, never up.**
- **No overspending.** You can only take your fixed salary per payday, and only after payday.
- **Quiet months still pay.** Missed paydays add up; one claim pays all of them, as long as the pot has money.

## Status

### Real and working
- Smart contract (`contract/`): 61 unit tests passing (`cargo test`); builds to wasm with `cargo near build non-reproducible-wasm`.
- Deployed on NEAR testnet at `sp11091716-vault.testnet`; full flow verified from the CLI (hashes below).
- USDC vaults: deployed to the same account on 13 Nov 2026 and verified from the CLI with testnet USDC `usdc.fakes.testnet` (hashes below). Vaults made before that keep working as NEAR vaults.
- USDT: offered in the setup dropdown; the vault account and demo savings wallet are registered with `usdt.fakes.testnet`. It uses the same contract code path as USDC, but a full USDT run (pay, claim, move savings) has not been verified yet.
- Web page (`web/`): builds with `npm run build`; reads live vault data from testnet (pay page shows the real split). Signing in with a wallet works (Meteor, testnet). From the page, by hand on 14 Nov 2026: creating a NEAR vault with a savings date lock, claiming salary and releasing savings all worked. Not yet tested by hand from the page: paying through a pay link, and the USDC/USDT flow (register with token, get test tokens, pay, claim); those contract paths are verified from the CLI (hashes below).

### Not done yet
- Hand test from the page of paying through a pay link and of USDC/USDT vaults — TODO
- Demo video, X post — TODO

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, method table and demo script.

| Method | Who | What |
|---|---|---|
| `create_vault(salary, period_ms, tax_percent, tax_wallet?, token?, savings_unlock_ms?, instant?)` | you, once | attach ≥ 0.01 NEAR (exactly 0.01 for instant or token vaults); `tax_wallet` defaults to you; `token` = token contract, omit for NEAR; `savings_unlock_ms` = Unix ms, up to 10 years ahead; `instant: true` = forward the non-savings share on every payment (salary/period then unused) |
| `deposit(owner)` | any client | NEAR vaults: attach the payment |
| `ft_on_transfer` (via the token's `ft_transfer_call`) | any client | token vaults: `msg` = owner account ID |
| `claim_salary()` | you | salary vaults: after payday. Instant vaults: collects anything a failed forward left in the vault, any time |
| `withdraw_tax(amount?)` | you | only on/after the unlock date; always goes to your tax wallet |
| `lower_salary(new_salary)` | you | lower only |
| `get_vault(owner)` | view | |

Amounts are strings in the vault coin's smallest unit: yoctoNEAR (1 NEAR = 10^24) or the token's base unit (USDC has 6 decimals, so 1 USDC = 1000000).

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

USDC run on 13 Nov 2026 (10 USDC salary every 60 s, 30% tax, token `usdc.fakes.testnet`, owner `sp11091716-client.testnet`):

| Step | Result | Transaction |
|---|---|---|
| `create_vault` with `"token":"usdc.fakes.testnet"` | ok | [wAdW9RGC…](https://testnet.nearblocks.io/txns/wAdW9RGCygQKe5xLQveVxwVcseVsWRDa249HAqC3ybw) |
| client `ft_transfer_call` 100 USDC, `msg` = owner | ok → 30 tax, 70 pot | [8cxFcFz1…](https://testnet.nearblocks.io/txns/8cxFcFz13uq8D3ngQVms6aV5ExCLAEF65JPYXxG1REHT) |
| `ft_transfer_call` 5 USDC to an account with no USDC vault | refunded, payer balance unchanged | [Am5weARb…](https://testnet.nearblocks.io/txns/Am5weARbwsqbTyJwJ4dT2tuxubTCxntTKPYmFVfn21ym) |
| `claim_salary` after payday | ok, 10 USDC to owner | [2W9VVx1M…](https://testnet.nearblocks.io/txns/2W9VVx1MhruZB7SEaJVEDNyDzVACphkASazYEqFroVwA) |
| `withdraw_tax` | ok, 30 USDC arrived at the tax wallet | [CKoxcgfp…](https://testnet.nearblocks.io/txns/CKoxcgfpa7xMCAh5msLgLX8tJ4hFogRDLScjpyAjS6a4) |

Pay a USDC vault from the CLI:

```bash
near contract call-function as-transaction usdc.fakes.testnet ft_transfer_call \
  json-args "{\"receiver_id\":\"$C\",\"amount\":\"100000000\",\"msg\":\"$ME\"}" \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as $CLIENT network-config testnet sign-with-keychain send
```

The contract account, the owner and the tax wallet must each be registered with the token (`storage_deposit`) to hold it. The web page offers buttons for this. `usdc.fakes.testnet` has a public `mint`, so the page can also hand out test USDC.

Savings date lock, run on 14 Nov 2026 (NEAR vault for `sp11091716-tax.testnet`, no savings wallet given so it defaults to the owner, savings locked for 90 s, client pays 1 NEAR):

| Step | Result | Transaction |
|---|---|---|
| `create_vault` with `savings_unlock_ms` | ok | [2zqtWbPU…](https://testnet.nearblocks.io/txns/2zqtWbPUor48iEggQzwjpichsvwE4CVvme5owRdCeKHr) |
| client `deposit` 1 NEAR | ok → 0.3 savings, 0.7 pot | [4XJqyhXv…](https://testnet.nearblocks.io/txns/4XJqyhXvcTToPPdS1U8TZ3CevrF6vD1SuXfwAWqYtggy) |
| `withdraw_tax` before the date | fails: "Your savings are locked until the unlock date" | [EtZTWMS5…](https://testnet.nearblocks.io/txns/EtZTWMS5K2T2wX1LtRzeo44pomKeP2AGGe1bSh26zzz6) |
| `withdraw_tax` after the date | ok, 0.3 NEAR back to the owner, log "Steady Pay savings released" | [ANMo4siZ…](https://testnet.nearblocks.io/txns/ANMo4siZHXV8kKMhNHjAt1KTLpksiM8v3yHbQKodABt2) |
| `claim_salary` | ok, log "Steady Pay salary · 1 payday" | [CPcQX56e…](https://testnet.nearblocks.io/txns/CPcQX56e4f3wEBCbueFWRxnC8CKjTqJss1ug5wSNbht4) |

Instant mode, run on 14 Nov 2026 (new account `inst.sp11091716-client.testnet`, 30% savings locked for a day, client pays 1 NEAR):

| Step | Result | Transaction |
|---|---|---|
| `create_vault` with `"instant":true` | ok | [FSKp9no4…](https://testnet.nearblocks.io/txns/FSKp9no4v2fpxMyMe3oX1yzfoYQSicqTjNo4qYWDRFUL) |
| client `deposit` 1 NEAR | ok → 0.3 locked as savings, 0.7 sent to the owner in the same transaction (owner balance 0.9898 → 1.6898), log "Steady Pay payment" | [HkTfhzK5…](https://testnet.nearblocks.io/txns/HkTfhzK55ty3Wx3jw6HtR37SXgArxXSfe6tVp6peTfth) |

Demo yield, run on 14 Nov 2026 (reserve funded with 1 NEAR; new vault `yld.sp11091716-client.testnet`, 0.09 NEAR savings locked for 60 s):

| Step | Result | Transaction |
|---|---|---|
| `fund_yield_reserve` 1 NEAR | ok | [5UC8My4F…](https://testnet.nearblocks.io/txns/5UC8My4Fk8jeqUgR3GqPT259y13iCDNj44DhrNDkxW1j) |
| `withdraw_tax` after the unlock | ok: 0.09 NEAR savings + 0.000000015 NEAR yield in one transfer, log "Steady Pay savings released + demo yield"; reserve down by the same amount | [5YNJyLBF…](https://testnet.nearblocks.io/txns/5YNJyLBFAditV1VVRvMBLbapkzrLpEhnWu96GfREnTZD) |

On-chain messages: every payout carries a readable message. Token payouts put it in the `ft_transfer` memo; plain NEAR transfers have no memo field, so the contract writes it as a log line on the transaction.

Run it yourself against any deployment: `scripts/walkthrough.sh <contract> <freelancer> <client> <tax_wallet>` (accounts must be in `~/.near-credentials`).

### Web page

```bash
cd web
cp .env.example .env    # set VITE_CONTRACT_ID (optional: VITE_USDC_ID)
npm install
npm run dev             # or: npm run build -> dist/
```

## Known limits

- The 8% yield is a demo: a fixed rate paid from a reserve the team funds, not real staking or lending, and only for NEAR vaults. Real yield (NEAR staking, stablecoin lending) is the next step.

- The vault account `sp11091716-vault.testnet` still has a full-access key (the developer's), so the developer could deploy new code with different rules. The locks are enforced by the current code only; removing that key would make the rules permanent (not done, since this is a testnet build still being changed).

- Testnet only. Not audited.
- No AI. The "Steady" character (an animated mascot that floats around the page and opens a chat when clicked) is rule-based: it matches keywords to built-in answers and fills in numbers from your vault; it does not call any AI model. The "suggest a salary" helper is plain arithmetic: the lowest of the monthly incomes you type in, minus your tax percent, computed in your browser.
- There is no way to close a vault or change the tax wallet / period / tax percent after setup.
- 0.01 NEAR of the setup deposit is kept by the contract for storage and is not returned.
- One coin per vault, fixed at setup. A vault can't hold NEAR and USDC at once.
- Token vaults pay out only to accounts registered with the token. If the owner or tax wallet isn't registered, the transfer fails and the money stays in the vault (rolled back); the page shows a "register" step.
- The contract accepts any NEP-141 token the owner names at setup; it does not check that the token is genuine. The page only offers testnet USDC and USDT (`usdc.fakes.testnet`, `usdt.fakes.testnet`: test tokens with public minting, not Circle's USDC or Tether's USDT).
- Tax percent is applied with integer math and rounds down by up to 1 yoctoNEAR per payment (in the salary pot's favour); no money is lost.
- Paydays are based on block time, so a claim can be a few seconds later than the countdown.
- The Activity page reads your history from the NearBlocks indexer and lists only transactions you signed; payments clients send you are counted in the Wallet page totals instead.
