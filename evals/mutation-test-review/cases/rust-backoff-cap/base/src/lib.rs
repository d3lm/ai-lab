//! Retry backoff schedules.

use std::time::Duration;

/// Exponential backoff: `base_ms * factor^attempt`.
pub struct Backoff {
    base_ms: u64,
    factor: u64,
    max_ms: u64,
}

impl Backoff {
    pub fn new(base_ms: u64, factor: u64, max_ms: u64) -> Self {
        Backoff { base_ms, factor, max_ms }
    }

    /// Delay before retry number `attempt` (0-based).
    pub fn delay(&self, attempt: u32) -> Duration {
        let ms = self.base_ms.saturating_mul(self.factor.saturating_pow(attempt));
        Duration::from_millis(ms)
    }

    pub fn max(&self) -> Duration {
        Duration::from_millis(self.max_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_attempt_uses_base_delay() {
        let b = Backoff::new(100, 2, 10_000);
        assert_eq!(b.delay(0), Duration::from_millis(100));
    }
}
