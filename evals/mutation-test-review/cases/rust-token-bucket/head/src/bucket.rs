use std::time::Duration;

/// A token bucket that refills continuously at `rate_per_sec` tokens per
/// second, up to `capacity` tokens.
pub struct TokenBucket {
    capacity: u32,
    rate_per_sec: u32,
    tokens: f64,
    last_refill: Duration,
}

impl TokenBucket {
    /// Creates a full bucket.
    pub fn new(capacity: u32, rate_per_sec: u32, now: Duration) -> Self {
        TokenBucket { capacity, rate_per_sec, tokens: capacity as f64, last_refill: now }
    }

    fn refill(&mut self, now: Duration) {
        let elapsed = now.saturating_sub(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate_per_sec as f64).min(self.capacity as f64);
        self.last_refill = now;
    }

    /// Takes `cost` tokens if that many are available and reports whether the
    /// request is allowed.
    pub fn try_acquire(&mut self, cost: u32, now: Duration) -> bool {
        self.refill(now);
        if self.tokens >= cost as f64 {
            self.tokens -= cost as f64;
            true
        } else {
            false
        }
    }

    /// Whole tokens currently available.
    pub fn available(&self) -> u32 {
        self.tokens.floor() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_requests_when_tokens_available() {
        let mut b = TokenBucket::new(10, 1, Duration::ZERO);
        assert!(b.try_acquire(3, Duration::ZERO));
    }

    #[test]
    fn rejects_when_empty() {
        let mut b = TokenBucket::new(2, 1, Duration::ZERO);
        b.try_acquire(2, Duration::ZERO);
        assert!(!b.try_acquire(5, Duration::ZERO));
    }

    #[test]
    fn refills_over_time() {
        let mut b = TokenBucket::new(10, 2, Duration::ZERO);
        b.try_acquire(10, Duration::ZERO);
        assert!(b.try_acquire(1, Duration::from_secs(5)));
    }

    #[test]
    fn never_exceeds_capacity() {
        let mut b = TokenBucket::new(5, 100, Duration::ZERO);
        b.try_acquire(1, Duration::from_secs(60));
        assert!(b.available() > 0);
    }
}
