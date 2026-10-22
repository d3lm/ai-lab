/// A half-open interval `[start, end)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Span {
    pub start: i64,
    pub end: i64,
}

/// Sorts spans and merges any that overlap or touch (`[1,3)` and `[3,5)`
/// become `[1,5)`). Empty spans (`start >= end`) are dropped.
pub fn merge(mut spans: Vec<Span>) -> Vec<Span> {
    spans.retain(|s| s.start < s.end);
    spans.sort();
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    for s in spans {
        match out.last_mut() {
            Some(last) if s.start <= last.end => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny deterministic generator so the property test needs no dependencies.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }

        fn spans(&mut self) -> Vec<Span> {
            let n = (self.next() % 6) as usize;
            (0..n)
                .map(|i| {
                    let start = (i as i64) * 10 + (self.next() % 3) as i64;
                    Span { start, end: start + 1 + (self.next() % 5) as i64 }
                })
                .collect()
        }
    }

    #[test]
    fn merged_spans_are_sorted_and_disjoint() {
        let mut rng = Lcg(7);
        for _ in 0..500 {
            let out = merge(rng.spans());
            for pair in out.windows(2) {
                assert!(pair[0].end < pair[1].start, "{out:?}");
            }
        }
    }

    #[test]
    fn merge_never_grows_the_list() {
        let mut rng = Lcg(11);
        for _ in 0..500 {
            let input = rng.spans();
            let n = input.len();
            assert!(merge(input).len() <= n);
        }
    }

    #[test]
    fn merges_overlapping_pair() {
        let out = merge(vec![Span { start: 1, end: 4 }, Span { start: 2, end: 6 }]);
        assert_eq!(out, vec![Span { start: 1, end: 6 }]);
    }
}
