//! Steady Pay: a salary for people who don't have one.
//!
//! A freelancer creates a vault once (salary, pay period, tax percent, tax wallet).
//! Clients pay into the vault with `deposit(owner)`. Every payment is split on arrival:
//! `tax_percent` goes to a tax bucket that can only ever be sent to the tax wallet,
//! the rest goes to the salary pot. The owner claims a fixed salary each period.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
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

/// JSON view of a vault. Amounts are yoctoNEAR strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VaultView {
    pub owner: AccountId,
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
    Salary { prev_next_payday_ms: u64 },
    Tax,
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
    #[payable]
    pub fn create_vault(
        &mut self,
        salary: U128,
        period_ms: u64,
        tax_percent: u8,
        tax_wallet: AccountId,
    ) -> VaultView {
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

        let now = env::block_timestamp_ms();
        let extra = attached - MIN_CREATE_DEPOSIT;
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
        log_event(
            "create_vault",
            format!("{{\"owner\":\"{}\",\"salary\":\"{}\"}}", owner, salary.0),
        );
        self.view_of(&owner).unwrap()
    }

    /// Pay `owner`. Anyone can call this. The attached NEAR is split into tax and salary pot.
    #[payable]
    pub fn deposit(&mut self, owner: AccountId) -> VaultView {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach some NEAR to pay");
        let vault = self
            .vaults
            .get_mut(&owner)
            .unwrap_or_else(|| env::panic_str("No vault found for this account"));
        let to_tax = amount * vault.tax_percent as u128 / 100;
        let to_pot = amount - to_tax;
        vault.tax_bucket += to_tax;
        vault.pot += to_pot;
        vault.total_received += amount;
        log_event(
            "deposit",
            format!(
                "{{\"owner\":\"{}\",\"from\":\"{}\",\"amount\":\"{}\",\"to_tax\":\"{}\",\"to_pot\":\"{}\"}}",
                owner,
                env::predecessor_account_id(),
                amount,
                to_tax,
                to_pot
            ),
        );
        self.view_of(&owner).unwrap()
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
        let owed = periods_owed(vault, now);
        require!(owed > 0, "It is not payday yet");
        let pay = claimable(vault, now);
        require!(pay > 0, "Your salary pot is empty");

        let prev = vault.next_payday_ms;
        // Update state before transferring.
        vault.pot -= pay;
        vault.total_salary_paid += pay;
        vault.next_payday_ms = prev + owed * vault.period_ms;
        log_event(
            "claim_salary",
            format!(
                "{{\"owner\":\"{}\",\"amount\":\"{}\",\"periods\":{}}}",
                owner, pay, owed
            ),
        );

        Promise::new(owner.clone())
            .transfer(NearToken::from_yoctonear(pay))
            .then(
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
    /// and the money can only go to the tax wallet. Omit `amount` to send everything.
    pub fn withdraw_tax(&mut self, amount: Option<U128>) -> Promise {
        let owner = env::predecessor_account_id();
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
        vault.tax_bucket -= amount;
        vault.total_tax_withdrawn += amount;
        let to = vault.tax_wallet.clone();
        log_event(
            "withdraw_tax",
            format!(
                "{{\"owner\":\"{}\",\"to\":\"{}\",\"amount\":\"{}\"}}",
                owner, to, amount
            ),
        );
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout(owner, U128(amount), Payout::Tax),
            )
    }

    /// Lower your salary. It can never be raised.
    pub fn lower_salary(&mut self, new_salary: U128) -> VaultView {
        let owner = env::predecessor_account_id();
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
            format!("{{\"owner\":\"{}\",\"salary\":\"{}\"}}", owner, new_salary.0),
        );
        self.view_of(&owner).unwrap()
    }

    /// Rolls a payout back if the transfer failed (e.g. the tax wallet account does not exist).
    #[private]
    pub fn on_payout(&mut self, owner: AccountId, amount: U128, kind: Payout) -> bool {
        // A plain transfer returns no data; any Ok means it went through.
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
    fn view_of(&self, owner: &AccountId) -> Option<VaultView> {
        let now = env::block_timestamp_ms();
        self.vaults.get(owner).map(|v| VaultView {
            owner: owner.clone(),
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
            periods_owed: periods_owed(v, now),
            claimable_now: U128(claimable(v, now)),
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
        c.create_vault(U128(100 * NEAR), 60_000, 30, acc("tax.alice.testnet"));
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
        let v = c.create_vault(U128(NEAR), 60_000, 20, acc("tax.testnet"));
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
        c.create_vault(U128(NEAR), 60_000, 10, acc("tax.testnet"));
    }

    #[test]
    #[should_panic(expected = "You already have a vault")]
    fn one_vault_per_account() {
        let mut c = setup();
        ctx("alice.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(U128(NEAR), 60_000, 10, acc("tax.testnet"));
    }

    #[test]
    #[should_panic(expected = "Pay period must be between 60 seconds and 366 days")]
    fn period_too_short() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(U128(NEAR), 59_999, 10, acc("tax.testnet"));
    }

    #[test]
    #[should_panic(expected = "Pay period must be between 60 seconds and 366 days")]
    fn period_too_long() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(U128(NEAR), MAX_PERIOD_MS + 1, 10, acc("tax.testnet"));
    }

    #[test]
    #[should_panic(expected = "Tax percent must be between 0 and 50")]
    fn tax_too_high() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(U128(NEAR), 60_000, 51, acc("tax.testnet"));
    }

    #[test]
    #[should_panic(expected = "Salary must be more than zero")]
    fn zero_salary_rejected() {
        ctx("bob.testnet", 0, T0);
        let mut c = SteadyPay::new();
        ctx("bob.testnet", MIN_CREATE_DEPOSIT, T0);
        c.create_vault(U128(0), 60_000, 10, acc("tax.testnet"));
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
}
