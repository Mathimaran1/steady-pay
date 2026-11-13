//! Steady Pay: a salary for people who don't have one.
//!
//! A freelancer creates a vault once (salary, pay period, tax percent, tax wallet).
//! Clients pay into the vault with `deposit(owner)`. Every payment is split on arrival:
//! `tax_percent` goes to a tax bucket that can only ever be sent to the tax wallet,
//! the rest goes to the salary pot. The owner claims a fixed salary each period.
//!
//! A vault is paid in one coin, chosen at creation: NEAR (the default) or one NEP-141
//! token such as USDC. Token payments arrive through `ft_transfer_call` on the token
//! contract with the vault owner's account ID as `msg`.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// Minimum attached deposit to create a vault (covers storage). 0.01 NEAR.
pub const MIN_CREATE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
/// Shortest allowed pay period: 60 seconds (handy for demos).
pub const MIN_PERIOD_MS: u64 = 60_000;
/// Longest allowed pay period: 366 days.
pub const MAX_PERIOD_MS: u64 = 366 * 24 * 60 * 60 * 1_000;
/// Highest allowed tax percent.
pub const MAX_TAX_PERCENT: u8 = 50;

const CALLBACK_GAS: Gas = Gas::from_tgas(5);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Storage key prefix for a vault's token. Kept outside `Vault` so vaults created before
/// tokens were supported keep their layout (no token entry = a NEAR vault).
const TOKEN_KEY_PREFIX: &[u8] = b"tok:";
/// Storage key prefix for a vault's savings unlock time (Unix ms). Also outside `Vault`;
/// no entry = savings can be moved any time (vaults made before the date lock).
const UNLOCK_KEY_PREFIX: &[u8] = b"unl:";
/// The latest allowed savings unlock date: 10 years ahead.
pub const MAX_UNLOCK_AHEAD_MS: u64 = 10 * 366 * 24 * 60 * 60 * 1_000;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
}

/// Internal vault state (stored on chain).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Vault {
    pub salary: u128,
    pub period_ms: u64,
    pub tax_percent: u8,
    pub tax_wallet: AccountId,
    pub pot: u128,
    pub tax_bucket: u128,
    pub next_payday_ms: u64,
    pub storage_deposit: u128,
    pub total_received: u128,
    pub total_salary_paid: u128,
    pub total_tax_withdrawn: u128,
    pub created_ms: u64,
}

/// JSON view of a vault. Amounts are strings in the vault's smallest unit
/// (yoctoNEAR for NEAR vaults, the token's base unit for token vaults).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VaultView {
    pub owner: AccountId,
    /// Token contract the vault is paid in, or null for NEAR.
    pub token: Option<AccountId>,
    /// When savings unlock (Unix ms), or null if there is no date lock.
    pub savings_unlock_ms: Option<u64>,
    /// true: the non-savings share of each payment goes straight to the owner (no salary pot schedule).
    pub instant: bool,
    /// Demo yield earned on savings and not paid yet (paid with the next savings release).
    pub yield_earned: U128,
    /// Demo yield already paid out.
    pub yield_paid: U128,
    /// Demo yield rate in basis points (0 for token vaults).
    pub yield_apy_bps: u16,
    pub salary: U128,
    pub period_ms: u64,
    pub tax_percent: u8,
    pub tax_wallet: AccountId,
    pub pot: U128,
    pub tax_bucket: U128,
    pub next_payday_ms: u64,
    pub storage_deposit: U128,
    pub total_received: U128,
    pub total_salary_paid: U128,
    pub total_tax_withdrawn: U128,
    pub created_ms: u64,
    /// How many full salaries the pot can still pay.
    pub periods_covered: u64,
    /// Paydays that have passed and not been claimed yet (as of the block this view ran in).
    pub periods_owed: u64,
    /// What `claim_salary` would pay right now.
    pub claimable_now: U128,
}

/// Contract limits, for the web page.
#[near(serializers = [json])]
pub struct Limits {
    pub min_create_deposit: U128,
    pub min_period_ms: u64,
    pub max_period_ms: u64,
    pub max_tax_percent: u8,
}

/// What a payout was for, so a failed transfer can be rolled back.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Payout {
    Salary {
        prev_next_payday_ms: u64,
    },
    Tax,
    /// Savings released together with demo yield taken from the reserve.
    TaxWithYield {
        yield_amount: U128,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SteadyPay {
    vaults: LookupMap<AccountId, Vault>,
    vault_count: u64,
}

fn periods_owed(v: &Vault, now_ms: u64) -> u64 {
    if now_ms < v.next_payday_ms {
        0
    } else {
        (now_ms - v.next_payday_ms) / v.period_ms + 1
    }
}

fn claimable(v: &Vault, now_ms: u64) -> u128 {
    let owed = v.salary.saturating_mul(periods_owed(v, now_ms) as u128);
    owed.min(v.pot)
}

fn token_key(owner: &AccountId) -> Vec<u8> {
    [TOKEN_KEY_PREFIX, owner.as_bytes()].concat()
}

fn token_of(owner: &AccountId) -> Option<AccountId> {
    env::storage_read(&token_key(owner)).map(|b| {
        String::from_utf8(b)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| env::panic_str("Bad token entry"))
    })
}

// ---------- demo yield on savings ----------
// Locked savings in NEAR vaults earn a fixed demo APY, paid out with the savings on release.
// The yield is paid from a reserve that anyone can top up with `fund_yield_reserve` (the team does,
// for the demo). It is not staking or lending: it is a sponsored bonus, capped by the reserve.

/// Demo yield: 8% a year, in basis points.
pub const DEMO_YIELD_APY_BPS: u128 = 800;
const YEAR_MS: u128 = 365 * 24 * 60 * 60 * 1_000;
const YIELD_KEY_PREFIX: &[u8] = b"yld:";
const RESERVE_KEY: &[u8] = b"rsv";

/// Per-vault yield books: earned but unpaid, last time it was updated, total paid out.
struct YieldBooks {
    accrued: u128,
    last_ms: u64,
    paid: u128,
}

fn yield_key(owner: &AccountId) -> Vec<u8> {
    [YIELD_KEY_PREFIX, owner.as_bytes()].concat()
}

fn read_yield(owner: &AccountId) -> YieldBooks {
    match env::storage_read(&yield_key(owner)) {
        Some(b) if b.len() == 40 => YieldBooks {
            accrued: u128::from_le_bytes(b[0..16].try_into().unwrap()),
            last_ms: u64::from_le_bytes(b[16..24].try_into().unwrap()),
            paid: u128::from_le_bytes(b[24..40].try_into().unwrap()),
        },
        _ => YieldBooks {
            accrued: 0,
            last_ms: 0,
            paid: 0,
        },
    }
}

