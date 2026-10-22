use std::collections::HashMap;

/// Where balances live. Production uses a database; tests use [`MemStore`].
pub trait Store {
    fn balance(&self, account: &str) -> i64;
    fn set_balance(&mut self, account: &str, cents: i64);
}

#[derive(Default)]
pub struct MemStore {
    balances: HashMap<String, i64>,
}

impl Store for MemStore {
    fn balance(&self, account: &str) -> i64 {
        self.balances.get(account).copied().unwrap_or(0)
    }

    fn set_balance(&mut self, account: &str, cents: i64) {
        self.balances.insert(account.to_string(), cents);
    }
}
