use std::time::Duration;

/// Counts requests in fixed windows of `len`.
pub struct FixedWindow {
    len: Duration,
    limit: u32,
    window_start: Duration,
    count: u32,
}

impl FixedWindow {
    pub fn new(len: Duration, limit: u32) -> Self {
        FixedWindow { len, limit, window_start: Duration::ZERO, count: 0 }
    }

    pub fn allow(&mut self, now: Duration) -> bool {
        if now >= self.window_start + self.len {
            self.window_start = now;
            self.count = 0;
        }
        if self.count < self.limit {
            self.count += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_limit_then_blocks() {
        let mut w = FixedWindow::new(Duration::from_secs(1), 2);
        assert!(w.allow(Duration::ZERO));
        assert!(w.allow(Duration::ZERO));
        assert!(!w.allow(Duration::ZERO));
    }

    #[test]
    fn resets_at_window_boundary() {
        let mut w = FixedWindow::new(Duration::from_secs(1), 1);
        assert!(w.allow(Duration::ZERO));
        assert!(!w.allow(Duration::from_millis(999)));
        assert!(w.allow(Duration::from_secs(1)));
    }
}