fn write_yield(owner: &AccountId, y: &YieldBooks) {
    let mut b = Vec::with_capacity(40);
    b.extend_from_slice(&y.accrued.to_le_bytes());
    b.extend_from_slice(&y.last_ms.to_le_bytes());
    b.extend_from_slice(&y.paid.to_le_bytes());
    env::storage_write(&yield_key(owner), &b);
}

/// Yield earned by `bucket` over `ms` milliseconds at the demo APY.
fn yield_for(bucket: u128, ms: u64) -> u128 {
    let per_year = bucket * DEMO_YIELD_APY_BPS / 10_000;
    per_year
        .checked_mul(ms as u128)
        .map(|x| x / YEAR_MS)
        .unwrap_or_else(|| per_year / YEAR_MS * ms as u128)
}

/// Yield books with everything earned up to now (savings were `bucket` since the last update).
/// Vaults made before the yield existed have no books yet; they count from `created_ms`.
/// Token vaults earn no demo yield.
fn accrued_now(owner: &AccountId, bucket: u128, now_ms: u64, created_ms: u64) -> YieldBooks {
    let mut y = read_yield(owner);
    if token_of(owner).is_some() {
        return y;
    }
    let since = if y.last_ms == 0 {
        created_ms
    } else {
        y.last_ms
    };
    if now_ms > since {
        y.accrued += yield_for(bucket, now_ms - since);
    }
    y.last_ms = now_ms;
    y
}

fn read_reserve() -> u128 {
    env::storage_read(RESERVE_KEY)
        .map(|b| u128::from_le_bytes(b.try_into().unwrap_or([0; 16])))
        .unwrap_or(0)
}

fn write_reserve(v: u128) {
    env::storage_write(RESERVE_KEY, &v.to_le_bytes());
}

/// Storage key marking an "instant" vault: the non-savings share of each payment goes straight
/// to the owner instead of the salary pot. Outside `Vault` too; no entry = a salary vault.
const INSTANT_KEY_PREFIX: &[u8] = b"ins:";

fn instant_key(owner: &AccountId) -> Vec<u8> {
    [INSTANT_KEY_PREFIX, owner.as_bytes()].concat()
}

fn is_instant(owner: &AccountId) -> bool {
    env::storage_has_key(&instant_key(owner))
}

fn unlock_key(owner: &AccountId) -> Vec<u8> {
    [UNLOCK_KEY_PREFIX, owner.as_bytes()].concat()
}

/// When this vault's savings unlock (Unix ms), if a date lock was set.
fn unlock_of(owner: &AccountId) -> Option<u64> {
    env::storage_read(&unlock_key(owner)).map(|b| {
        u64::from_le_bytes(
            b.try_into()
                .unwrap_or_else(|_| env::panic_str("Bad unlock entry")),
        )
    })
}

/// Send `amount` of the vault's coin to `to`, with a human-readable on-chain message:
/// the token transfer's `memo` for token vaults, and a log line on the transaction for all vaults
/// (plain NEAR transfers have no memo field).
fn send(to: AccountId, amount: u128, token: Option<AccountId>, memo: &str) -> Promise {
    env::log_str(memo);
    match token {
        None => Promise::new(to).transfer(NearToken::from_yoctonear(amount)),
        Some(t) => Promise::new(t).function_call(
            "ft_transfer".to_string(),
            json!({ "receiver_id": to, "amount": U128(amount), "memo": memo })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(1),
            FT_TRANSFER_GAS,
        ),
    }
}

fn log_event(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"steady_pay\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        event, data
    ));
}

#[near]
impl SteadyPay {
    #[init]
    pub fn new() -> Self {
        Self {
            vaults: LookupMap::new(StorageKey::Vaults),
            vault_count: 0,
        }
    }

    /// Create the caller's vault. Attach at least 0.01 NEAR: 0.01 NEAR is kept for storage,
    /// anything above it is treated as a first deposit and split like any other payment.
    /// `tax_wallet` defaults to the owner: savings then come back to you once unlocked.
    /// `savings_unlock_ms` (Unix ms) locks savings until that time; omit it for no date lock.
    #[payable]
    pub fn create_vault(
        &mut self,
        salary: U128,
        period_ms: u64,
        tax_percent: u8,
        tax_wallet: Option<AccountId>,
        token: Option<AccountId>,
        savings_unlock_ms: Option<u64>,
        instant: Option<bool>,
    ) -> VaultView {
        let instant = instant.unwrap_or(false);
        let owner = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= MIN_CREATE_DEPOSIT,
            "Attach at least 0.01 NEAR to create a vault"
        );
        require!(
            !self.vaults.contains_key(&owner),
            "You already have a vault"
        );
        require!(salary.0 > 0, "Salary must be more than zero");
        require!(
            (MIN_PERIOD_MS..=MAX_PERIOD_MS).contains(&period_ms),
            "Pay period must be between 60 seconds and 366 days"
        );
        require!(
            tax_percent <= MAX_TAX_PERCENT,
            "Tax percent must be between 0 and 50"
        );

        let extra = attached - MIN_CREATE_DEPOSIT;
        require!(
            !instant || extra == 0,
            "An instant vault only takes 0.01 NEAR at setup. Payments go straight to you"
        );
        require!(
            token.is_none() || extra == 0,
            "A token vault only takes 0.01 NEAR at setup. Send starting money as a token payment"
        );

