use crate::store::Store;

#[derive(Debug, PartialEq, Eq)]
pub enum TransferError {
    NonPositiveAmount,
    SameAccount,
    /// The source would drop below its overdraft limit.
    InsufficientFunds { available: i64 },
}

/// Moves money between accounts. Accounts may go negative down to
/// `-overdraft_limit` cents.
pub trait Transfers {
    fn transfer(&mut self, from: &str, to: &str, cents: i64) -> Result<(), TransferError>;
}

pub struct Ledger<S: Store> {
    pub store: S,
    pub overdraft_limit: i64,
}

impl<S: Store> Transfers for Ledger<S> {
    fn transfer(&mut self, from: &str, to: &str, cents: i64) -> Result<(), TransferError> {
        if cents <= 0 {
            return Err(TransferError::NonPositiveAmount);
        }
        if from == to {
            return Err(TransferError::SameAccount);
        }
        let available = self.store.balance(from) + self.overdraft_limit;
        if cents > available {
            return Err(TransferError::InsufficientFunds { available });
        }
        let from_balance = self.store.balance(from);
        let to_balance = self.store.balance(to);
        self.store.set_balance(from, from_balance - cents);
        self.store.set_balance(to, to_balance + cents);
        Ok(())
    }
}
