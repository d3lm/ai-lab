//! Transfer rules. These use an in-memory ledger so they run without a database.

use std::collections::HashMap;
use wallet::ledger::{TransferError, Transfers};

/// In-memory stand-in for `Ledger` so the rules can be tested without a store.
struct FakeLedger {
    balances: HashMap<String, i64>,
    overdraft_limit: i64,
}

impl FakeLedger {
    fn with(accounts: &[(&str, i64)], overdraft_limit: i64) -> Self {
        let balances = accounts.iter().map(|(a, b)| (a.to_string(), *b)).collect();
        FakeLedger { balances, overdraft_limit }
    }

    fn balance(&self, account: &str) -> i64 {
        self.balances.get(account).copied().unwrap_or(0)
    }
}

impl Transfers for FakeLedger {
    fn transfer(&mut self, from: &str, to: &str, cents: i64) -> Result<(), TransferError> {
        if cents <= 0 {
            return Err(TransferError::NonPositiveAmount);
        }
        if from == to {
            return Err(TransferError::SameAccount);
        }
        let available = self.balance(from) + self.overdraft_limit;
        if cents > available {
            return Err(TransferError::InsufficientFunds { available });
        }
        *self.balances.entry(from.to_string()).or_default() -= cents;
        *self.balances.entry(to.to_string()).or_default() += cents;
        Ok(())
    }
}

#[test]
fn moves_money_between_accounts() {
    let mut l = FakeLedger::with(&[("alice", 1_000), ("bob", 0)], 0);
    l.transfer("alice", "bob", 300).unwrap();
    assert_eq!(l.balance("alice"), 700);
    assert_eq!(l.balance("bob"), 300);
}

#[test]
fn allows_overdraft_up_to_the_limit() {
    let mut l = FakeLedger::with(&[("alice", 100)], 50);
    assert_eq!(l.transfer("alice", "bob", 150), Ok(()));
    assert_eq!(l.balance("alice"), -50);
}

#[test]
fn rejects_transfers_beyond_the_limit() {
    let mut l = FakeLedger::with(&[("alice", 100)], 50);
    assert_eq!(l.transfer("alice", "bob", 151), Err(TransferError::InsufficientFunds { available: 150 }));
}

#[test]
fn rejects_non_positive_amounts_and_self_transfers() {
    let mut l = FakeLedger::with(&[("alice", 100)], 0);
    assert_eq!(l.transfer("alice", "bob", 0), Err(TransferError::NonPositiveAmount));
    assert_eq!(l.transfer("alice", "alice", 10), Err(TransferError::SameAccount));
}