        let now = env::block_timestamp_ms();
        if let Some(u) = savings_unlock_ms {
            require!(u > now, "Savings unlock date must be in the future");
            require!(
                u <= now + MAX_UNLOCK_AHEAD_MS,
                "Savings unlock date must be within 10 years"
            );
        }
        let tax_wallet = tax_wallet.unwrap_or_else(|| owner.clone());
        let to_tax = extra * tax_percent as u128 / 100;
        let vault = Vault {
            salary: salary.0,
            period_ms,
            tax_percent,
            tax_wallet,
            pot: extra - to_tax,
            tax_bucket: to_tax,
            next_payday_ms: now + period_ms,
            storage_deposit: MIN_CREATE_DEPOSIT,
            total_received: extra,
            total_salary_paid: 0,
            total_tax_withdrawn: 0,
            created_ms: now,
        };
        self.vaults.insert(owner.clone(), vault);
        self.vault_count += 1;
        if let Some(t) = &token {
            env::storage_write(&token_key(&owner), t.as_bytes());
        }
        if let Some(u) = savings_unlock_ms {
            env::storage_write(&unlock_key(&owner), &u.to_le_bytes());
        }
        if instant {
            env::storage_write(&instant_key(&owner), &[1]);
        }
        if token.is_none() {
            write_yield(
                &owner,
                &YieldBooks {
                    accrued: 0,
                    last_ms: now,
                    paid: 0,
                },
            );
        }
        log_event(
            "create_vault",
            format!(
                "{{\"owner\":\"{}\",\"salary\":\"{}\",\"token\":{}}}",
                owner,
                salary.0,
                token
                    .as_ref()
                    .map_or("null".to_string(), |t| format!("\"{}\"", t))
            ),
        );
        self.view_of(&owner).unwrap()
    }

    /// Pay `owner` in NEAR. Anyone can call this. The attached NEAR is split into tax and salary pot.
    #[payable]
    pub fn deposit(&mut self, owner: AccountId) -> VaultView {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach some NEAR to pay");
        require!(
            self.vaults.contains_key(&owner),
            "No vault found for this account"
        );
        if let Some(t) = token_of(&owner) {
            env::panic_str(&format!("This vault is paid in {}, not NEAR", t));
        }
        self.credit(&owner, amount, &env::predecessor_account_id());
        self.view_of(&owner).unwrap()
    }

    /// NEP-141 receiver: pay a token vault. Call `ft_transfer_call` on the token contract
    /// with this contract as receiver and the vault owner's account ID as `msg`.
    /// Any failure panics, so the token contract refunds the sender.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let owner: AccountId = msg
            .trim()
            .parse()
            .unwrap_or_else(|_| env::panic_str("Put the vault owner's account ID in msg"));
        require!(amount.0 > 0, "Send some tokens to pay");
        require!(
            self.vaults.contains_key(&owner),
            "No vault found for this account"
        );
        require!(
            token_of(&owner).as_ref() == Some(&token),
            "This vault does not accept this token"
        );
        self.credit(&owner, amount.0, &sender_id);
        PromiseOrValue::Value(U128(0))
    }

    /// Claim salary for every payday that has passed, paid from the pot.
    /// Pays `min(salary * periods_owed, pot)` and moves the next payday forward.
    pub fn claim_salary(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let vault = self
            .vaults
            .get_mut(&owner)
            .unwrap_or_else(|| env::panic_str("No vault found for this account"));
        let instant = is_instant(&owner);
        let owed = if instant { 1 } else { periods_owed(vault, now) };
        require!(owed > 0, "It is not payday yet");
        // An instant vault's pot only holds payments that could not be forwarded; collect them any time.
        let pay = if instant {
            vault.pot
        } else {
            claimable(vault, now)
        };
        require!(
            pay > 0,
            if instant {
                "There is nothing waiting for you"
            } else {
                "Your salary pot is empty"
            }
        );

        let prev = vault.next_payday_ms;
        // Update state before transferring.
        vault.pot -= pay;
        vault.total_salary_paid += pay;
        if !instant {
            vault.next_payday_ms = prev + owed * vault.period_ms;
        }
        log_event(
            "claim_salary",
            format!(
                "{{\"owner\":\"{}\",\"amount\":\"{}\",\"periods\":{}}}",
                owner, pay, owed
            ),
        );

        let memo = format!(
            "Steady Pay salary · {} payday{}",
            owed,
            if owed == 1 { "" } else { "s" }
        );
        send(owner.clone(), pay, token_of(&owner), &memo).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_payout(
                    owner,
                    U128(pay),
                    Payout::Salary {
                        prev_next_payday_ms: prev,
                    },
                ),
        )
    }

    /// Send tax savings to the vault's tax wallet. Only the owner can trigger it,
    /// the money can only go to the tax wallet, and never before the savings unlock date.
    /// Omit `amount` to send everything.
    pub fn withdraw_tax(&mut self, amount: Option<U128>) -> Promise {
        let owner = env::predecessor_account_id();
        if let Some(u) = unlock_of(&owner) {
            require!(
                env::block_timestamp_ms() >= u,
                "Your savings are locked until the unlock date"
            );
        }
        let vault = self
            .vaults
            .get_mut(&owner)
            .unwrap_or_else(|| env::panic_str("No vault found for this account"));
        let amount = amount.map(|a| a.0).unwrap_or(vault.tax_bucket);
        require!(amount > 0, "There is no tax money to send");
        require!(
            amount <= vault.tax_bucket,
            "That is more than your tax savings"
        );
        // Demo yield: bring the books up to date, then pay what the reserve can cover.
        let mut y = accrued_now(
            &owner,
            vault.tax_bucket,
            env::block_timestamp_ms(),
            vault.created_ms,
        );
        let reserve = read_reserve();
        let bonus = y.accrued.min(reserve);
        y.accrued -= bonus;
        y.paid += bonus;
        write_yield(&owner, &y);
        write_reserve(reserve - bonus);

        vault.tax_bucket -= amount;
        vault.total_tax_withdrawn += amount;
        let to = vault.tax_wallet.clone();
        log_event(
            "withdraw_tax",
            format!(
                "{{\"owner\":\"{}\",\"to\":\"{}\",\"amount\":\"{}\",\"yield\":\"{}\"}}",
                owner, to, amount, bonus
            ),
        );
        let memo = if bonus > 0 {
            "Steady Pay savings released + demo yield"
        } else {
            "Steady Pay savings released"
        };
        send(to, amount + bonus, token_of(&owner), memo).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_payout(
                    owner,
                    U128(amount + bonus),
                    Payout::TaxWithYield {
                        yield_amount: U128(bonus),
                    },
                ),
        )
    }

    /// Lower your salary. It can never be raised.
    pub fn lower_salary(&mut self, new_salary: U128) -> VaultView {
        let owner = env::predecessor_account_id();
        require!(
            !is_instant(&owner),
            "An instant vault has no salary to lower"
        );
        let vault = self
            .vaults
            .get_mut(&owner)
            .unwrap_or_else(|| env::panic_str("No vault found for this account"));
        require!(new_salary.0 > 0, "Salary must be more than zero");
        require!(
            new_salary.0 < vault.salary,
            "Salary can only go down, never up"
        );
        vault.salary = new_salary.0;
        log_event(
            "lower_salary",
            format!(
                "{{\"owner\":\"{}\",\"salary\":\"{}\"}}",
                owner, new_salary.0
            ),
        );
        self.view_of(&owner).unwrap()
    }

    /// Rolls a payout back if the transfer failed (e.g. the tax wallet account does not exist).
    #[private]
    pub fn on_payout(&mut self, owner: AccountId, amount: U128, kind: Payout) -> bool {
        // A NEAR transfer and ft_transfer both return no data; any Ok means it went through.
        let ok = env::promise_result_checked(0, 64).is_ok();
        if ok {
            return true;
        }
        if let Some(vault) = self.vaults.get_mut(&owner) {
            match kind {
                Payout::Salary {
                    prev_next_payday_ms,
                } => {
                    vault.pot += amount.0;
                    vault.total_salary_paid -= amount.0;
                    vault.next_payday_ms = prev_next_payday_ms;
                }
                Payout::Tax => {
                    vault.tax_bucket += amount.0;
                    vault.total_tax_withdrawn -= amount.0;
                }
                Payout::TaxWithYield { yield_amount } => {
                    let savings = amount.0 - yield_amount.0;
                    vault.tax_bucket += savings;
                    vault.total_tax_withdrawn -= savings;
                    let mut y = read_yield(&owner);
                    y.accrued += yield_amount.0;
                    y.paid -= yield_amount.0;
                    write_yield(&owner, &y);
                    write_reserve(read_reserve() + yield_amount.0);
                }
            }
        }
        log_event(
            "payout_failed",
            format!("{{\"owner\":\"{}\",\"amount\":\"{}\"}}", owner, amount.0),
        );
        false
    }

    // ---------- views ----------

    pub fn get_vault(&self, owner: AccountId) -> Option<VaultView> {
        self.view_of(&owner)
    }

    pub fn get_vault_count(&self) -> u64 {
        self.vault_count
    }

    /// Top up the demo yield reserve with the attached NEAR. Anyone can call it.
    #[payable]
    pub fn fund_yield_reserve(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach some NEAR to add to the yield reserve");
        let total = read_reserve() + amount;
        write_reserve(total);
        log_event(
            "fund_yield_reserve",
            format!(
                "{{\"from\":\"{}\",\"amount\":\"{}\"}}",
                env::predecessor_account_id(),
                amount
            ),
        );
        U128(total)
    }

    /// NEAR left in the demo yield reserve.
    pub fn get_yield_reserve(&self) -> U128 {
        U128(read_reserve())
    }

    pub fn get_limits(&self) -> Limits {
        Limits {
            min_create_deposit: U128(MIN_CREATE_DEPOSIT),
            min_period_ms: MIN_PERIOD_MS,
            max_period_ms: MAX_PERIOD_MS,
            max_tax_percent: MAX_TAX_PERCENT,
        }
    }
}

impl SteadyPay {
    /// Split a payment into tax bucket and salary pot. The vault must exist.
    /// Split a payment into savings and the rest. Salary vaults keep the rest in the pot;
    /// instant vaults forward it to the owner straight away (state is updated before the transfer,
    /// and a failed transfer puts it back in the pot, where `claim_salary` can collect it).
    fn credit(&mut self, owner: &AccountId, amount: u128, from: &AccountId) {
        let instant = is_instant(owner);
        let vault = self.vaults.get_mut(owner).unwrap();
        write_yield(
            owner,
            &accrued_now(
                owner,
                vault.tax_bucket,
                env::block_timestamp_ms(),
                vault.created_ms,
            ),
        );
        let to_tax = amount * vault.tax_percent as u128 / 100;
        let to_pot = amount - to_tax;
        vault.tax_bucket += to_tax;
        vault.total_received += amount;
        if instant && to_pot > 0 {
            vault.total_salary_paid += to_pot;
            let keep_payday = vault.next_payday_ms;
            // Detached promise: scheduled when dropped at the end of this call.
            let _ = send(owner.clone(), to_pot, token_of(owner), "Steady Pay payment").then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout(
                        owner.clone(),
                        U128(to_pot),
                        Payout::Salary {
                            prev_next_payday_ms: keep_payday,
                        },
                    ),
            );
        } else {
            vault.pot += to_pot;
        }
        log_event(
            "deposit",
            format!(
                "{{\"owner\":\"{}\",\"from\":\"{}\",\"amount\":\"{}\",\"to_tax\":\"{}\",\"to_pot\":\"{}\"}}",
                owner, from, amount, to_tax, to_pot
            ),
        );
    }

    fn view_of(&self, owner: &AccountId) -> Option<VaultView> {
        let now = env::block_timestamp_ms();
        self.vaults.get(owner).map(|v| VaultView {
            owner: owner.clone(),
            token: token_of(owner),
            savings_unlock_ms: unlock_of(owner),
            instant: is_instant(owner),
            yield_earned: U128(accrued_now(owner, v.tax_bucket, now, v.created_ms).accrued),
            yield_paid: U128(read_yield(owner).paid),
            yield_apy_bps: if token_of(owner).is_some() {
                0
            } else {
                DEMO_YIELD_APY_BPS as u16
            },
            salary: U128(v.salary),
            period_ms: v.period_ms,
            tax_percent: v.tax_percent,
            tax_wallet: v.tax_wallet.clone(),
            pot: U128(v.pot),
            tax_bucket: U128(v.tax_bucket),
            next_payday_ms: v.next_payday_ms,
            storage_deposit: U128(v.storage_deposit),
            total_received: U128(v.total_received),
            total_salary_paid: U128(v.total_salary_paid),
            total_tax_withdrawn: U128(v.total_tax_withdrawn),
            created_ms: v.created_ms,
            periods_covered: (v.pot / v.salary).min(u64::MAX as u128) as u64,
            periods_owed: if is_instant(owner) {
                0
            } else {
                periods_owed(v, now)
            },
            claimable_now: U128(if is_instant(owner) {
                v.pot
            } else {
                claimable(v, now)
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const T0: u64 = 1_700_000_000_000; // ms

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(who: &str, deposit: u128, now_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("steadypay.testnet"))
            .account_balance(NearToken::from_near(1_000_000))
            .predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now_ms * 1_000_000);
        testing_env!(b.build());
    }

    fn callback_ctx(now_ms: u64, result: PromiseResult) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("steadypay.testnet"))
            .predecessor_account_id(acc("steadypay.testnet"))
            .account_balance(NearToken::from_near(1_000_000))
            .block_timestamp(now_ms * 1_000_000);
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    /// Alice: 100 NEAR salary, 60 s period, 30% tax to tax.alice.testnet.
    fn setup() -> SteadyPay {
        ctx("alice.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("alice.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(100 * NEAR),
            60_000,
            30,
            Some(acc("tax.alice.testnet")),
            None,
            None,
            None,
        );
        c
    }

    fn pay(c: &mut SteadyPay, amount: u128, now_ms: u64) -> VaultView {
        ctx("client.testnet", amount, now_ms);
        c.deposit(acc("alice.testnet"))
    }

    fn view(c: &SteadyPay, now_ms: u64) -> VaultView {
        ctx("anyone.testnet", 0, now_ms);
        c.get_vault(acc("alice.testnet")).unwrap()
    }

    #[test]
    fn create_vault_sets_fields() {
        let c = setup();
        let v = view(&c, T0);
        assert_eq!(v.salary, U128(100 * NEAR));
        assert_eq!(v.period_ms, 60_000);
        assert_eq!(v.tax_percent, 30);
        assert_eq!(v.tax_wallet, acc("tax.alice.testnet"));
        assert_eq!(v.pot, U128(0));
        assert_eq!(v.tax_bucket, U128(0));
        assert_eq!(v.next_payday_ms, T0 + 60_000);
        assert_eq!(c.get_vault_count(), 1);
    }

    #[test]
    fn create_vault_extra_deposit_is_split() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT + 10 * NEAR, T0);
        let v = c.create_vault(
            U128(NEAR),
            60_000,
            20,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
        assert_eq!(v.tax_bucket, U128(2 * NEAR));
        assert_eq!(v.pot, U128(8 * NEAR));
        assert_eq!(v.total_received, U128(10 * NEAR));
    }

    #[test]
    #[should_panic(expected = "Attach at least 0.01 NEAR to create a vault")]
    fn create_vault_needs_deposit() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT - 1, T0);
        c.create_vault(
            U128(NEAR),
            60_000,
            10,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "You already have a vault")]
    fn one_vault_per_account() {
        let mut c = setup();
        ctx("alice.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(NEAR),
            60_000,
            10,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "Pay period must be between 60 seconds and 366 days")]
    fn period_too_short() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(NEAR),
            59_999,
            10,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "Pay period must be between 60 seconds and 366 days")]
    fn period_too_long() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(NEAR),
            MAX_PERIOD_MS + 1,
            10,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "Tax percent must be between 0 and 50")]
    fn tax_too_high() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(NEAR),
            60_000,
            51,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "Salary must be more than zero")]
    fn zero_salary_rejected() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(0),
            60_000,
            10,
            Some(acc("tax.testnet")),
            None,
            None,
            None,
        );
    }

    #[test]
    fn deposit_splits_tax_and_pot() {
        let mut c = setup();
        let v = pay(&mut c, 1_000 * NEAR, T0 + 1);
        assert_eq!(v.tax_bucket, U128(300 * NEAR));
        assert_eq!(v.pot, U128(700 * NEAR));
        assert_eq!(v.periods_covered, 7);
        assert!(get_logs()[0].contains("\"event\":\"deposit\""));
    }

    #[test]
    fn deposit_rounding_never_loses_money() {
        let mut c = setup();
        let v = pay(&mut c, 7, T0 + 1); // 7 yocto * 30% = 2.1 -> 2 to tax
        assert_eq!(v.tax_bucket.0 + v.pot.0, 7);
        assert_eq!(v.tax_bucket, U128(2));
    }

    #[test]
    #[should_panic(expected = "No vault found for this account")]
    fn deposit_to_missing_vault() {
        let mut c = setup();
        ctx("client.testnet", NEAR, T0);
        c.deposit(acc("nobody.testnet"));
    }

    #[test]
    #[should_panic(expected = "Attach some NEAR to pay")]
    fn deposit_needs_amount() {
        let mut c = setup();
        pay(&mut c, 0, T0);
    }

    #[test]
    #[should_panic(expected = "It is not payday yet")]
    fn claim_before_payday_fails() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0 + 59_999);
        let _ = c.claim_salary();
    }

    #[test]
    fn claim_pays_one_salary_and_advances_payday() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0 + 60_000);
        let _ = c.claim_salary();
        let v = view(&c, T0 + 60_000);
        assert_eq!(v.pot, U128(600 * NEAR));
        assert_eq!(v.total_salary_paid, U128(100 * NEAR));
        assert_eq!(v.next_payday_ms, T0 + 120_000);
    }

    #[test]
    fn claim_pays_all_missed_periods() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        // 3 paydays have passed: T0+60s, T0+120s, T0+180s.
        let now = T0 + 185_000;
        assert_eq!(view(&c, now).periods_owed, 3);
        assert_eq!(view(&c, now).claimable_now, U128(300 * NEAR));
        ctx("alice.testnet", 0, now);
        let _ = c.claim_salary();
        let v = view(&c, now);
        assert_eq!(v.pot, U128(400 * NEAR));
        assert_eq!(v.next_payday_ms, T0 + 240_000);
        assert_eq!(v.periods_owed, 0);
    }

    #[test]
    fn claim_is_capped_by_pot() {
        let mut c = setup();
        pay(&mut c, 200 * NEAR, T0); // pot 140
        ctx("alice.testnet", 0, T0 + 60_000 * 5);
        let _ = c.claim_salary();
        let v = view(&c, T0 + 60_000 * 5);
        assert_eq!(v.pot, U128(0));
        assert_eq!(v.total_salary_paid, U128(140 * NEAR));
    }

    #[test]
    #[should_panic(expected = "Your salary pot is empty")]
    fn claim_with_empty_pot_fails() {
        let mut c = setup();
        ctx("alice.testnet", 0, T0 + 60_000);
        let _ = c.claim_salary();
    }

    #[test]
    fn quiet_months_still_pay() {
        // One 1,000 NEAR payment with 30% tax funds seven 100 NEAR salaries.
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        for i in 1..=7u64 {
            ctx("alice.testnet", 0, T0 + 60_000 * i);
            let _ = c.claim_salary();
        }
        let v = view(&c, T0 + 60_000 * 7);
        assert_eq!(v.pot, U128(0));
        assert_eq!(v.total_salary_paid, U128(700 * NEAR));
    }

    #[test]
    fn withdraw_tax_all_and_partial() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0);
        let _ = c.withdraw_tax(Some(U128(100 * NEAR)));
        assert_eq!(view(&c, T0).tax_bucket, U128(200 * NEAR));
        ctx("alice.testnet", 0, T0);
        let _ = c.withdraw_tax(None);
        let v = view(&c, T0);
        assert_eq!(v.tax_bucket, U128(0));
        assert_eq!(v.total_tax_withdrawn, U128(300 * NEAR));
        assert_eq!(v.pot, U128(700 * NEAR)); // pot untouched
    }

    #[test]
    #[should_panic(expected = "That is more than your tax savings")]
    fn withdraw_tax_over_bucket_fails() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0);
        let _ = c.withdraw_tax(Some(U128(301 * NEAR)));
    }

    #[test]
    #[should_panic(expected = "No vault found for this account")]
    fn stranger_cannot_withdraw_tax() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("mallory.testnet", 0, T0);
        let _ = c.withdraw_tax(None);
    }

    #[test]
    fn lower_salary_works() {
        let mut c = setup();
        ctx("alice.testnet", 0, T0);
        let v = c.lower_salary(U128(50 * NEAR));
        assert_eq!(v.salary, U128(50 * NEAR));
    }

    #[test]
    #[should_panic(expected = "Salary can only go down, never up")]
    fn raise_salary_fails() {
        let mut c = setup();
        ctx("alice.testnet", 0, T0);
        c.lower_salary(U128(101 * NEAR));
    }

    #[test]
    #[should_panic(expected = "Salary can only go down, never up")]
    fn same_salary_fails() {
        let mut c = setup();
        ctx("alice.testnet", 0, T0);
        c.lower_salary(U128(100 * NEAR));
    }

    #[test]
    fn failed_tax_transfer_is_rolled_back() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0);
        let _ = c.withdraw_tax(None);
        callback_ctx(T0, PromiseResult::Failed);
        assert!(!c.on_payout(acc("alice.testnet"), U128(300 * NEAR), Payout::Tax));
        let v = view(&c, T0);
        assert_eq!(v.tax_bucket, U128(300 * NEAR));
        assert_eq!(v.total_tax_withdrawn, U128(0));
    }

    #[test]
    fn failed_salary_transfer_is_rolled_back() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0 + 60_000);
        let _ = c.claim_salary();
        callback_ctx(T0 + 60_000, PromiseResult::Failed);
        c.on_payout(
            acc("alice.testnet"),
            U128(100 * NEAR),
            Payout::Salary {
                prev_next_payday_ms: T0 + 60_000,
            },
        );
        let v = view(&c, T0 + 60_000);
        assert_eq!(v.pot, U128(700 * NEAR));
        assert_eq!(v.next_payday_ms, T0 + 60_000);
        assert_eq!(v.total_salary_paid, U128(0));
    }

    #[test]
    fn successful_payout_keeps_state() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0);
        let _ = c.withdraw_tax(None);
        callback_ctx(T0, PromiseResult::Successful(vec![]));
        assert!(c.on_payout(acc("alice.testnet"), U128(300 * NEAR), Payout::Tax));
        assert_eq!(view(&c, T0).tax_bucket, U128(0));
    }

    // ---------- token vaults ----------

    const USD: u128 = 1_000_000; // 6 decimals

    /// Bob: 100 USDC salary, 60 s period, 30% tax, paid in usdc.testnet.
    fn setup_token() -> SteadyPay {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(100 * USD),
            60_000,
            30,
            Some(acc("tax.bob.testnet")),
            Some(acc("usdc.testnet")),
            None,
            None,
        );
        c
    }

    fn ft_pay(c: &mut SteadyPay, token: &str, amount: u128, msg: &str) -> PromiseOrValue<U128> {
        ctx(token, 0, T0);
        c.ft_on_transfer(acc("client.testnet"), U128(amount), msg.to_string())
    }

    fn bob(c: &SteadyPay, now_ms: u64) -> VaultView {
        ctx("anyone.testnet", 0, now_ms);
        c.get_vault(acc("bob.testnet")).unwrap()
    }

    #[test]
    fn token_vault_records_token() {
        let c = setup_token();
        assert_eq!(bob(&c, T0).token, Some(acc("usdc.testnet")));
        assert_eq!(view(&setup(), T0).token, None);
    }

    #[test]
    fn token_payment_is_split() {
        let mut c = setup_token();
        match ft_pay(&mut c, "usdc.testnet", 1_000 * USD, " bob.testnet ") {
            PromiseOrValue::Value(unused) => assert_eq!(unused, U128(0)),
            _ => panic!("expected a value"),
        }
        let v = bob(&c, T0);
        assert_eq!(v.tax_bucket, U128(300 * USD));
        assert_eq!(v.pot, U128(700 * USD));
        assert_eq!(v.total_received, U128(1_000 * USD));
        assert_eq!(v.periods_covered, 7);
    }

    #[test]
    #[should_panic(expected = "This vault does not accept this token")]
    fn wrong_token_rejected() {
        let mut c = setup_token();
        let _ = ft_pay(&mut c, "fake-usdc.testnet", 1_000 * USD, "bob.testnet");
    }

    #[test]
    #[should_panic(expected = "This vault does not accept this token")]
    fn near_vault_rejects_tokens() {
        let mut c = setup();
        let _ = ft_pay(&mut c, "usdc.testnet", 1_000 * USD, "alice.testnet");
    }

    #[test]
    #[should_panic(expected = "Put the vault owner's account ID in msg")]
    fn token_payment_needs_owner_in_msg() {
        let mut c = setup_token();
        let _ = ft_pay(&mut c, "usdc.testnet", 1_000 * USD, "not an account!");
    }

    #[test]
    #[should_panic(expected = "No vault found for this account")]
    fn token_payment_to_missing_vault() {
        let mut c = setup_token();
        let _ = ft_pay(&mut c, "usdc.testnet", 1_000 * USD, "nobody.testnet");
    }

    #[test]
    #[should_panic(expected = "This vault is paid in usdc.testnet, not NEAR")]
    fn token_vault_rejects_near() {
        let mut c = setup_token();
        ctx("client.testnet", NEAR, T0);
        c.deposit(acc("bob.testnet"));
    }

    #[test]
    #[should_panic(expected = "A token vault only takes 0.01 NEAR at setup")]
    fn token_vault_rejects_extra_near_at_setup() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT + NEAR, T0);
        c.create_vault(
            U128(USD),
            60_000,
            30,
            Some(acc("tax.testnet")),
            Some(acc("usdc.testnet")),
            None,
            None,
        );
    }

    #[test]
    fn token_vault_claim_and_tax_follow_same_rules() {
        let mut c = setup_token();
        let _ = ft_pay(&mut c, "usdc.testnet", 1_000 * USD, "bob.testnet");
        ctx("bob.testnet", 0, T0 + 120_000);
        let _ = c.claim_salary(); // 2 paydays owed
        ctx("bob.testnet", 0, T0 + 120_000);
        let _ = c.withdraw_tax(Some(U128(100 * USD)));
        let v = bob(&c, T0 + 120_000);
        assert_eq!(v.pot, U128(500 * USD));
        assert_eq!(v.total_salary_paid, U128(200 * USD));
        assert_eq!(v.tax_bucket, U128(200 * USD));
        assert_eq!(v.next_payday_ms, T0 + 180_000);
    }

    #[test]
    fn failed_token_payout_is_rolled_back() {
        // e.g. the owner is not registered with the token contract
        let mut c = setup_token();
        let _ = ft_pay(&mut c, "usdc.testnet", 1_000 * USD, "bob.testnet");
        ctx("bob.testnet", 0, T0 + 60_000);
        let _ = c.claim_salary();
        callback_ctx(T0 + 60_000, PromiseResult::Failed);
        c.on_payout(
            acc("bob.testnet"),
            U128(100 * USD),
            Payout::Salary {
                prev_next_payday_ms: T0 + 60_000,
            },
        );
        let v = bob(&c, T0 + 60_000);
        assert_eq!(v.pot, U128(700 * USD));
        assert_eq!(v.total_salary_paid, U128(0));
        assert_eq!(v.next_payday_ms, T0 + 60_000);
    }

    // ---------- savings date lock + payout messages ----------

    const DAY: u64 = 86_400_000;

    /// Carol: 100 NEAR salary, 60 s period, 30% savings, no savings wallet (defaults to her),
    /// savings locked until T0 + 1 day.
    fn setup_locked() -> SteadyPay {
        ctx("carol.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("carol.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(100 * NEAR),
            60_000,
            30,
            None,
            None,
            Some(T0 + DAY),
            None,
        );
        ctx("client.testnet", 1_000 * NEAR, T0);
        c.deposit(acc("carol.testnet"));
        c
    }

    fn carol(c: &SteadyPay, now_ms: u64) -> VaultView {
        ctx("anyone.testnet", 0, now_ms);
        c.get_vault(acc("carol.testnet")).unwrap()
    }

    #[test]
    fn savings_wallet_defaults_to_owner_and_unlock_is_shown() {
        let c = setup_locked();
        let v = carol(&c, T0);
        assert_eq!(v.tax_wallet, acc("carol.testnet"));
        assert_eq!(v.savings_unlock_ms, Some(T0 + DAY));
        assert_eq!(v.tax_bucket, U128(300 * NEAR));
        // vaults without a date lock report none
        assert_eq!(view(&setup(), T0).savings_unlock_ms, None);
    }

    #[test]
    #[should_panic(expected = "Your savings are locked until the unlock date")]
    fn locked_savings_cannot_move_before_the_date() {
        let mut c = setup_locked();
        ctx("carol.testnet", 0, T0 + DAY - 1);
        let _ = c.withdraw_tax(None);
    }

    #[test]
    fn savings_move_on_and_after_the_date() {
        let mut c = setup_locked();
        ctx("carol.testnet", 0, T0 + DAY);
        let _ = c.withdraw_tax(Some(U128(100 * NEAR)));
        assert!(get_logs()
            .iter()
            .any(|l| l == "Steady Pay savings released"));
        ctx("carol.testnet", 0, T0 + 2 * DAY);
        let _ = c.withdraw_tax(None);
        let v = carol(&c, T0 + 2 * DAY);
        assert_eq!(v.tax_bucket, U128(0));
        assert_eq!(v.total_tax_withdrawn, U128(300 * NEAR));
    }

    #[test]
    fn date_lock_does_not_block_salary() {
        let mut c = setup_locked();
        ctx("carol.testnet", 0, T0 + 120_000);
        let _ = c.claim_salary();
        assert!(get_logs()
            .iter()
            .any(|l| l == "Steady Pay salary · 2 paydays"));
        assert_eq!(carol(&c, T0 + 120_000).pot, U128(500 * NEAR));
    }

    #[test]
    #[should_panic(expected = "Savings unlock date must be in the future")]
    fn unlock_date_in_the_past_is_rejected() {
        ctx("dan.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("dan.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(U128(NEAR), 60_000, 30, None, None, Some(T0), None);
    }

    #[test]
    #[should_panic(expected = "Savings unlock date must be within 10 years")]
    fn unlock_date_too_far_is_rejected() {
        ctx("dan.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("dan.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(NEAR),
            60_000,
            30,
            None,
            None,
            Some(T0 + MAX_UNLOCK_AHEAD_MS + 1),
            None,
        );
    }

    #[test]
    fn single_payday_message_is_singular() {
        let mut c = setup();
        pay(&mut c, 1_000 * NEAR, T0);
        ctx("alice.testnet", 0, T0 + 60_000);
        let _ = c.claim_salary();
        assert!(get_logs()
            .iter()
            .any(|l| l == "Steady Pay salary · 1 payday"));
    }

    // ---------- instant vaults: savings locked, the rest goes straight to the owner ----------

    /// Erin: instant NEAR vault, 30% savings locked until T0 + 1 day.
    fn setup_instant() -> SteadyPay {
        ctx("erin.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("erin.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(NEAR),
            60_000,
            30,
            None,
            None,
            Some(T0 + DAY),
            Some(true),
        );
        c
    }

    fn erin(c: &SteadyPay, now_ms: u64) -> VaultView {
        ctx("anyone.testnet", 0, now_ms);
        c.get_vault(acc("erin.testnet")).unwrap()
    }

    #[test]
    fn instant_payment_keeps_savings_and_forwards_the_rest() {
        let mut c = setup_instant();
        ctx("client.testnet", 1_000 * NEAR, T0);
        c.deposit(acc("erin.testnet"));
        assert!(get_logs().iter().any(|l| l == "Steady Pay payment"));
        let v = erin(&c, T0);
        assert!(v.instant);
        assert_eq!(v.tax_bucket, U128(300 * NEAR)); // locked savings
        assert_eq!(v.pot, U128(0)); // nothing held back
        assert_eq!(v.total_salary_paid, U128(700 * NEAR)); // sent to Erin
        assert_eq!(v.total_received, U128(1_000 * NEAR));
    }

    #[test]
    fn instant_token_payment_is_forwarded() {
        ctx("fay.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("fay.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(
            U128(USD),
            60_000,
            20,
            None,
            Some(acc("usdc.testnet")),
            Some(T0 + DAY),
            Some(true),
        );
        let _ = ft_pay(&mut c, "usdc.testnet", 500 * USD, "fay.testnet");
        ctx("anyone.testnet", 0, T0);
        let v = c.get_vault(acc("fay.testnet")).unwrap();
        assert_eq!(v.tax_bucket, U128(100 * USD));
        assert_eq!(v.pot, U128(0));
        assert_eq!(v.total_salary_paid, U128(400 * USD));
    }

    #[test]
    fn failed_instant_forward_waits_in_the_vault_and_can_be_claimed() {
        let mut c = setup_instant();
        ctx("client.testnet", 1_000 * NEAR, T0);
        c.deposit(acc("erin.testnet"));
        callback_ctx(T0, PromiseResult::Failed);
        c.on_payout(
            acc("erin.testnet"),
            U128(700 * NEAR),
            Payout::Salary {
                prev_next_payday_ms: T0 + 60_000,
            },
        );
        let v = erin(&c, T0);
        assert_eq!(v.pot, U128(700 * NEAR));
        assert_eq!(v.claimable_now, U128(700 * NEAR));
        assert_eq!(v.total_salary_paid, U128(0));
        // no payday wait for instant vaults
        ctx("erin.testnet", 0, T0 + 1);
        let _ = c.claim_salary();
        let v = erin(&c, T0 + 1);
        assert_eq!(v.pot, U128(0));
        assert_eq!(v.total_salary_paid, U128(700 * NEAR));
    }

    #[test]
    #[should_panic(expected = "Your savings are locked until the unlock date")]
    fn instant_savings_stay_locked() {
        let mut c = setup_instant();
        ctx("client.testnet", 1_000 * NEAR, T0);
        c.deposit(acc("erin.testnet"));
        ctx("erin.testnet", 0, T0 + 1);
        let _ = c.withdraw_tax(None);
    }

    #[test]
    #[should_panic(expected = "There is nothing waiting for you")]
    fn instant_claim_with_nothing_waiting_fails() {
        let mut c = setup_instant();
        ctx("erin.testnet", 0, T0 + 120_000);
        let _ = c.claim_salary();
    }

    #[test]
    #[should_panic(expected = "An instant vault has no salary to lower")]
    fn instant_vault_has_no_salary_to_lower() {
        let mut c = setup_instant();
        ctx("erin.testnet", 0, T0);
        c.lower_salary(U128(1));
    }

    #[test]
    #[should_panic(expected = "An instant vault only takes 0.01 NEAR at setup")]
    fn instant_vault_rejects_starting_money() {
        ctx("gus.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("gus.testnet", MIN_CREATE_DEPOSIT + NEAR, T0);
        c.create_vault(U128(NEAR), 60_000, 30, None, None, None, Some(true));
    }

    #[test]
    fn salary_vaults_are_not_instant() {
        let mut c = setup();
        let v = pay(&mut c, 1_000 * NEAR, T0);
        assert!(!v.instant);
        assert_eq!(v.pot, U128(700 * NEAR));
    }

    // ---------- demo yield ----------

    const YEAR: u64 = 365 * DAY;

    fn fund(c: &mut SteadyPay, amount: u128) {
        ctx("sponsor.testnet", amount, T0);
        c.fund_yield_reserve();
    }

    #[test]
    fn savings_earn_demo_yield_over_time() {
        let c = setup_locked(); // carol: 300 NEAR savings from T0
        assert_eq!(carol(&c, T0).yield_earned, U128(0));
        assert_eq!(carol(&c, T0).yield_apy_bps, 800);
        // one year at 8% on 300 NEAR = 24 NEAR
        assert_eq!(carol(&c, T0 + YEAR).yield_earned, U128(24 * NEAR));
    }

    #[test]
    fn release_pays_savings_plus_yield_from_the_reserve() {
        let mut c = setup_locked();
        fund(&mut c, 100 * NEAR);
        ctx("carol.testnet", 0, T0 + YEAR);
        let _ = c.withdraw_tax(None);
        assert!(get_logs()
            .iter()
            .any(|l| l == "Steady Pay savings released + demo yield"));
        let v = carol(&c, T0 + YEAR);
        assert_eq!(v.tax_bucket, U128(0));
        assert_eq!(v.total_tax_withdrawn, U128(300 * NEAR));
        assert_eq!(v.yield_paid, U128(24 * NEAR));
        assert_eq!(v.yield_earned, U128(0));
        assert_eq!(c.get_yield_reserve(), U128(76 * NEAR));
    }

    #[test]
    fn yield_is_capped_by_the_reserve_and_the_rest_stays_owed() {
        let mut c = setup_locked();
        fund(&mut c, 10 * NEAR);
        ctx("carol.testnet", 0, T0 + YEAR);
        let _ = c.withdraw_tax(None);
        let v = carol(&c, T0 + YEAR);
        assert_eq!(v.yield_paid, U128(10 * NEAR));
        assert_eq!(v.yield_earned, U128(14 * NEAR)); // still owed
        assert_eq!(c.get_yield_reserve(), U128(0));
    }

    #[test]
    fn no_reserve_means_no_yield_paid_but_savings_still_release() {
        let mut c = setup_locked();
        ctx("carol.testnet", 0, T0 + YEAR);
        let _ = c.withdraw_tax(None);
        assert!(get_logs()
            .iter()
            .any(|l| l == "Steady Pay savings released"));
        let v = carol(&c, T0 + YEAR);
        assert_eq!(v.total_tax_withdrawn, U128(300 * NEAR));
        assert_eq!(v.yield_paid, U128(0));
        assert_eq!(v.yield_earned, U128(24 * NEAR));
    }

    #[test]
    fn new_payment_counts_yield_on_the_old_savings_first() {
        let mut c = setup_locked(); // 300 NEAR savings at T0
        ctx("client.testnet", 1_000 * NEAR, T0 + YEAR / 2);
        c.deposit(acc("carol.testnet")); // +300 savings, half a year in
                                         // first half year: 300 * 4% = 12; second half year: 600 * 4% = 24
        assert_eq!(carol(&c, T0 + YEAR).yield_earned, U128(36 * NEAR));
    }

    #[test]
    fn failed_release_puts_savings_yield_and_reserve_back() {
        let mut c = setup_locked();
        fund(&mut c, 100 * NEAR);
        ctx("carol.testnet", 0, T0 + YEAR);
        let _ = c.withdraw_tax(None);
        callback_ctx(T0 + YEAR, PromiseResult::Failed);
        c.on_payout(
            acc("carol.testnet"),
            U128(324 * NEAR),
            Payout::TaxWithYield {
                yield_amount: U128(24 * NEAR),
            },
        );
        let v = carol(&c, T0 + YEAR);
        assert_eq!(v.tax_bucket, U128(300 * NEAR));
        assert_eq!(v.total_tax_withdrawn, U128(0));
        assert_eq!(v.yield_paid, U128(0));
        assert_eq!(v.yield_earned, U128(24 * NEAR));
        assert_eq!(c.get_yield_reserve(), U128(100 * NEAR));
    }

    #[test]
    fn token_vaults_earn_no_demo_yield() {
        let mut c = setup_token();
        let _ = ft_pay(&mut c, "usdc.testnet", 1_000 * USD, "bob.testnet");
        let v = bob(&c, T0 + YEAR);
        assert_eq!(v.yield_apy_bps, 0);
        assert_eq!(v.yield_earned, U128(0));
    }

    #[test]
    #[should_panic(expected = "Attach some NEAR to add to the yield reserve")]
    fn funding_the_reserve_needs_near() {
        let mut c = setup();
        fund(&mut c, 0);
    }

    #[test]
    fn vaults_without_yield_books_count_from_creation() {
        let mut c = setup_locked();
        // simulate a vault made before the yield existed: remove its books
        env::storage_remove(&yield_key(&acc("carol.testnet")));
        assert_eq!(carol(&c, T0 + YEAR).yield_earned, U128(24 * NEAR));
        fund(&mut c, 100 * NEAR);
        ctx("carol.testnet", 0, T0 + YEAR);
        let _ = c.withdraw_tax(None);
        assert_eq!(carol(&c, T0 + YEAR).yield_paid, U128(24 * NEAR));
    }
}
