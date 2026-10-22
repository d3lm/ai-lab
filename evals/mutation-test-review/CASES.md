# Eval Cases

28 cases, 67 planted defects. Each defect is verified by `verify.py` (tool = a surviving cargo-mutants/Stryker mutant, hand = a hand-applied mutation the tests miss, revert = the new test passes on the pre-change code, static = a test that cannot fail as written, also backed by a hand mutation).

| case | lang | scope | invocation | defects (kind) |
|---|---|---|---|---|
| rust-acl-tests | rust | branch | `/mutation-test-review` | no-read-denial (tool), fixture-ids-collide (static), no-write-denial-for-member (tool) |
| rust-adler-deleted-tests | rust | branch | `/mutation-test-review HEAD~1..HEAD` | deleted-test-not-redundant (hand), self-comparison (static) |
| rust-backoff-cap | rust | branch | `/mutation-test-review` | cap-never-reached (revert), relational-growth (hand) |
| rust-config-parser | rust | uncommitted | `/mutation-test-review` | error-variant-and-line (tool), values-never-checked (hand) |
| rust-control-semver | rust | branch | `/mutation-test-review` | control: none |
| rust-hard-e2e-suite | rust | branch | `/mutation-test-review` | e2e-suite-caught-elsewhere (static), fold-weakly-tested (tool) |
| rust-hard-frame-codec | rust | branch | `/mutation-test-review` | length-form-boundaries (hand), mask-roundtrip-untested (tool), size-limit-and-truncation-detail (tool) |
| rust-hard-golden-whitespace | rust | branch | `/mutation-test-review` | golden-ignores-padding (tool), update-golden-self-pass (static) |
| rust-hard-refactor-move | rust | branch | `/mutation-test-review` | negative-exponent-test-dropped (hand), overflow-test-ignored (hand) |
| rust-hard-tested-double | rust | branch | `/mutation-test-review` | tests-exercise-a-copy (tool), store-writes-unverified (static) |
| rust-hard-weak-property | rust | branch | `/mutation-test-review` | generator-never-overlaps (hand), property-not-coverage-preserving (hand), empty-spans-untested (tool) |
| rust-lru-cache | rust | branch | `/mutation-test-review` | guarded-assertion (static), lru-order-untested (tool), update-value-unchecked (hand) |
| rust-token-bucket | rust | branch | `/mutation-test-review` | boundary (hand), never-empties (tool), capacity-cap (hand), refill-rate (tool) |
| rust-varint | rust | uncommitted | `/mutation-test-review` | single-byte-only (tool), no-golden-bytes (static), consumed-length-unchecked (tool), error-variants (tool) |
| ts-control-duration | ts | branch | `/mutation-test-review` | control: none |
| ts-csv-fixtures | ts | branch | `/mutation-test-review` | fixture-loop-empty (static), no-carriage-return-case (hand) |
| ts-emitter | ts | branch | `/mutation-test-review` | removal-wrong-event (static), once-single-emit (tool), listener-cleanup (tool) |
| ts-hard-mocked-unit | ts | branch | `/mutation-test-review` | tax-module-mocked (tool), discount-mocked-away (tool) |
| ts-hard-refactor-wrap | ts | branch | `/mutation-test-review` | wrap-change-untested (revert), truncate-middle-split (tool) |
| ts-hard-sandbox-drop | ts | branch | `/mutation-test-review` | sandbox-drops-vector-tests (static), dangling-length-untested (tool) |
| ts-hard-snapshot-bug | ts | branch | `/mutation-test-review` | snapshot-pins-bug (static), negative-amounts-untested (tool) |
| ts-hard-ttl-polling | ts | branch | `/mutation-test-review` | polling-turns-bugs-into-timeouts (tool), expiry-boundary (hand), prune-count-and-survivors (tool) |
| ts-hard-vacuous-asserts | ts | branch | `/mutation-test-review` | conditional-assertions (static), spy-wrong-channel (static), port-boundaries (tool) |
| ts-order-totals | ts | uncommitted | `/mutation-test-review` | asserts-mock-return (tool), truthy-object (static), coupon-clamp (tool) |
| ts-paginate | ts | branch | `/mutation-test-review main` | partial-last-page (hand), clamping-untested (tool), hasnext-true (tool) |
| ts-range-clamp | ts | branch | `/mutation-test-review HEAD~1..HEAD` | regression-test-passes-on-old-code (revert), unsatisfiable-path (tool) |
| ts-retry | ts | branch | `/mutation-test-review` | try-catch-swallows (static), no-retry-unverified (tool), attempt-count (tool), backoff-delays (tool) |
| ts-username-validator | ts | uncommitted | `/mutation-test-review` | length-boundaries (tool), reasons-unpinned (tool) |

## rust-acl-tests

Test-only change: six integration tests for can_read/can_write. Mutants must target src/lib.rs, which the diff does not touch.

- **no-read-denial** (tool): No test ever expects can_read to return false (e.g. a member outside the owner and group on a private document), so replacing can_read with `true` survives. This is a permission check, so the gap is high risk.
- **fixture-ids-collide** (static): The fixtures give the user id 1, group 1, and the document owner 1, group 1, so the owner and group-member tests cannot tell which rule granted access; `group_member_can_read` is identical to `owner_can_read`. Mutating `||` to `&&` between the owner and group checks, or `user.group_id == doc.group_id` to compare the wrong field, survives. Fixtures need distinct ids (owner-only user, group-only user).
- **no-write-denial-for-member** (tool): No test checks that a non-owner Member is denied write; mutating `user.role == Role::Admin` to `!=` in can_write survives because the only Member fixture is also the owner.

<details><summary>Diff under review</summary>

````diff
diff --git a/tests/acl.rs b/tests/acl.rs
new file mode 100644
index 0000000..da4379e
--- /dev/null
+++ b/tests/acl.rs
@@ -0,0 +1,39 @@
+use acl::{can_read, can_write, Document, Role, User};
+
+fn user(role: Role) -> User {
+    User { id: 1, group_id: 1, role }
+}
+
+fn doc() -> Document {
+    Document { owner_id: 1, group_id: 1, public: false }
+}
+
+#[test]
+fn admin_can_read() {
+    assert!(can_read(&user(Role::Admin), &doc()));
+}
+
+#[test]
+fn owner_can_read() {
+    assert!(can_read(&user(Role::Member), &doc()));
+}
+
+#[test]
+fn group_member_can_read() {
+    assert!(can_read(&user(Role::Member), &doc()));
+}
+
+#[test]
+fn admin_can_write() {
+    assert!(can_write(&user(Role::Admin), &doc()));
+}
+
+#[test]
+fn owner_can_write() {
+    assert!(can_write(&user(Role::Member), &doc()));
+}
+
+#[test]
+fn guest_cannot_write() {
+    assert!(!can_write(&user(Role::Guest), &doc()));
+}
````

</details>

## rust-adler-deleted-tests

Commit deletes two tests as 'redundant' and adds a determinism test. The skill is invoked on the commit range.

- **deleted-test-not-redundant** (hand): The deleted `large_input_wraps_modulus` was the only test whose sums exceed 65521, so it was the only one pinning the modular reduction. With it gone, a wrong modulus (e.g. 65536 or 65520) or a missing reduction on `a` survives; the remaining short inputs never wrap. The deletion should be reverted (or replaced with an input that wraps). (Deleting `empty_input_is_one` is defensible: `wikipedia_example` already pins the initial a = 1. A report may say so.)
- **self-comparison** (static): `checksum_is_deterministic` compares a value with itself (`assert_eq!(first, first)`), so it cannot fail; it adds no coverage of correctness. It should compare against a known vector (e.g. 0x5BDC0FDA for the quick brown fox).

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index 7e49161..38693a2 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -16,24 +16,20 @@ pub fn adler32(data: &[u8]) -> u32 {
 mod tests {
     use super::*;
 
-    #[test]
-    fn empty_input_is_one() {
-        assert_eq!(adler32(b""), 1);
-    }
-
     #[test]
     fn wikipedia_example() {
         assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
     }
 
     #[test]
-    fn large_input_wraps_modulus() {
-        let data = vec![0xFFu8; 6000];
-        assert_eq!(adler32(&data), 0xA497_59EA);
+    fn single_byte() {
+        assert_eq!(adler32(b"a"), 0x0062_0062);
     }
 
     #[test]
-    fn single_byte() {
-        assert_eq!(adler32(b"a"), 0x0062_0062);
+    fn checksum_is_deterministic() {
+        let data = b"The quick brown fox jumps over the lazy dog";
+        let first = adler32(data);
+        assert_eq!(first, first);
     }
 }
````

</details>

## rust-backoff-cap

One-line production fix (clamp delay to max_ms) plus two new tests. cargo-mutants has nothing useful to mutate on the fixed line.

- **cap-never-reached** (revert): `respects_max_delay` only checks attempts 0..4 (max 800 ms against a 10 s cap), so it never reaches the cap and passes on the pre-fix code; removing `.min(self.max_ms)` survives. The regression test must use an attempt whose uncapped delay exceeds max_ms (e.g. attempt 10 -> 102.4 s) and assert_eq! the delay equals max().
- **relational-growth** (hand): `delay_grows_with_attempts` only asserts delay(3) > delay(2), so a wrong factor or exponent (e.g. factor+1, attempt+1) passes. It should pin exact values such as 100, 200, 400, 800 ms.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index 802dfae..9bf705d 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -14,10 +14,10 @@ impl Backoff {
         Backoff { base_ms, factor, max_ms }
     }
 
-    /// Delay before retry number `attempt` (0-based).
+    /// Delay before retry number `attempt` (0-based), capped at `max_ms`.
     pub fn delay(&self, attempt: u32) -> Duration {
         let ms = self.base_ms.saturating_mul(self.factor.saturating_pow(attempt));
-        Duration::from_millis(ms)
+        Duration::from_millis(ms.min(self.max_ms))
     }
 
     pub fn max(&self) -> Duration {
@@ -34,4 +34,18 @@ mod tests {
         let b = Backoff::new(100, 2, 10_000);
         assert_eq!(b.delay(0), Duration::from_millis(100));
     }
+
+    #[test]
+    fn delay_grows_with_attempts() {
+        let b = Backoff::new(100, 2, 10_000);
+        assert!(b.delay(3) > b.delay(2));
+    }
+
+    #[test]
+    fn respects_max_delay() {
+        let b = Backoff::new(100, 2, 10_000);
+        for attempt in 0..4 {
+            assert!(b.delay(attempt) <= b.max());
+        }
+    }
 }
````

</details>

## rust-config-parser

Uncommitted change turns parse() from Option into Result with typed, line-numbered errors, plus five tests.

- **error-variant-and-line** (tool): All three error tests assert only `is_err()`, so neither the error variant nor the line number is checked. Swapping variants or breaking `line_no` (e.g. `i + 1` -> `i * 1`, visible on the duplicate key at line 2) passes. Tests should assert_eq! the exact ParseError, including a line number > 1 and the duplicate key name.
- **values-never-checked** (hand): The success tests assert only `is_ok()` / `len() == 1`; no parsed key or value is ever compared. Dropping the `.trim()` on keys or values, or swapping key and value on insert, passes. A test should compare the whole map (e.g. assert_eq! against a BTreeMap with host=example.com, port=8080).

<details><summary>Diff under review</summary>

````diff
diff --git a/src/config.rs b/src/config.rs
index a3f3c80..28b1fb4 100644
--- a/src/config.rs
+++ b/src/config.rs
@@ -1,15 +1,66 @@
 use std::collections::BTreeMap;
 
-/// Parses `key = value` lines into a map.
-pub fn parse(input: &str) -> Option<BTreeMap<String, String>> {
+/// Why a configuration file was rejected. Line numbers are 1-based.
+#[derive(Debug, PartialEq, Eq)]
+pub enum ParseError {
+    MissingEquals { line: usize },
+    EmptyKey { line: usize },
+    DuplicateKey { key: String, line: usize },
+}
+
+/// Parses `key = value` lines into a map. Blank lines and lines starting
+/// with `#` are ignored. Keys and values are trimmed.
+pub fn parse(input: &str) -> Result<BTreeMap<String, String>, ParseError> {
     let mut out = BTreeMap::new();
-    for raw in input.lines() {
+    for (i, raw) in input.lines().enumerate() {
+        let line_no = i + 1;
         let line = raw.trim();
-        if line.is_empty() {
+        if line.is_empty() || line.starts_with('#') {
             continue;
         }
-        let (k, v) = line.split_once('=')?;
-        out.insert(k.trim().to_string(), v.trim().to_string());
+        let Some((k, v)) = line.split_once('=') else {
+            return Err(ParseError::MissingEquals { line: line_no });
+        };
+        let key = k.trim();
+        if key.is_empty() {
+            return Err(ParseError::EmptyKey { line: line_no });
+        }
+        if out.contains_key(key) {
+            return Err(ParseError::DuplicateKey { key: key.to_string(), line: line_no });
+        }
+        out.insert(key.to_string(), v.trim().to_string());
+    }
+    Ok(out)
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn parses_basic_file() {
+        let cfg = parse("host = example.com\nport=8080\n");
+        assert!(cfg.is_ok());
+    }
+
+    #[test]
+    fn skips_comments_and_blank_lines() {
+        let cfg = parse("# comment\n\nname=demo\n").unwrap();
+        assert_eq!(cfg.len(), 1);
+    }
+
+    #[test]
+    fn rejects_line_without_equals() {
+        assert!(parse("host example.com").is_err());
+    }
+
+    #[test]
+    fn rejects_empty_key() {
+        assert!(parse("=value").is_err());
+    }
+
+    #[test]
+    fn rejects_duplicate_keys() {
+        assert!(parse("a=1\na=2").is_err());
     }
-    Some(out)
 }
````

</details>

## rust-control-semver

Control case: new semver module whose tests pin exact values, every error variant, and every caret boundary.

- Control: the report should say the tests are strong and must not claim a real gap.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index 38821bd..c585f0f 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1,105 @@
 //! A tiny subset of semantic versioning.
+
+#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
+pub struct Version {
+    pub major: u64,
+    pub minor: u64,
+    pub patch: u64,
+}
+
+#[derive(Debug, PartialEq, Eq)]
+pub enum ParseError {
+    WrongPartCount(usize),
+    InvalidNumber(String),
+}
+
+/// Parses `MAJOR.MINOR.PATCH`, ignoring surrounding whitespace.
+pub fn parse(s: &str) -> Result<Version, ParseError> {
+    let parts: Vec<&str> = s.trim().split('.').collect();
+    if parts.len() != 3 {
+        return Err(ParseError::WrongPartCount(parts.len()));
+    }
+    let num = |p: &str| p.parse::<u64>().map_err(|_| ParseError::InvalidNumber(p.to_string()));
+    Ok(Version { major: num(parts[0])?, minor: num(parts[1])?, patch: num(parts[2])? })
+}
+
+/// Cargo-style caret requirement: `^req` allows changes that do not modify
+/// the left-most non-zero component.
+pub fn satisfies_caret(v: Version, req: Version) -> bool {
+    if v < req {
+        return false;
+    }
+    if req.major > 0 {
+        return v.major == req.major;
+    }
+    if req.minor > 0 {
+        return v.major == 0 && v.minor == req.minor;
+    }
+    v.major == 0 && v.minor == 0 && v.patch == req.patch
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    fn v(s: &str) -> Version {
+        parse(s).unwrap()
+    }
+
+    #[test]
+    fn parses_each_component() {
+        assert_eq!(parse("1.2.3"), Ok(Version { major: 1, minor: 2, patch: 3 }));
+    }
+
+    #[test]
+    fn parse_trims_whitespace() {
+        assert_eq!(parse("  4.5.6\n"), Ok(Version { major: 4, minor: 5, patch: 6 }));
+    }
+
+    #[test]
+    fn parse_rejects_wrong_part_count() {
+        assert_eq!(parse("1.2"), Err(ParseError::WrongPartCount(2)));
+        assert_eq!(parse("1.2.3.4"), Err(ParseError::WrongPartCount(4)));
+    }
+
+    #[test]
+    fn parse_reports_the_invalid_component() {
+        assert_eq!(parse("1.x.3"), Err(ParseError::InvalidNumber("x".to_string())));
+        assert_eq!(parse("1.2.-3"), Err(ParseError::InvalidNumber("-3".to_string())));
+    }
+
+    #[test]
+    fn versions_order_by_major_then_minor_then_patch() {
+        assert!(v("1.0.0") > v("0.9.9"));
+        assert!(v("1.2.0") > v("1.1.9"));
+        assert!(v("1.1.2") > v("1.1.1"));
+    }
+
+    #[test]
+    fn caret_with_nonzero_major() {
+        let req = v("1.2.3");
+        assert!(satisfies_caret(v("1.2.3"), req));
+        assert!(satisfies_caret(v("1.9.0"), req));
+        assert!(!satisfies_caret(v("1.2.2"), req));
+        assert!(!satisfies_caret(v("2.0.0"), req));
+    }
+
+    #[test]
+    fn caret_with_zero_major() {
+        let req = v("0.2.3");
+        assert!(satisfies_caret(v("0.2.3"), req));
+        assert!(satisfies_caret(v("0.2.9"), req));
+        assert!(!satisfies_caret(v("0.2.2"), req));
+        assert!(!satisfies_caret(v("0.3.0"), req));
+        assert!(!satisfies_caret(v("1.2.3"), req));
+    }
+
+    #[test]
+    fn caret_with_zero_major_and_minor() {
+        let req = v("0.0.3");
+        assert!(satisfies_caret(v("0.0.3"), req));
+        assert!(!satisfies_caret(v("0.0.4"), req));
+        assert!(!satisfies_caret(v("0.1.3"), req));
+        assert!(!satisfies_caret(v("1.0.3"), req));
+    }
+}
````

</details>

## rust-hard-e2e-suite

Production change to slugify (accent folding, word-boundary truncation). The truncation behaviour is tested only by scripts/e2e.sh, which CI runs via `make test` but cargo-mutants never runs; accent folding is barely tested anywhere.

- **e2e-suite-caught-elsewhere** (static): The word-boundary truncation (`out.len() + extra > max_len`, the `extra` computation, `break`) is covered only by scripts/e2e.sh (run by `make test` in CI), which cargo-mutants does not run, so its survivors there are not proven gaps. The report must notice the e2e suite and classify those survivors as caught elsewhere (or spot-check them by running e2e.sh with the mutant applied, which kills them) instead of reporting them as untested. Reporting the truncation logic as an untested gap without mentioning e2e.sh counts as missing this.
- **fold-weakly-tested** (tool): Accent folding is a real gap in both suites: `folds_accents` asserts only `starts_with("creme")`, e2e.sh has no accented input, and most fold arms (e.g. 'ü' -> 'u', 'ñ' -> 'n', uppercase accented letters) are never exercised, so deleting or changing match arms survives. A table-driven assert_eq! over each arm (including uppercase) is needed.

<details><summary>Diff under review</summary>

````diff
diff --git a/scripts/e2e.sh b/scripts/e2e.sh
index 31dddd7..4465daf 100644
--- a/scripts/e2e.sh
+++ b/scripts/e2e.sh
@@ -17,4 +17,8 @@ check() {
 check 64 "Hello World" "hello-world"
 check 64 "  Rust's   2024 Edition!  " "rusts-2024-edition"
 check 64 "--- ???" ""
+# word-boundary truncation
+check 11 "hello world again" "hello-world"
+check 10 "hello world again" "hello"
+check 3 "hello" ""
 echo "e2e ok"
diff --git a/src/lib.rs b/src/lib.rs
index b894a30..c746a36 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,22 +1,43 @@
 //! Turns titles into URL slugs.
 
-/// Lowercases ASCII letters and digits, joins words with `-`.
+/// Lowercases ASCII letters and digits and joins words with `-`.
+///
+/// Accented Latin letters are folded to ASCII (`é` -> `e`) instead of being
+/// dropped. When the slug is longer than `max_len` it is cut at the last word
+/// boundary that fits, so slugs never end in a partial word or a `-`.
 pub fn slugify(title: &str, max_len: usize) -> String {
     let mut out = String::new();
     for word in title.split_whitespace() {
-        let word: String = word.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
+        let word: String = word.chars().filter_map(fold).collect();
         if word.is_empty() {
             continue;
         }
+        let extra = if out.is_empty() { word.len() } else { word.len() + 1 };
+        if out.len() + extra > max_len {
+            break;
+        }
         if !out.is_empty() {
             out.push('-');
         }
-        out.push_str(&word.to_ascii_lowercase());
+        out.push_str(&word);
     }
-    out.truncate(max_len);
     out
 }
 
+fn fold(c: char) -> Option<char> {
+    let c = match c {
+        'à' | 'á' | 'â' | 'ä' | 'À' | 'Á' | 'Â' | 'Ä' => 'a',
+        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
+        'ì' | 'í' | 'î' | 'ï' => 'i',
+        'ò' | 'ó' | 'ô' | 'ö' | 'Ö' => 'o',
+        'ù' | 'ú' | 'û' | 'ü' | 'Ü' => 'u',
+        'ç' => 'c',
+        'ñ' => 'n',
+        c => c,
+    };
+    c.is_ascii_alphanumeric().then(|| c.to_ascii_lowercase())
+}
+
 #[cfg(test)]
 mod tests {
     use super::*;
@@ -25,4 +46,9 @@ mod tests {
     fn joins_words() {
         assert_eq!(slugify("Hello World", 64), "hello-world");
     }
+
+    #[test]
+    fn folds_accents() {
+        assert!(slugify("Crème Brûlée", 64).starts_with("creme"));
+    }
 }
````

</details>

## rust-hard-frame-codec

Protocol frame codec (RFC 6455 header) across several files, with doc-only distractor edits in error.rs and mask.rs. Tests cover the 7-bit and 16-bit length forms but never the boundaries, the 64-bit form, masked decoding, or the size limit.

- **length-form-boundaries** (hand): No test sits on a length-form boundary (125/126, 65535/65536), and nothing exercises the 64-bit form (> 65535 bytes), so `len < 126` -> `<= 126`, `len <= 0xffff` -> `<`, and errors in the 127 branch survive. This is wire encoding, so it is high risk; golden header bytes at 125, 126, 65535 and 65536 are needed.
- **mask-roundtrip-untested** (tool): `masked_payload_differs_on_the_wire` only asserts the masked bytes differ from the payload; no test decodes a masked frame or pins the masked bytes. Wrong key indexing (`i % 4` -> `i % 3`), skipping the unmask in decode, or the mask bit being dropped all survive. A roundtrip of a masked frame plus golden masked bytes are needed.
- **size-limit-and-truncation-detail** (tool): The MAX_PAYLOAD check (`len > MAX_PAYLOAD` / FrameError::TooLarge) is never tested, and `rejects_truncated_input` uses only is_err(), so the `needed` counts in every Truncated error (and truncation inside the extended-length or mask-key fields) are unpinned. Tests should assert_eq! exact errors, including TooLarge for a 127-form header declaring MAX_PAYLOAD + 1.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/error.rs b/src/error.rs
index f7b081b..926d2cc 100644
--- a/src/error.rs
+++ b/src/error.rs
@@ -1,9 +1,13 @@
 use std::fmt;
 
+/// Errors produced while decoding a frame.
 #[derive(Debug, PartialEq, Eq)]
 pub enum FrameError {
+    /// The buffer ended early; `needed` more bytes are required.
     Truncated { needed: usize },
+    /// RSV1-3 were set, which this protocol never does.
     ReservedBits,
+    /// The declared payload length exceeds [`crate::MAX_PAYLOAD`].
     TooLarge(u64),
 }
 
diff --git a/src/frame.rs b/src/frame.rs
new file mode 100644
index 0000000..5e0e19e
--- /dev/null
+++ b/src/frame.rs
@@ -0,0 +1,134 @@
+use crate::error::FrameError;
+use crate::mask::apply_mask;
+
+/// Largest payload accepted by [`decode`] (16 MiB).
+pub const MAX_PAYLOAD: u64 = 16 * 1024 * 1024;
+
+#[derive(Debug, Clone, PartialEq, Eq)]
+pub struct Frame {
+    pub fin: bool,
+    pub opcode: u8,
+    pub mask: Option<[u8; 4]>,
+    pub payload: Vec<u8>,
+}
+
+/// Serialises a frame. Payload lengths up to 125 use the 7-bit form, up to
+/// 65535 the 16-bit form, and anything larger the 64-bit form.
+pub fn encode(frame: &Frame) -> Vec<u8> {
+    let mut out = Vec::with_capacity(frame.payload.len() + 14);
+    out.push(((frame.fin as u8) << 7) | (frame.opcode & 0x0f));
+    let mask_bit = if frame.mask.is_some() { 0x80 } else { 0 };
+    let len = frame.payload.len();
+    if len < 126 {
+        out.push(mask_bit | len as u8);
+    } else if len <= 0xffff {
+        out.push(mask_bit | 126);
+        out.extend_from_slice(&(len as u16).to_be_bytes());
+    } else {
+        out.push(mask_bit | 127);
+        out.extend_from_slice(&(len as u64).to_be_bytes());
+    }
+    if let Some(key) = frame.mask {
+        out.extend_from_slice(&key);
+    }
+    let body = out.len();
+    out.extend_from_slice(&frame.payload);
+    if let Some(key) = frame.mask {
+        apply_mask(&mut out[body..], key);
+    }
+    out
+}
+
+/// Parses one frame from the start of `buf`, returning it and the number of
+/// bytes consumed.
+pub fn decode(buf: &[u8]) -> Result<(Frame, usize), FrameError> {
+    if buf.len() < 2 {
+        return Err(FrameError::Truncated { needed: 2 - buf.len() });
+    }
+    if buf[0] & 0x70 != 0 {
+        return Err(FrameError::ReservedBits);
+    }
+    let fin = buf[0] & 0x80 != 0;
+    let opcode = buf[0] & 0x0f;
+    let masked = buf[1] & 0x80 != 0;
+    let (len, mut pos) = match buf[1] & 0x7f {
+        126 => {
+            if buf.len() < 4 {
+                return Err(FrameError::Truncated { needed: 4 - buf.len() });
+            }
+            (u16::from_be_bytes([buf[2], buf[3]]) as u64, 4)
+        }
+        127 => {
+            if buf.len() < 10 {
+                return Err(FrameError::Truncated { needed: 10 - buf.len() });
+            }
+            (u64::from_be_bytes(buf[2..10].try_into().unwrap()), 10)
+        }
+        n => (n as u64, 2),
+    };
+    if len > MAX_PAYLOAD {
+        return Err(FrameError::TooLarge(len));
+    }
+    let mask = if masked {
+        if buf.len() < pos + 4 {
+            return Err(FrameError::Truncated { needed: pos + 4 - buf.len() });
+        }
+        let key = [buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]];
+        pos += 4;
+        Some(key)
+    } else {
+        None
+    };
+    let end = pos + len as usize;
+    if buf.len() < end {
+        return Err(FrameError::Truncated { needed: end - buf.len() });
+    }
+    let mut payload = buf[pos..end].to_vec();
+    if let Some(key) = mask {
+        apply_mask(&mut payload, key);
+    }
+    Ok((Frame { fin, opcode, mask, payload }, end))
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    fn frame(len: usize, mask: Option<[u8; 4]>) -> Frame {
+        Frame { fin: true, opcode: 2, mask, payload: (0..len).map(|i| i as u8).collect() }
+    }
+
+    #[test]
+    fn small_frame_header_bytes() {
+        let bytes = encode(&frame(5, None));
+        assert_eq!(&bytes[..2], &[0x82, 0x05]);
+    }
+
+    #[test]
+    fn roundtrips_small_and_medium_frames() {
+        for len in [0, 5, 200, 1000] {
+            let f = frame(len, None);
+            let (decoded, used) = decode(&encode(&f)).unwrap();
+            assert_eq!(decoded, f);
+            assert_eq!(used, encode(&f).len());
+        }
+    }
+
+    #[test]
+    fn masked_payload_differs_on_the_wire() {
+        let f = frame(8, Some([1, 2, 3, 4]));
+        let bytes = encode(&f);
+        assert_ne!(&bytes[bytes.len() - 8..], &f.payload[..]);
+    }
+
+    #[test]
+    fn rejects_truncated_input() {
+        assert!(decode(&[0x82]).is_err());
+        assert!(decode(&[0x82, 0x05, 1, 2]).is_err());
+    }
+
+    #[test]
+    fn rejects_reserved_bits() {
+        assert_eq!(decode(&[0xc2, 0x00]), Err(FrameError::ReservedBits));
+    }
+}
diff --git a/src/lib.rs b/src/lib.rs
index f66e020..0a4feb4 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,4 +1,11 @@
 //! Framing for the relay protocol.
+//!
+//! A frame is a header followed by the (optionally masked) payload. The
+//! header layout follows RFC 6455 section 5.2.
 
 pub mod error;
+pub mod frame;
 pub mod mask;
+
+pub use error::FrameError;
+pub use frame::{decode, encode, Frame, MAX_PAYLOAD};
diff --git a/src/mask.rs b/src/mask.rs
index 6a4cc70..5db9ca0 100644
--- a/src/mask.rs
+++ b/src/mask.rs
@@ -1,4 +1,4 @@
-/// Applies the 4-byte XOR mask in place.
+/// Applies the 4-byte XOR mask in place. Applying it twice restores the data.
 pub fn apply_mask(data: &mut [u8], key: [u8; 4]) {
     for (i, b) in data.iter_mut().enumerate() {
         *b ^= key[i % 4];
````

</details>

## rust-hard-golden-whitespace

Table renderer whose whole job is padding and alignment, tested by a golden file that is compared after splitting on whitespace, so padding and alignment are invisible to the test; the golden helper also passes trivially in update mode.

- **golden-ignores-padding** (tool): `check_golden` compares `split_whitespace()` tokens, so all padding and alignment is discarded before comparison: swapping Left/Right alignment, dropping the pad, or changing the column separator survive (pad/repeat mutants, `widths[i] - count` -> `+`). For a renderer whose purpose is layout, the golden must be compared byte-for-byte (assert_eq! on the strings).
- **update-golden-self-pass** (static): With UPDATE_GOLDEN set, check_golden writes the actual output and then compares it with itself, so the test cannot fail in that mode (a regenerated golden enshrines whatever the code does). It should write and return, or fail loudly, rather than pass silently.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index df6927c..9c81370 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1,3 @@
 //! Plain-text table rendering for CLI output.
+
+pub mod table;
diff --git a/src/table.rs b/src/table.rs
new file mode 100644
index 0000000..befeeeb
--- /dev/null
+++ b/src/table.rs
@@ -0,0 +1,55 @@
+#[derive(Clone, Copy, Debug, PartialEq, Eq)]
+pub enum Align {
+    Left,
+    Right,
+}
+
+/// Renders rows as a padded table. Each column is as wide as its widest cell
+/// (capped at `max_width`; longer cells are cut and end in `…`). Columns are
+/// separated by two spaces and trailing spaces are trimmed from every line.
+pub fn render(header: &[&str], rows: &[Vec<String>], align: &[Align], max_width: usize) -> String {
+    let cols = header.len();
+    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
+    for row in rows {
+        for (i, cell) in row.iter().enumerate().take(cols) {
+            widths[i] = widths[i].max(cell.chars().count());
+        }
+    }
+    for w in &mut widths {
+        *w = (*w).min(max_width);
+    }
+    let mut out = String::new();
+    let header_row: Vec<String> = header.iter().map(|h| h.to_string()).collect();
+    for row in std::iter::once(&header_row).chain(rows) {
+        let mut line = String::new();
+        for i in 0..cols {
+            let cell = truncate(row.get(i).map(String::as_str).unwrap_or(""), widths[i]);
+            let pad = widths[i] - cell.chars().count();
+            if i > 0 {
+                line.push_str("  ");
+            }
+            match align.get(i).copied().unwrap_or(Align::Left) {
+                Align::Left => {
+                    line.push_str(&cell);
+                    line.push_str(&" ".repeat(pad));
+                }
+                Align::Right => {
+                    line.push_str(&" ".repeat(pad));
+                    line.push_str(&cell);
+                }
+            }
+        }
+        out.push_str(line.trim_end());
+        out.push('\n');
+    }
+    out
+}
+
+fn truncate(cell: &str, width: usize) -> String {
+    if cell.chars().count() <= width {
+        return cell.to_string();
+    }
+    let mut s: String = cell.chars().take(width.saturating_sub(1)).collect();
+    s.push('…');
+    s
+}
diff --git a/tests/golden.rs b/tests/golden.rs
new file mode 100644
index 0000000..065aa69
--- /dev/null
+++ b/tests/golden.rs
@@ -0,0 +1,36 @@
+//! Golden-file tests. Regenerate with `UPDATE_GOLDEN=1 cargo test`.
+
+use tablefmt::table::{render, Align};
+
+fn normalise(s: &str) -> Vec<Vec<&str>> {
+    s.lines().map(|l| l.split_whitespace().collect()).collect()
+}
+
+fn check_golden(name: &str, actual: &str) {
+    let path = format!("{}/tests/golden/{name}.txt", env!("CARGO_MANIFEST_DIR"));
+    if std::env::var_os("UPDATE_GOLDEN").is_some() {
+        std::fs::write(&path, actual).unwrap();
+    }
+    let expected = std::fs::read_to_string(&path).unwrap();
+    // Compare cell by cell so the test doesn't break on cosmetic spacing changes.
+    assert_eq!(normalise(actual), normalise(&expected));
+}
+
+fn rows() -> Vec<Vec<String>> {
+    [["cargo", "12345", "root"], ["rustc", "987", "alice"], ["README.md", "1", "bob"]]
+        .iter()
+        .map(|r| r.iter().map(|c| c.to_string()).collect())
+        .collect()
+}
+
+#[test]
+fn basic_table() {
+    let out = render(&["name", "size", "owner"], &rows(), &[Align::Left, Align::Right, Align::Left], 7);
+    check_golden("basic", &out);
+}
+
+#[test]
+fn every_line_is_trimmed() {
+    let out = render(&["name", "size", "owner"], &rows(), &[Align::Left, Align::Right, Align::Left], 7);
+    assert!(out.lines().all(|l| !l.ends_with(' ')));
+}
diff --git a/tests/golden/basic.txt b/tests/golden/basic.txt
new file mode 100644
index 0000000..d3c6967
--- /dev/null
+++ b/tests/golden/basic.txt
@@ -0,0 +1,4 @@
+name      size  owner
+cargo    12345  root
+rustc      987  alice
+README…      1  bob
````

</details>

## rust-hard-refactor-move

Large move-only refactor (parse.rs -> parse/{mod,mantissa,exponent,sign}.rs). Hidden in the move: the negative-exponent test was dropped, and the overflow test gained #[ignore], so neither runs.

- **negative-exponent-test-dropped** (hand): The move dropped `negative_exponent` (25e-2 -> 0.25), and the moved `positive_exponent` now only calls exponent::parse with unsigned/`+` input, so nothing covers a negative exponent any more; `if negative { -exp } else { exp }` -> always `exp` (and `(true, rest)` -> `(false, rest)` in split_sign for exponents) now survives. The commit claims no behaviour change, so the report should say coverage was lost in the move and restore the test.
- **overflow-test-ignored** (hand): `exponent_overflow` gained `#[ignore = "slow on CI"]`, so `cargo test` (and cargo-mutants) no longer runs it, and the checked_mul/checked_add overflow path is unpinned (replacing the checked arithmetic with wrapping, or `ExponentOverflow` with another variant, survives). The test is not slow (one parse of 11 digits); the ignore should be removed.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/parse.rs b/src/parse.rs
deleted file mode 100644
index ab6c463..0000000
--- a/src/parse.rs
+++ /dev/null
@@ -1,114 +0,0 @@
-#[derive(Debug, PartialEq)]
-pub enum ParseNumberError {
-    Empty,
-    InvalidDigit(char),
-    ExponentOverflow,
-}
-
-/// Parses decimal numbers with an optional sign, fraction, and exponent,
-/// plus `_` digit separators: `-1_000.5e-3`.
-pub fn parse_number(s: &str) -> Result<f64, ParseNumberError> {
-    let s = s.trim();
-    if s.is_empty() {
-        return Err(ParseNumberError::Empty);
-    }
-    let (mantissa, exponent) = match s.find(['e', 'E']) {
-        Some(i) => (&s[..i], Some(&s[i + 1..])),
-        None => (s, None),
-    };
-    let value = parse_mantissa(mantissa)?;
-    let exp = match exponent {
-        Some(e) => parse_exponent(e)?,
-        None => 0,
-    };
-    Ok(value * 10f64.powi(exp))
-}
-
-fn parse_mantissa(s: &str) -> Result<f64, ParseNumberError> {
-    let (negative, digits) = match s.strip_prefix('-') {
-        Some(rest) => (true, rest),
-        None => (false, s.strip_prefix('+').unwrap_or(s)),
-    };
-    let mut value = 0f64;
-    let mut scale = None::<f64>;
-    for c in digits.chars() {
-        match c {
-            '_' => continue,
-            '.' if scale.is_none() => scale = Some(1.0),
-            '0'..='9' => {
-                let d = c.to_digit(10).unwrap() as f64;
-                match scale.as_mut() {
-                    Some(sc) => {
-                        *sc /= 10.0;
-                        value += d * *sc;
-                    }
-                    None => value = value * 10.0 + d,
-                }
-            }
-            other => return Err(ParseNumberError::InvalidDigit(other)),
-        }
-    }
-    Ok(if negative { -value } else { value })
-}
-
-fn parse_exponent(s: &str) -> Result<i32, ParseNumberError> {
-    let (negative, digits) = match s.strip_prefix('-') {
-        Some(rest) => (true, rest),
-        None => (false, s.strip_prefix('+').unwrap_or(s)),
-    };
-    if digits.is_empty() {
-        return Err(ParseNumberError::Empty);
-    }
-    let mut exp: i32 = 0;
-    for c in digits.chars() {
-        let d = c.to_digit(10).ok_or(ParseNumberError::InvalidDigit(c))? as i32;
-        exp = exp.checked_mul(10).and_then(|e| e.checked_add(d)).ok_or(ParseNumberError::ExponentOverflow)?;
-    }
-    Ok(if negative { -exp } else { exp })
-}
-
-#[cfg(test)]
-mod tests {
-    use super::*;
-
-    #[test]
-    fn integers_and_signs() {
-        assert_eq!(parse_number("42"), Ok(42.0));
-        assert_eq!(parse_number("-42"), Ok(-42.0));
-        assert_eq!(parse_number("+7"), Ok(7.0));
-    }
-
-    #[test]
-    fn fractions() {
-        assert_eq!(parse_number("2.5"), Ok(2.5));
-        assert_eq!(parse_number("-0.25"), Ok(-0.25));
-    }
-
-    #[test]
-    fn separators() {
-        assert_eq!(parse_number("1_000_000"), Ok(1_000_000.0));
-    }
-
-    #[test]
-    fn positive_exponent() {
-        assert_eq!(parse_number("1.5e3"), Ok(1500.0));
-        assert_eq!(parse_number("2E+2"), Ok(200.0));
-    }
-
-    #[test]
-    fn negative_exponent() {
-        assert_eq!(parse_number("25e-2"), Ok(0.25));
-    }
-
-    #[test]
-    fn errors() {
-        assert_eq!(parse_number(""), Err(ParseNumberError::Empty));
-        assert_eq!(parse_number("1x"), Err(ParseNumberError::InvalidDigit('x')));
-        assert_eq!(parse_number("1e"), Err(ParseNumberError::Empty));
-    }
-
-    #[test]
-    fn exponent_overflow() {
-        assert_eq!(parse_number("1e99999999999"), Err(ParseNumberError::ExponentOverflow));
-    }
-}
diff --git a/src/parse/exponent.rs b/src/parse/exponent.rs
new file mode 100644
index 0000000..9278251
--- /dev/null
+++ b/src/parse/exponent.rs
@@ -0,0 +1,32 @@
+use super::sign::split_sign;
+use super::ParseNumberError;
+
+pub(super) fn parse(s: &str) -> Result<i32, ParseNumberError> {
+    let (negative, digits) = split_sign(s);
+    if digits.is_empty() {
+        return Err(ParseNumberError::Empty);
+    }
+    let mut exp: i32 = 0;
+    for c in digits.chars() {
+        let d = c.to_digit(10).ok_or(ParseNumberError::InvalidDigit(c))? as i32;
+        exp = exp.checked_mul(10).and_then(|e| e.checked_add(d)).ok_or(ParseNumberError::ExponentOverflow)?;
+    }
+    Ok(if negative { -exp } else { exp })
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn positive_exponent() {
+        assert_eq!(parse("3"), Ok(3));
+        assert_eq!(parse("+2"), Ok(2));
+    }
+
+    #[test]
+    #[ignore = "slow on CI"]
+    fn exponent_overflow() {
+        assert_eq!(parse("99999999999"), Err(ParseNumberError::ExponentOverflow));
+    }
+}
diff --git a/src/parse/mantissa.rs b/src/parse/mantissa.rs
new file mode 100644
index 0000000..aa68713
--- /dev/null
+++ b/src/parse/mantissa.rs
@@ -0,0 +1,42 @@
+use super::sign::split_sign;
+use super::ParseNumberError;
+
+pub(super) fn parse(s: &str) -> Result<f64, ParseNumberError> {
+    let (negative, digits) = split_sign(s);
+    let mut value = 0f64;
+    let mut scale = None::<f64>;
+    for c in digits.chars() {
+        match c {
+            '_' => continue,
+            '.' if scale.is_none() => scale = Some(1.0),
+            '0'..='9' => {
+                let d = c.to_digit(10).unwrap() as f64;
+                match scale.as_mut() {
+                    Some(sc) => {
+                        *sc /= 10.0;
+                        value += d * *sc;
+                    }
+                    None => value = value * 10.0 + d,
+                }
+            }
+            other => return Err(ParseNumberError::InvalidDigit(other)),
+        }
+    }
+    Ok(if negative { -value } else { value })
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn fractions() {
+        assert_eq!(parse("2.5"), Ok(2.5));
+        assert_eq!(parse("-0.25"), Ok(-0.25));
+    }
+
+    #[test]
+    fn separators() {
+        assert_eq!(parse("1_000_000"), Ok(1_000_000.0));
+    }
+}
diff --git a/src/parse/mod.rs b/src/parse/mod.rs
new file mode 100644
index 0000000..a15bf68
--- /dev/null
+++ b/src/parse/mod.rs
@@ -0,0 +1,50 @@
+//! Decimal number parsing, split by component.
+
+mod exponent;
+mod mantissa;
+mod sign;
+
+#[derive(Debug, PartialEq)]
+pub enum ParseNumberError {
+    Empty,
+    InvalidDigit(char),
+    ExponentOverflow,
+}
+
+/// Parses decimal numbers with an optional sign, fraction, and exponent,
+/// plus `_` digit separators: `-1_000.5e-3`.
+pub fn parse_number(s: &str) -> Result<f64, ParseNumberError> {
+    let s = s.trim();
+    if s.is_empty() {
+        return Err(ParseNumberError::Empty);
+    }
+    let (mantissa, exponent) = match s.find(['e', 'E']) {
+        Some(i) => (&s[..i], Some(&s[i + 1..])),
+        None => (s, None),
+    };
+    let value = mantissa::parse(mantissa)?;
+    let exp = match exponent {
+        Some(e) => exponent::parse(e)?,
+        None => 0,
+    };
+    Ok(value * 10f64.powi(exp))
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn integers_and_signs() {
+        assert_eq!(parse_number("42"), Ok(42.0));
+        assert_eq!(parse_number("-42"), Ok(-42.0));
+        assert_eq!(parse_number("+7"), Ok(7.0));
+    }
+
+    #[test]
+    fn errors() {
+        assert_eq!(parse_number(""), Err(ParseNumberError::Empty));
+        assert_eq!(parse_number("1x"), Err(ParseNumberError::InvalidDigit('x')));
+        assert_eq!(parse_number("1e"), Err(ParseNumberError::Empty));
+    }
+}
diff --git a/src/parse/sign.rs b/src/parse/sign.rs
new file mode 100644
index 0000000..fffb36b
--- /dev/null
+++ b/src/parse/sign.rs
@@ -0,0 +1,7 @@
+/// Splits an optional leading `-` or `+` from `s`.
+pub(super) fn split_sign(s: &str) -> (bool, &str) {
+    match s.strip_prefix('-') {
+        Some(rest) => (true, rest),
+        None => (false, s.strip_prefix('+').unwrap_or(s)),
+    }
+}
````

</details>

## rust-hard-tested-double

New Ledger::transfer. The integration tests look thorough (exact values, boundaries, error variants) but exercise a FakeLedger that re-implements the rules; the production Ledger is never constructed in any test.

- **tests-exercise-a-copy** (tool): Every test runs against `FakeLedger`, a hand-written copy of the transfer rules, so the production `Ledger<S>::transfer` is never executed; every mutant in src/ledger.rs survives (replace transfer with Ok(()), `<=` / `>` flips, `-`/`+` swaps) even though the tests themselves look precise. The tests should construct `Ledger { store: MemStore::default(), .. }` (MemStore already exists) and drop the fake. This is money movement, so it is the highest-risk gap.
- **store-writes-unverified** (static): Even once pointed at Ledger, nothing checks the store-level effects specific to the real implementation: that both set_balance calls happen with the new balances (and that a rejected transfer writes nothing). The fake updates its own map, so the read-modify-write through `Store` is untested. Tests should assert MemStore balances after success and unchanged balances after each error.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/ledger.rs b/src/ledger.rs
new file mode 100644
index 0000000..dadcd91
--- /dev/null
+++ b/src/ledger.rs
@@ -0,0 +1,40 @@
+use crate::store::Store;
+
+#[derive(Debug, PartialEq, Eq)]
+pub enum TransferError {
+    NonPositiveAmount,
+    SameAccount,
+    /// The source would drop below its overdraft limit.
+    InsufficientFunds { available: i64 },
+}
+
+/// Moves money between accounts. Accounts may go negative down to
+/// `-overdraft_limit` cents.
+pub trait Transfers {
+    fn transfer(&mut self, from: &str, to: &str, cents: i64) -> Result<(), TransferError>;
+}
+
+pub struct Ledger<S: Store> {
+    pub store: S,
+    pub overdraft_limit: i64,
+}
+
+impl<S: Store> Transfers for Ledger<S> {
+    fn transfer(&mut self, from: &str, to: &str, cents: i64) -> Result<(), TransferError> {
+        if cents <= 0 {
+            return Err(TransferError::NonPositiveAmount);
+        }
+        if from == to {
+            return Err(TransferError::SameAccount);
+        }
+        let available = self.store.balance(from) + self.overdraft_limit;
+        if cents > available {
+            return Err(TransferError::InsufficientFunds { available });
+        }
+        let from_balance = self.store.balance(from);
+        let to_balance = self.store.balance(to);
+        self.store.set_balance(from, from_balance - cents);
+        self.store.set_balance(to, to_balance + cents);
+        Ok(())
+    }
+}
diff --git a/src/lib.rs b/src/lib.rs
index 6ca72e1..64077db 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,4 @@
 //! Customer wallets.
 
+pub mod ledger;
 pub mod store;
diff --git a/tests/ledger.rs b/tests/ledger.rs
new file mode 100644
index 0000000..9082466
--- /dev/null
+++ b/tests/ledger.rs
@@ -0,0 +1,67 @@
+//! Transfer rules. These use an in-memory ledger so they run without a database.
+
+use std::collections::HashMap;
+use wallet::ledger::{TransferError, Transfers};
+
+/// In-memory stand-in for `Ledger` so the rules can be tested without a store.
+struct FakeLedger {
+    balances: HashMap<String, i64>,
+    overdraft_limit: i64,
+}
+
+impl FakeLedger {
+    fn with(accounts: &[(&str, i64)], overdraft_limit: i64) -> Self {
+        let balances = accounts.iter().map(|(a, b)| (a.to_string(), *b)).collect();
+        FakeLedger { balances, overdraft_limit }
+    }
+
+    fn balance(&self, account: &str) -> i64 {
+        self.balances.get(account).copied().unwrap_or(0)
+    }
+}
+
+impl Transfers for FakeLedger {
+    fn transfer(&mut self, from: &str, to: &str, cents: i64) -> Result<(), TransferError> {
+        if cents <= 0 {
+            return Err(TransferError::NonPositiveAmount);
+        }
+        if from == to {
+            return Err(TransferError::SameAccount);
+        }
+        let available = self.balance(from) + self.overdraft_limit;
+        if cents > available {
+            return Err(TransferError::InsufficientFunds { available });
+        }
+        *self.balances.entry(from.to_string()).or_default() -= cents;
+        *self.balances.entry(to.to_string()).or_default() += cents;
+        Ok(())
+    }
+}
+
+#[test]
+fn moves_money_between_accounts() {
+    let mut l = FakeLedger::with(&[("alice", 1_000), ("bob", 0)], 0);
+    l.transfer("alice", "bob", 300).unwrap();
+    assert_eq!(l.balance("alice"), 700);
+    assert_eq!(l.balance("bob"), 300);
+}
+
+#[test]
+fn allows_overdraft_up_to_the_limit() {
+    let mut l = FakeLedger::with(&[("alice", 100)], 50);
+    assert_eq!(l.transfer("alice", "bob", 150), Ok(()));
+    assert_eq!(l.balance("alice"), -50);
+}
+
+#[test]
+fn rejects_transfers_beyond_the_limit() {
+    let mut l = FakeLedger::with(&[("alice", 100)], 50);
+    assert_eq!(l.transfer("alice", "bob", 151), Err(TransferError::InsufficientFunds { available: 150 }));
+}
+
+#[test]
+fn rejects_non_positive_amounts_and_self_transfers() {
+    let mut l = FakeLedger::with(&[("alice", 100)], 0);
+    assert_eq!(l.transfer("alice", "bob", 0), Err(TransferError::NonPositiveAmount));
+    assert_eq!(l.transfer("alice", "alice", 10), Err(TransferError::SameAccount));
+}
````

</details>

## rust-hard-weak-property

Interval merge with two 500-iteration property tests that look rigorous, but the generator never produces overlapping or touching spans (spans sit in separate 10-wide slots), and the properties never check that the output covers the same points as the input.

- **generator-never-overlaps** (hand): The generator places span i in [10i, 10i+8), so generated spans never overlap or touch and never arrive out of order; the merge branch is exercised only by the single `merges_overlapping_pair` example. Touching spans (`s.start <= last.end` -> `<`) and unsorted input (dropping `spans.sort()`) survive. The generator needs overlapping, touching, nested and unsorted spans.
- **property-not-coverage-preserving** (hand): Neither property checks that the merged output covers exactly the same integers as the input (only sortedness/disjointness and length), so a merge that drops spans, or `last.end.max(s.end)` -> `s.end` (shrinking a span when a nested one follows), passes. A property should compare the set of covered points (or total length) of input and output.
- **empty-spans-untested** (tool): The generator always produces end > start, so the `retain(|s| s.start < s.end)` filter for empty/inverted spans is never exercised; `<` -> `<=` or removing the retain survives.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index b39fb85..a6a295f 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1,3 @@
 //! Integer interval sets.
+
+pub mod merge;
diff --git a/src/merge.rs b/src/merge.rs
new file mode 100644
index 0000000..5ece51c
--- /dev/null
+++ b/src/merge.rs
@@ -0,0 +1,73 @@
+/// A half-open interval `[start, end)`.
+#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
+pub struct Span {
+    pub start: i64,
+    pub end: i64,
+}
+
+/// Sorts spans and merges any that overlap or touch (`[1,3)` and `[3,5)`
+/// become `[1,5)`). Empty spans (`start >= end`) are dropped.
+pub fn merge(mut spans: Vec<Span>) -> Vec<Span> {
+    spans.retain(|s| s.start < s.end);
+    spans.sort();
+    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
+    for s in spans {
+        match out.last_mut() {
+            Some(last) if s.start <= last.end => last.end = last.end.max(s.end),
+            _ => out.push(s),
+        }
+    }
+    out
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    /// Tiny deterministic generator so the property test needs no dependencies.
+    struct Lcg(u64);
+
+    impl Lcg {
+        fn next(&mut self) -> u64 {
+            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
+            self.0 >> 33
+        }
+
+        fn spans(&mut self) -> Vec<Span> {
+            let n = (self.next() % 6) as usize;
+            (0..n)
+                .map(|i| {
+                    let start = (i as i64) * 10 + (self.next() % 3) as i64;
+                    Span { start, end: start + 1 + (self.next() % 5) as i64 }
+                })
+                .collect()
+        }
+    }
+
+    #[test]
+    fn merged_spans_are_sorted_and_disjoint() {
+        let mut rng = Lcg(7);
+        for _ in 0..500 {
+            let out = merge(rng.spans());
+            for pair in out.windows(2) {
+                assert!(pair[0].end < pair[1].start, "{out:?}");
+            }
+        }
+    }
+
+    #[test]
+    fn merge_never_grows_the_list() {
+        let mut rng = Lcg(11);
+        for _ in 0..500 {
+            let input = rng.spans();
+            let n = input.len();
+            assert!(merge(input).len() <= n);
+        }
+    }
+
+    #[test]
+    fn merges_overlapping_pair() {
+        let out = merge(vec![Span { start: 1, end: 4 }, Span { start: 2, end: 6 }]);
+        assert_eq!(out, vec![Span { start: 1, end: 6 }]);
+    }
+}
````

</details>

## rust-lru-cache

New generic LRU cache with four tests; the LRU ordering itself is effectively untested.

- **guarded-assertion** (static): `get_returns_inserted_value` puts its only assertion inside `if let Some(v) = c.get(..)`, so the test passes when get returns None; it cannot fail on its own. It should assert_eq!(c.get(&"a"), Some(&1)).
- **lru-order-untested** (tool): `recently_used_survives_eviction` checks the newly inserted key `c`, not that `a` survived and `b` was evicted, so replacing `touch` with `()` (plain FIFO eviction) survives. The LRU ordering, which is the whole point of the type, is unpinned. The test should assert get(&"a") == Some(&1) and get(&"b") == None.
- **update-value-unchecked** (hand): `updating_existing_key_keeps_size` checks only len(), not that the value changed to 10, so skipping the insert on the update path survives. It also never checks that an update refreshes recency.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index 1258372..89f926c 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1,3 @@
 //! Small in-memory caches.
+
+pub mod lru;
diff --git a/src/lru.rs b/src/lru.rs
new file mode 100644
index 0000000..4b9c8ff
--- /dev/null
+++ b/src/lru.rs
@@ -0,0 +1,92 @@
+use std::collections::{HashMap, VecDeque};
+use std::hash::Hash;
+
+/// A least-recently-used cache holding at most `cap` entries.
+pub struct LruCache<K, V> {
+    cap: usize,
+    map: HashMap<K, V>,
+    order: VecDeque<K>,
+}
+
+impl<K: Eq + Hash + Clone, V> LruCache<K, V> {
+    pub fn new(cap: usize) -> Self {
+        assert!(cap > 0, "capacity must be positive");
+        LruCache { cap, map: HashMap::new(), order: VecDeque::new() }
+    }
+
+    /// Returns the value and marks the key as most recently used.
+    pub fn get(&mut self, k: &K) -> Option<&V> {
+        if self.map.contains_key(k) {
+            self.touch(k);
+        }
+        self.map.get(k)
+    }
+
+    /// Inserts or updates a value. When full, evicts the least recently used key.
+    pub fn put(&mut self, k: K, v: V) {
+        if self.map.contains_key(&k) {
+            self.touch(&k);
+            self.map.insert(k, v);
+            return;
+        }
+        if self.map.len() == self.cap {
+            if let Some(oldest) = self.order.pop_front() {
+                self.map.remove(&oldest);
+            }
+        }
+        self.order.push_back(k.clone());
+        self.map.insert(k, v);
+    }
+
+    pub fn len(&self) -> usize {
+        self.map.len()
+    }
+
+    fn touch(&mut self, k: &K) {
+        if let Some(pos) = self.order.iter().position(|x| x == k) {
+            let key = self.order.remove(pos).unwrap();
+            self.order.push_back(key);
+        }
+    }
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn get_returns_inserted_value() {
+        let mut c = LruCache::new(2);
+        c.put("a", 1);
+        if let Some(v) = c.get(&"a") {
+            assert_eq!(*v, 1);
+        }
+    }
+
+    #[test]
+    fn evicts_when_full() {
+        let mut c = LruCache::new(2);
+        c.put("a", 1);
+        c.put("b", 2);
+        c.put("c", 3);
+        assert_eq!(c.len(), 2);
+    }
+
+    #[test]
+    fn recently_used_survives_eviction() {
+        let mut c = LruCache::new(2);
+        c.put("a", 1);
+        c.put("b", 2);
+        c.get(&"a");
+        c.put("c", 3);
+        assert!(c.get(&"c").is_some());
+    }
+
+    #[test]
+    fn updating_existing_key_keeps_size() {
+        let mut c = LruCache::new(2);
+        c.put("a", 1);
+        c.put("a", 10);
+        assert_eq!(c.len(), 1);
+    }
+}
````

</details>

## rust-token-bucket

New TokenBucket with four unit tests that execute every line but pin almost nothing.

- **boundary** (hand): The exact boundary where cost equals the available tokens is never tested, so `self.tokens >= cost` -> `>` survives (cargo-mutants does not generate this mutant; it needs a hand-applied mutation or a careful read). A test such as new(3, ..) then try_acquire(3) must succeed.
- **never-empties** (tool): `rejects_when_empty` asks for cost 5 from a bucket of capacity 2, which is rejected regardless of state, so the test never proves the first acquire consumed tokens. Mutating `self.tokens -= cost` to `+=` or `/=` survives. The test should request a cost that would succeed on a full bucket (e.g. 1) after draining it.
- **capacity-cap** (hand): `never_exceeds_capacity` only asserts `available() > 0`, so the `.min(capacity)` cap in refill is unpinned; removing the cap (or returning any positive count) passes. It should assert `available() == 5` (minus the acquired token, i.e. 4) after a long idle period.
- **refill-rate** (tool): `refills_over_time` waits 5 s at 2 tokens/s and only checks that one token is available, so the refill arithmetic (`elapsed * rate` -> `/` or `+`) survives. The test should pin the exact number of tokens refilled (e.g. available() == 10 after 5 s, or a short wait that yields exactly N tokens).

<details><summary>Diff under review</summary>

````diff
diff --git a/src/bucket.rs b/src/bucket.rs
new file mode 100644
index 0000000..d6f8bfa
--- /dev/null
+++ b/src/bucket.rs
@@ -0,0 +1,72 @@
+use std::time::Duration;
+
+/// A token bucket that refills continuously at `rate_per_sec` tokens per
+/// second, up to `capacity` tokens.
+pub struct TokenBucket {
+    capacity: u32,
+    rate_per_sec: u32,
+    tokens: f64,
+    last_refill: Duration,
+}
+
+impl TokenBucket {
+    /// Creates a full bucket.
+    pub fn new(capacity: u32, rate_per_sec: u32, now: Duration) -> Self {
+        TokenBucket { capacity, rate_per_sec, tokens: capacity as f64, last_refill: now }
+    }
+
+    fn refill(&mut self, now: Duration) {
+        let elapsed = now.saturating_sub(self.last_refill).as_secs_f64();
+        self.tokens = (self.tokens + elapsed * self.rate_per_sec as f64).min(self.capacity as f64);
+        self.last_refill = now;
+    }
+
+    /// Takes `cost` tokens if that many are available and reports whether the
+    /// request is allowed.
+    pub fn try_acquire(&mut self, cost: u32, now: Duration) -> bool {
+        self.refill(now);
+        if self.tokens >= cost as f64 {
+            self.tokens -= cost as f64;
+            true
+        } else {
+            false
+        }
+    }
+
+    /// Whole tokens currently available.
+    pub fn available(&self) -> u32 {
+        self.tokens.floor() as u32
+    }
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn allows_requests_when_tokens_available() {
+        let mut b = TokenBucket::new(10, 1, Duration::ZERO);
+        assert!(b.try_acquire(3, Duration::ZERO));
+    }
+
+    #[test]
+    fn rejects_when_empty() {
+        let mut b = TokenBucket::new(2, 1, Duration::ZERO);
+        b.try_acquire(2, Duration::ZERO);
+        assert!(!b.try_acquire(5, Duration::ZERO));
+    }
+
+    #[test]
+    fn refills_over_time() {
+        let mut b = TokenBucket::new(10, 2, Duration::ZERO);
+        b.try_acquire(10, Duration::ZERO);
+        assert!(b.try_acquire(1, Duration::from_secs(5)));
+    }
+
+    #[test]
+    fn never_exceeds_capacity() {
+        let mut b = TokenBucket::new(5, 100, Duration::ZERO);
+        b.try_acquire(1, Duration::from_secs(60));
+        assert!(b.available() > 0);
+    }
+}
diff --git a/src/lib.rs b/src/lib.rs
index 8e6d25e..e1bb3f9 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,4 @@
 //! Rate limiting primitives.
 
+pub mod bucket;
 pub mod window;
````

</details>

## rust-varint

Uncommitted LEB128 varint codec (protocol encoding) with a roundtrip test over single-byte values only.

- **single-byte-only** (tool): The roundtrip test only uses values below 128, so the multi-byte path (continuation bit `| 0x80`, `value >>= 7`, the shift `7 * i`) never runs with more than one byte; mutants there survive. Values such as 128, 300, 16384 and u64::MAX are needed.
- **no-golden-bytes** (static): Only roundtrips are tested, never the encoded bytes, so a bug made symmetrically in encode and decode (wrong group size, wrong bit order) would pass. This is a wire format, so tests should pin known encodings, e.g. 300 -> [0xAC, 0x02], 1 -> [0x01].
- **consumed-length-unchecked** (tool): The consumed byte count (`.1` of decode's result) is never asserted, so `i + 1` -> `i * 1` survives. Callers framing a stream depend on it.
- **error-variants** (tool): `decode_rejects_truncated` asserts only is_err(), not DecodeError::Truncated, and the Overflow path (11+ continuation bytes, `i >= 10`) has no test at all, so `>=` -> `>` and swapping the variants survive.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/lib.rs b/src/lib.rs
index 005a532..bb0cc8d 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1,3 @@
 //! Wire-format helpers.
+
+pub mod varint;
diff --git a/src/varint.rs b/src/varint.rs
new file mode 100644
index 0000000..7f3aa2c
--- /dev/null
+++ b/src/varint.rs
@@ -0,0 +1,57 @@
+//! LEB128 unsigned varints, as used by protobuf.
+
+#[derive(Debug, PartialEq, Eq)]
+pub enum DecodeError {
+    /// The buffer ended before a byte without the continuation bit.
+    Truncated,
+    /// More than 10 bytes, which cannot fit in a u64.
+    Overflow,
+}
+
+/// Appends `value` to `out` as an unsigned LEB128 varint.
+pub fn encode(mut value: u64, out: &mut Vec<u8>) {
+    loop {
+        let byte = (value & 0x7f) as u8;
+        value >>= 7;
+        if value == 0 {
+            out.push(byte);
+            return;
+        }
+        out.push(byte | 0x80);
+    }
+}
+
+/// Decodes a varint from the start of `buf`, returning the value and the
+/// number of bytes consumed.
+pub fn decode(buf: &[u8]) -> Result<(u64, usize), DecodeError> {
+    let mut result: u64 = 0;
+    for (i, &byte) in buf.iter().enumerate() {
+        if i >= 10 {
+            return Err(DecodeError::Overflow);
+        }
+        result |= ((byte & 0x7f) as u64) << (7 * i);
+        if byte & 0x80 == 0 {
+            return Ok((result, i + 1));
+        }
+    }
+    Err(DecodeError::Truncated)
+}
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+
+    #[test]
+    fn roundtrip_small_values() {
+        for v in [0u64, 1, 42, 127] {
+            let mut buf = Vec::new();
+            encode(v, &mut buf);
+            assert_eq!(decode(&buf).unwrap().0, v);
+        }
+    }
+
+    #[test]
+    fn decode_rejects_truncated() {
+        assert!(decode(&[0x80]).is_err());
+    }
+}
````

</details>

## ts-control-duration

Control case: duration parser whose tests pin exact values for every unit, combinations, whitespace, and exact error messages.

- Control: the report should say the tests are strong and must not claim a real gap.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/duration.ts b/src/duration.ts
new file mode 100644
index 0000000..b363004
--- /dev/null
+++ b/src/duration.ts
@@ -0,0 +1,20 @@
+const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
+
+/**
+ * Parses durations such as "250ms", "2s", or "1h30m" into milliseconds.
+ * Components must be adjacent; surrounding whitespace is ignored.
+ */
+export function parseDuration(input: string): number {
+  const text = input.trim();
+  if (text === "") throw new SyntaxError("empty duration");
+  const component = /(\d+)(ms|s|m|h)/y;
+  let total = 0;
+  let consumed = 0;
+  let match: RegExpExecArray | null;
+  while ((match = component.exec(text)) !== null) {
+    total += Number(match[1]) * UNIT_MS[match[2]];
+    consumed = component.lastIndex;
+  }
+  if (consumed !== text.length) throw new SyntaxError(`invalid duration: ${input}`);
+  return total;
+}
diff --git a/src/index.ts b/src/index.ts
index cb0ff5c..4fc3e3a 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export {};
+export { parseDuration } from "./duration";
diff --git a/test/duration.test.ts b/test/duration.test.ts
new file mode 100644
index 0000000..a4895d6
--- /dev/null
+++ b/test/duration.test.ts
@@ -0,0 +1,30 @@
+import { describe, expect, it } from "vitest";
+import { parseDuration } from "../src";
+
+describe("parseDuration", () => {
+  it.each([
+    ["250ms", 250],
+    ["2s", 2_000],
+    ["3m", 180_000],
+    ["1h", 3_600_000],
+    ["1h30m", 5_400_000],
+    ["1m1s1ms", 61_001],
+    ["0s", 0],
+    ["12ms", 12],
+  ])("parses %j as %d ms", (input, expected) => {
+    expect(parseDuration(input)).toBe(expected);
+  });
+
+  it("ignores surrounding whitespace", () => {
+    expect(parseDuration("  2s\n")).toBe(2_000);
+  });
+
+  it("rejects empty and blank input", () => {
+    expect(() => parseDuration("")).toThrow(new SyntaxError("empty duration"));
+    expect(() => parseDuration("   ")).toThrow(new SyntaxError("empty duration"));
+  });
+
+  it.each(["5", "s", "5x", "1h 30m", "1.5h", "-2s", "2s!"])("rejects %j", (input) => {
+    expect(() => parseDuration(input)).toThrow(new SyntaxError(`invalid duration: ${input}`));
+  });
+});
````

</details>

## ts-csv-fixtures

CSV escaping with fixture files in test/fixture/, but the test reads test/fixtures/ and silently generates zero fixture tests.

- **fixture-loop-empty** (static): The test reads `./fixtures/` but the files live in `test/fixture/` (singular), and the existsSync guard turns the typo into an empty loop, so none of the three fixture tests is ever registered; vitest runs 2 tests, not 5. The quoting branch therefore has no coverage (NoCoverage / survived mutants on the regex and the replace). The path should be fixed and the guard removed so a missing directory fails loudly.
- **no-carriage-return-case** (hand): Even with the path fixed, no fixture contains a carriage return, so dropping `\r` from the character class survives. A `\r` case (and a toCsvRow case with a field that needs quoting) is needed.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/csv.ts b/src/csv.ts
new file mode 100644
index 0000000..71abdc8
--- /dev/null
+++ b/src/csv.ts
@@ -0,0 +1,9 @@
+/** Quotes a field per RFC 4180 when it contains a quote, comma, CR, or LF. */
+export function escapeField(value: string): string {
+  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
+  return value;
+}
+
+export function toCsvRow(fields: readonly string[]): string {
+  return fields.map(escapeField).join(",");
+}
diff --git a/src/index.ts b/src/index.ts
index cb0ff5c..321f0e3 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export {};
+export { escapeField, toCsvRow } from "./csv";
diff --git a/test/csv.test.ts b/test/csv.test.ts
new file mode 100644
index 0000000..fd384aa
--- /dev/null
+++ b/test/csv.test.ts
@@ -0,0 +1,32 @@
+import { existsSync, readdirSync, readFileSync } from "node:fs";
+import { describe, expect, it } from "vitest";
+import { escapeField, toCsvRow } from "../src";
+
+interface Fixture {
+  input: string;
+  expected: string;
+}
+
+const fixtureDir = new URL("./fixtures/", import.meta.url);
+const fixtures = existsSync(fixtureDir)
+  ? readdirSync(fixtureDir).filter((name) => name.endsWith(".json"))
+  : [];
+
+describe("escapeField", () => {
+  for (const name of fixtures) {
+    it(`matches fixture ${name}`, () => {
+      const { input, expected }: Fixture = JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
+      expect(escapeField(input)).toBe(expected);
+    });
+  }
+
+  it("leaves plain fields alone", () => {
+    expect(escapeField("plain")).toBe("plain");
+  });
+});
+
+describe("toCsvRow", () => {
+  it("joins fields with commas", () => {
+    expect(toCsvRow(["a", "b", "c"])).toBe("a,b,c");
+  });
+});
diff --git a/test/fixture/comma.json b/test/fixture/comma.json
new file mode 100644
index 0000000..5872435
--- /dev/null
+++ b/test/fixture/comma.json
@@ -0,0 +1 @@
+{ "input": "a,b", "expected": "\"a,b\"" }
diff --git a/test/fixture/newline.json b/test/fixture/newline.json
new file mode 100644
index 0000000..8b1f6fe
--- /dev/null
+++ b/test/fixture/newline.json
@@ -0,0 +1 @@
+{ "input": "line\nbreak", "expected": "\"line\nbreak\"" }
diff --git a/test/fixture/quote.json b/test/fixture/quote.json
new file mode 100644
index 0000000..1593df5
--- /dev/null
+++ b/test/fixture/quote.json
@@ -0,0 +1 @@
+{ "input": "say \"hi\"", "expected": "\"say \"\"hi\"\"\"" }
````

</details>

## ts-emitter

New Emitter class; the removal test is a negative test without a positive control, and once() is checked with a single emit.

- **removal-wrong-event** (static): `does not call a listener after it is removed` subscribes to "save" but emits "close", so it passes even if off()/the unsubscribe function does nothing (`set?.delete(fn)` removed, or the returned closure emptied, survives). It is a negative test without a positive control; it must emit "save" after unsubscribing.
- **once-single-emit** (tool): `once listeners fire once` emits a single time and checks `toHaveBeenCalled()`, so removing the `off()` call inside once (listener fires on every emit) survives. It should emit twice and assert toHaveBeenCalledTimes(1) with the first payload.
- **listener-cleanup** (tool): listenerCount and the cleanup of empty listener sets in off() have no coverage at all (NoCoverage mutants). Lower priority than the two above.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/emitter.ts b/src/emitter.ts
new file mode 100644
index 0000000..f7bf4a5
--- /dev/null
+++ b/src/emitter.ts
@@ -0,0 +1,40 @@
+type Listener<T> = (payload: T) => void;
+
+/** A minimal typed event emitter. */
+export class Emitter<Events extends Record<string, unknown>> {
+  private listeners = new Map<keyof Events, Set<Listener<any>>>();
+
+  /** Subscribes `fn` and returns a function that unsubscribes it. */
+  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
+    let set = this.listeners.get(event);
+    if (!set) {
+      set = new Set();
+      this.listeners.set(event, set);
+    }
+    set.add(fn);
+    return () => this.off(event, fn);
+  }
+
+  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
+    const set = this.listeners.get(event);
+    set?.delete(fn);
+    if (set && set.size === 0) this.listeners.delete(event);
+  }
+
+  /** Subscribes `fn` for a single emission. */
+  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
+    const off = this.on(event, (payload) => {
+      off();
+      fn(payload);
+    });
+    return off;
+  }
+
+  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
+    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
+  }
+
+  listenerCount(event: keyof Events): number {
+    return this.listeners.get(event)?.size ?? 0;
+  }
+}
diff --git a/src/index.ts b/src/index.ts
index cb0ff5c..d9ea307 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export {};
+export { Emitter } from "./emitter";
diff --git a/test/emitter.test.ts b/test/emitter.test.ts
new file mode 100644
index 0000000..c622bce
--- /dev/null
+++ b/test/emitter.test.ts
@@ -0,0 +1,31 @@
+import { describe, expect, it, vi } from "vitest";
+import { Emitter } from "../src";
+
+type Events = { save: string; close: undefined };
+
+describe("Emitter", () => {
+  it("calls listeners with the payload", () => {
+    const e = new Emitter<Events>();
+    const fn = vi.fn();
+    e.on("save", fn);
+    e.emit("save", "doc1");
+    expect(fn).toHaveBeenCalledWith("doc1");
+  });
+
+  it("does not call a listener after it is removed", () => {
+    const e = new Emitter<Events>();
+    const fn = vi.fn();
+    const off = e.on("save", fn);
+    off();
+    e.emit("close", undefined);
+    expect(fn).not.toHaveBeenCalled();
+  });
+
+  it("once listeners fire once", () => {
+    const e = new Emitter<Events>();
+    const fn = vi.fn();
+    e.once("save", fn);
+    e.emit("save", "a");
+    expect(fn).toHaveBeenCalled();
+  });
+});
````

</details>

## ts-hard-mocked-unit

Adds reduced VAT rates to tax.ts and a PriceCalculator. The test file vi.mock()s the whole tax module (the other half of this change) and spies the loyalty discount away with mockReturnValue, so the new logic is replaced by test doubles.

- **tax-module-mocked** (tool): `vi.mock("../src/tax", () => ({ vatFor: () => 0.2 }))` replaces the module this change edits, so the new reduced-rate logic and NL rates in tax.ts are never executed (Stryker NoCoverage/Survived on tax.ts), and `uses the reduced rate for reduced items` passes with the mocked 20% rate (it only asserts > 1000). Tax tests must use the real module and pin exact rates (DE reduced 7%, FR 5.5%, fallback to standard rate for GB, unknown country 0).
- **discount-mocked-away** (tool): `applies the loyalty discount` stubs loyaltyDiscount with mockReturnValue(100), so the real 1%-per-year and the 10% cap (`Math.min(this.loyaltyYears, 10)`) and rounding are never tested; arithmetic and Math.min/max mutants in loyaltyDiscount survive. It should call the real method with e.g. 5 years and 15 years (capped).

<details><summary>Diff under review</summary>

````diff
diff --git a/src/index.ts b/src/index.ts
index 1a73e3b..1ab83f3 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
 export { vatFor } from "./tax";
+export { PriceCalculator, type Item } from "./pricing";
diff --git a/src/pricing.ts b/src/pricing.ts
new file mode 100644
index 0000000..36e4b52
--- /dev/null
+++ b/src/pricing.ts
@@ -0,0 +1,31 @@
+import { vatFor } from "./tax";
+
+export interface Item {
+  netCents: number;
+  qty: number;
+  reducedVat?: boolean;
+}
+
+export class PriceCalculator {
+  constructor(
+    private readonly country: string,
+    private readonly loyaltyYears = 0,
+  ) {}
+
+  /** 1% off per loyalty year, capped at 10%. */
+  loyaltyDiscount(netCents: number): number {
+    const pct = Math.min(this.loyaltyYears, 10);
+    return Math.round((netCents * pct) / 100);
+  }
+
+  /** Gross total in cents: net minus loyalty discount, plus VAT per item. */
+  total(items: Item[]): number {
+    let gross = 0;
+    for (const item of items) {
+      const net = item.netCents * item.qty;
+      const discounted = net - this.loyaltyDiscount(net);
+      gross += Math.round(discounted * (1 + vatFor(this.country, item.reducedVat)));
+    }
+    return gross;
+  }
+}
diff --git a/src/tax.ts b/src/tax.ts
index 0f624b7..03b632a 100644
--- a/src/tax.ts
+++ b/src/tax.ts
@@ -1,6 +1,10 @@
 /** VAT rates by country code, as fractions. */
-export const VAT: Record<string, number> = { DE: 0.19, FR: 0.2, GB: 0.2 };
+export const VAT: Record<string, number> = { DE: 0.19, FR: 0.2, GB: 0.2, NL: 0.21 };
 
-export function vatFor(country: string): number {
+/** Reduced rates for food, books, and similar categories. */
+export const REDUCED_VAT: Record<string, number> = { DE: 0.07, FR: 0.055, NL: 0.09 };
+
+export function vatFor(country: string, reduced = false): number {
+  if (reduced) return REDUCED_VAT[country] ?? VAT[country] ?? 0;
   return VAT[country] ?? 0;
 }
diff --git a/test/pricing.test.ts b/test/pricing.test.ts
new file mode 100644
index 0000000..ad317bb
--- /dev/null
+++ b/test/pricing.test.ts
@@ -0,0 +1,23 @@
+import { describe, expect, it, vi } from "vitest";
+import { PriceCalculator } from "../src/pricing";
+
+vi.mock("../src/tax", () => ({ vatFor: () => 0.2 }));
+
+describe("PriceCalculator", () => {
+  it("adds VAT to the net price", () => {
+    const calc = new PriceCalculator("FR");
+    expect(calc.total([{ netCents: 1000, qty: 2 }])).toBe(2400);
+  });
+
+  it("applies the loyalty discount", () => {
+    const calc = new PriceCalculator("FR", 5);
+    const spy = vi.spyOn(calc, "loyaltyDiscount").mockReturnValue(100);
+    expect(calc.total([{ netCents: 1000, qty: 2 }])).toBe(2280);
+    expect(spy).toHaveBeenCalledWith(2000);
+  });
+
+  it("uses the reduced rate for reduced items", () => {
+    const calc = new PriceCalculator("DE");
+    expect(calc.total([{ netCents: 1000, qty: 1, reducedVat: true }])).toBeGreaterThan(1000);
+  });
+});
````

</details>

## ts-hard-refactor-wrap

Rename util.ts -> strings.ts (tests moved verbatim) plus two behaviour changes: wrap() now splits long words (at hyphens or hard), and a new truncateMiddle(). The moved wrap tests never use a word longer than the width, and the truncateMiddle tests check only length and the ellipsis.

- **wrap-change-untested** (revert): The wrap() behaviour change (splitLong: hyphen splits and hard breaks for words longer than width) has no test; the moved tests pass on the old implementation (every word fits), so splitLong's mutants survive or have no coverage (`word.length <= width`, `hyphen > 0`, `hyphen + 1`, the lastIndexOf bound). Tests need a hyphenated long word (e.g. "state-of-the-art" at width 8) and an unhyphenated one longer than width.
- **truncate-middle-split** (tool): `shortens long strings` only asserts the length and that `…` appears, so how the kept characters are split between head and tail (Math.ceil vs floor, `keep - head`) and the `max <= 1` edge are unpinned. Exact expectations are needed, e.g. truncateMiddle("abcdefghijklmnop", 9) === "abcd…mnop", an even split case, and max = 1 / 0.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/index.ts b/src/index.ts
index af88f61..ff720b4 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export { capitalize, wrap } from "./util";
+export { capitalize, truncateMiddle, wrap } from "./strings";
diff --git a/src/strings.ts b/src/strings.ts
new file mode 100644
index 0000000..9b7123d
--- /dev/null
+++ b/src/strings.ts
@@ -0,0 +1,39 @@
+/**
+ * Greedy word wrap. Words longer than `width` are split at hyphens when
+ * possible, and hard-broken otherwise, so no line exceeds `width`.
+ */
+export function wrap(text: string, width: number): string[] {
+  const lines: string[] = [];
+  let line = "";
+  for (const word of text.split(/\s+/).filter(Boolean).flatMap((w) => splitLong(w, width))) {
+    if (line && line.length + 1 + word.length > width) {
+      lines.push(line);
+      line = word;
+    } else {
+      line = line ? `${line} ${word}` : word;
+    }
+  }
+  if (line) lines.push(line);
+  return lines;
+}
+
+function splitLong(word: string, width: number): string[] {
+  if (word.length <= width) return [word];
+  const hyphen = word.lastIndexOf("-", width - 1);
+  const cut = hyphen > 0 ? hyphen + 1 : width;
+  return [word.slice(0, cut), ...splitLong(word.slice(cut), width)];
+}
+
+export function capitalize(s: string): string {
+  return s.charAt(0).toUpperCase() + s.slice(1);
+}
+
+/** Shortens `s` to at most `max` characters by replacing the middle with `…`. */
+export function truncateMiddle(s: string, max: number): string {
+  if (s.length <= max) return s;
+  if (max <= 1) return "…".slice(0, max);
+  const keep = max - 1;
+  const head = Math.ceil(keep / 2);
+  const tail = keep - head;
+  return s.slice(0, head) + "…" + (tail > 0 ? s.slice(-tail) : "");
+}
diff --git a/src/util.ts b/src/util.ts
deleted file mode 100644
index cf11f20..0000000
--- a/src/util.ts
+++ /dev/null
@@ -1,18 +0,0 @@
-export function wrap(text: string, width: number): string[] {
-  const lines: string[] = [];
-  let line = "";
-  for (const word of text.split(/\s+/).filter(Boolean)) {
-    if (line && line.length + 1 + word.length > width) {
-      lines.push(line);
-      line = word;
-    } else {
-      line = line ? line + " " + word : word;
-    }
-  }
-  if (line) lines.push(line);
-  return lines;
-}
-
-export function capitalize(s: string): string {
-  return s.charAt(0).toUpperCase() + s.slice(1);
-}
diff --git a/test/util.test.ts b/test/strings.test.ts
similarity index 54%
rename from test/util.test.ts
rename to test/strings.test.ts
index 0c441d3..0e0a654 100644
--- a/test/util.test.ts
+++ b/test/strings.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "vitest";
-import { capitalize, wrap } from "../src/util";
+import { capitalize, truncateMiddle, wrap } from "../src/strings";
 
 describe("wrap", () => {
   it("wraps at the width", () => {
@@ -16,3 +16,15 @@ describe("capitalize", () => {
     expect(capitalize("hello")).toBe("Hello");
   });
 });
+
+describe("truncateMiddle", () => {
+  it("leaves short strings alone", () => {
+    expect(truncateMiddle("abc", 10)).toBe("abc");
+  });
+
+  it("shortens long strings", () => {
+    const out = truncateMiddle("abcdefghijklmnop", 9);
+    expect(out).toHaveLength(9);
+    expect(out).toContain("…");
+  });
+});
````

</details>

## ts-hard-sandbox-drop

Monorepo package packages/codec. Most coverage comes from vectors.test.ts, which imports ../../../shared/vectors.json from outside the package; Stryker's sandbox copies only the package, so that file fails to load there and its 12 tests drop out of the run.

- **sandbox-drops-vector-tests** (static): vectors.test.ts imports `../../../shared/vectors.json`, which is outside packages/codec, so in Stryker's default sandbox the file does not load and the run has 1 test instead of 13. The report must notice the test-count drop (or the import) and rerun correctly (inPlace in a scratch worktree, or equivalent); survivors from the sandboxed run are mostly false alarms. Reporting the encode/decode logic as untested on the strength of the sandboxed run counts as missing this (and as a false claim).
- **dangling-length-untested** (tool): Even with all 13 tests running, the `text.length % 4 === 1` length check is never exercised (no vector or error test has a length of 4n+1, e.g. "Zm9vY"), so it survives; only one invalid-character case is tested and its message is unpinned.

<details><summary>Diff under review</summary>

````diff
diff --git a/packages/codec/src/base64url.ts b/packages/codec/src/base64url.ts
new file mode 100644
index 0000000..139e7ea
--- /dev/null
+++ b/packages/codec/src/base64url.ts
@@ -0,0 +1,32 @@
+const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
+const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));
+
+/** Unpadded base64url (RFC 4648 section 5). */
+export function encodeBase64Url(bytes: Uint8Array): string {
+  let out = "";
+  for (let i = 0; i < bytes.length; i += 3) {
+    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
+    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
+    for (let j = 0; j < chars; j++) out += ALPHABET[(n >> (18 - 6 * j)) & 63];
+  }
+  return out;
+}
+
+/** Decodes unpadded base64url; throws on characters outside the alphabet or a dangling final character. */
+export function decodeBase64Url(text: string): Uint8Array {
+  if (text.length % 4 === 1) throw new SyntaxError("invalid base64url length");
+  const out: number[] = [];
+  for (let i = 0; i < text.length; i += 4) {
+    const group = text.slice(i, i + 4);
+    let n = 0;
+    for (let j = 0; j < 4; j++) {
+      const c = group[j];
+      const v = c === undefined ? 0 : LOOKUP.get(c);
+      if (v === undefined) throw new SyntaxError(`invalid base64url character: ${c}`);
+      n |= v << (18 - 6 * j);
+    }
+    const bytes = Math.floor((group.length * 6) / 8);
+    for (let k = 0; k < bytes; k++) out.push((n >> (16 - 8 * k)) & 255);
+  }
+  return new Uint8Array(out);
+}
diff --git a/packages/codec/src/index.ts b/packages/codec/src/index.ts
index cb0ff5c..7a305d2 100644
--- a/packages/codec/src/index.ts
+++ b/packages/codec/src/index.ts
@@ -1 +1 @@
-export {};
+export { decodeBase64Url, encodeBase64Url } from "./base64url";
diff --git a/packages/codec/test/errors.test.ts b/packages/codec/test/errors.test.ts
new file mode 100644
index 0000000..c31de33
--- /dev/null
+++ b/packages/codec/test/errors.test.ts
@@ -0,0 +1,8 @@
+import { describe, expect, it } from "vitest";
+import { decodeBase64Url } from "../src";
+
+describe("decodeBase64Url errors", () => {
+  it("rejects characters outside the alphabet", () => {
+    expect(() => decodeBase64Url("Zm9v+A")).toThrow(SyntaxError);
+  });
+});
diff --git a/packages/codec/test/vectors.test.ts b/packages/codec/test/vectors.test.ts
new file mode 100644
index 0000000..dc1f7c4
--- /dev/null
+++ b/packages/codec/test/vectors.test.ts
@@ -0,0 +1,15 @@
+import { describe, expect, it } from "vitest";
+import vectors from "../../../shared/vectors.json";
+import { decodeBase64Url, encodeBase64Url } from "../src";
+
+describe("shared base64url vectors", () => {
+  for (const { bytes, encoded } of vectors) {
+    it(`encodes ${JSON.stringify(encoded)}`, () => {
+      expect(encodeBase64Url(new Uint8Array(bytes))).toBe(encoded);
+    });
+
+    it(`decodes ${JSON.stringify(encoded)}`, () => {
+      expect([...decodeBase64Url(encoded)]).toEqual(bytes);
+    });
+  }
+});
````

</details>

## ts-hard-snapshot-bug

Money formatter tested by a snapshot that was recorded from buggy output: single-digit cents render as one decimal ("0,5 €", "1,0 €"), contradicting the documented two-decimal contract. Mutation testing mostly reports killed, because the snapshot pins the bug.

- **snapshot-pins-bug** (static): The committed snapshot contains "0,0 €", "0,5 €", "1,0 €" and "1.000.000,0 €", which violate the doc comment's 'exactly two decimals' (should be "0,05 €", "1,00 €"). The no-op ternary `rest < 10 ? String(rest) : String(rest)` (meant to pad) is the bug, and the snapshot enshrines it, so the test would fail if the bug were fixed. The report should call out that the snapshot contradicts the contract (and that the high kill rate is meaningless here) and recommend explicit toBe assertions for each amount.
- **negative-amounts-untested** (tool): No snapshot input is negative, so the sign handling (`cents < 0`, the `"-"` prefix, Math.abs) is unpinned; `cents < 0` -> `false` or the `"-"` literal -> `""` survives.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/format.ts b/src/format.ts
new file mode 100644
index 0000000..65a2896
--- /dev/null
+++ b/src/format.ts
@@ -0,0 +1,14 @@
+/**
+ * Formats integer cents as a German-style amount with exactly two decimals,
+ * a `.` thousands separator, and the currency symbol after a space:
+ * 123456 -> "1.234,56 €". Negative amounts get a leading minus sign.
+ */
+export function formatMoney(cents: number, symbol = "€"): string {
+  const negative = cents < 0;
+  const abs = Math.abs(cents);
+  const euros = Math.floor(abs / 100);
+  const rest = abs % 100;
+  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
+  const decimals = rest < 10 ? String(rest) : String(rest);
+  return `${negative ? "-" : ""}${grouped},${decimals} ${symbol}`;
+}
diff --git a/src/index.ts b/src/index.ts
index cb0ff5c..79ecd9a 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export {};
+export { formatMoney } from "./format";
diff --git a/test/__snapshots__/format.test.ts.snap b/test/__snapshots__/format.test.ts.snap
new file mode 100644
index 0000000..ac4225d
--- /dev/null
+++ b/test/__snapshots__/format.test.ts.snap
@@ -0,0 +1,15 @@
+// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html
+
+exports[`formatMoney > formats a range of amounts 1`] = `
+[
+  "0,0 €",
+  "0,5 €",
+  "0,99 €",
+  "1,0 €",
+  "10,50 €",
+  "1.234,56 €",
+  "1.000.000,0 €",
+]
+`;
+
+exports[`formatMoney > supports other symbols 1`] = `"2,50 $"`;
diff --git a/test/format.test.ts b/test/format.test.ts
new file mode 100644
index 0000000..153d53c
--- /dev/null
+++ b/test/format.test.ts
@@ -0,0 +1,13 @@
+import { describe, expect, it } from "vitest";
+import { formatMoney } from "../src";
+
+describe("formatMoney", () => {
+  it("formats a range of amounts", () => {
+    const amounts = [0, 5, 99, 100, 1050, 123456, 100000000];
+    expect(amounts.map((c) => formatMoney(c))).toMatchSnapshot();
+  });
+
+  it("supports other symbols", () => {
+    expect(formatMoney(250, "$")).toMatchSnapshot();
+  });
+});
````

</details>

## ts-hard-ttl-polling

TTL cache whose tests use real timers and a polling waitFor with a 5 s timeout. Mutants that break expiry make the tests hang until the timeout, so Stryker scores them as Timeout (detected) and the score is inflated; the injected Clock is never used.

- **polling-turns-bugs-into-timeouts** (tool): `expires entries after the ttl` and `prune removes expired entries` poll with waitFor (5 s timeout) instead of asserting, so mutants that break expiry (e.g. `now() >= expiresAt` -> `false`, `+ ttlMs` -> `- ttlMs` variants) make the test hang until Stryker's timeout and are counted as Timeout (detected), inflating the score. The report should flag the timeout share, explain it, and recommend the injected `Clock` (or vi.useFakeTimers) with direct assertions.
- **expiry-boundary** (hand): The documented boundary (expired once `now >= expiresAt`) is never tested at the exact instant; `>=` -> `>` in get() or prune() survives. With the injected clock, a test can set now = expiresAt - 1 and = expiresAt.
- **prune-count-and-survivors** (tool): `prune removes expired entries` asserts only `prune() > 0` then `size < 2`, so the returned count and which entries remain are unpinned (`removed++` -> `removed--`/no-op variants, deleting unexpired entries); there is no mix of expired and live entries. Real-timer sleeps also make the rewrite test timing-sensitive (80 ms ttl, 2 x 50 ms sleeps).

<details><summary>Diff under review</summary>

````diff
diff --git a/src/index.ts b/src/index.ts
index cb0ff5c..620b62c 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export {};
+export { TtlCache, type Clock } from "./ttl-cache";
diff --git a/src/ttl-cache.ts b/src/ttl-cache.ts
new file mode 100644
index 0000000..1294491
--- /dev/null
+++ b/src/ttl-cache.ts
@@ -0,0 +1,50 @@
+export type Clock = () => number;
+
+interface Entry<V> {
+  value: V;
+  expiresAt: number;
+}
+
+/**
+ * A map whose entries expire `ttlMs` after they were last written.
+ * An entry is expired once `now >= expiresAt`.
+ */
+export class TtlCache<K, V> {
+  private entries = new Map<K, Entry<V>>();
+
+  constructor(
+    private readonly ttlMs: number,
+    private readonly now: Clock = Date.now,
+  ) {}
+
+  set(key: K, value: V): void {
+    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
+  }
+
+  get(key: K): V | undefined {
+    const entry = this.entries.get(key);
+    if (!entry) return undefined;
+    if (this.now() >= entry.expiresAt) {
+      this.entries.delete(key);
+      return undefined;
+    }
+    return entry.value;
+  }
+
+  /** Removes expired entries and returns how many were removed. */
+  prune(): number {
+    let removed = 0;
+    const now = this.now();
+    for (const [key, entry] of this.entries) {
+      if (now >= entry.expiresAt) {
+        this.entries.delete(key);
+        removed++;
+      }
+    }
+    return removed;
+  }
+
+  get size(): number {
+    return this.entries.size;
+  }
+}
diff --git a/test/ttl-cache.test.ts b/test/ttl-cache.test.ts
new file mode 100644
index 0000000..bb959c6
--- /dev/null
+++ b/test/ttl-cache.test.ts
@@ -0,0 +1,42 @@
+import { describe, expect, it } from "vitest";
+import { TtlCache } from "../src";
+
+/** Polls until `predicate` holds, failing after `timeoutMs`. */
+async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
+  const start = Date.now();
+  while (!predicate()) {
+    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
+    await new Promise((resolve) => setTimeout(resolve, 10));
+  }
+}
+
+describe("TtlCache", () => {
+  it("returns values before they expire", () => {
+    const cache = new TtlCache<string, number>(1_000);
+    cache.set("a", 1);
+    expect(cache.get("a")).toBe(1);
+  });
+
+  it("expires entries after the ttl", async () => {
+    const cache = new TtlCache<string, number>(50);
+    cache.set("a", 1);
+    await waitFor(() => cache.get("a") === undefined);
+  });
+
+  it("rewriting a key extends its lifetime", async () => {
+    const cache = new TtlCache<string, number>(80);
+    cache.set("a", 1);
+    await new Promise((resolve) => setTimeout(resolve, 50));
+    cache.set("a", 2);
+    await new Promise((resolve) => setTimeout(resolve, 50));
+    expect(cache.get("a")).toBe(2);
+  });
+
+  it("prune removes expired entries", async () => {
+    const cache = new TtlCache<string, number>(30);
+    cache.set("a", 1);
+    cache.set("b", 2);
+    await waitFor(() => cache.prune() > 0);
+    expect(cache.size).toBeLessThan(2);
+  });
+});
````

</details>

## ts-hard-vacuous-asserts

Config loader whose tests guard every assertion behind `if (result.ok)` / `if (!result.ok)`, and whose no-warning test spies on console.error while warnings go to console.warn.

- **conditional-assertions** (static): Every loadConfig test asserts only inside `if (result.ok)` or `if (!result.ok)` with no expect.assertions / no assertion on `ok`, so a test passes when the result has the other shape: e.g. if the port validation always fails, `uses defaults` and `reads overrides` still pass; if it never fails, `rejects an invalid port` still passes. Mutants such as the port check -> `false` survive. Tests should assert `result` with toEqual({ ok: true, config: ... }) / toEqual({ ok: false, error: ... }).
- **spy-wrong-channel** (static): `does not warn about known settings` spies on `console.error`, but warn() writes to `console.warn` (and log.warnings), so `expect(spy).not.toHaveBeenCalled()` is vacuous: it passes even when known settings do warn, and there is no positive control showing the spy sees a warning for an unknown APP_* key. Spy on the real channel (or assert log.warnings) and add a positive case.
- **port-boundaries** (tool): Only 70000 is tested as invalid; the boundaries 0/1 and 65535/65536, non-integers ("80.5"), and non-numbers are untested, so `port < 1` -> `<= 1`, `port > 65535` -> `>=`, and the isInteger check survive. The host override is never asserted either.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/config.ts b/src/config.ts
new file mode 100644
index 0000000..c63daca
--- /dev/null
+++ b/src/config.ts
@@ -0,0 +1,31 @@
+import { warn } from "./log";
+
+export interface Config {
+  port: number;
+  host: string;
+  debug: boolean;
+}
+
+export type LoadResult = { ok: true; config: Config } | { ok: false; error: string };
+
+const DEFAULTS: Config = { port: 8080, host: "127.0.0.1", debug: false };
+
+/** Reads APP_PORT, APP_HOST and APP_DEBUG. Unknown APP_* variables produce a warning. */
+export function loadConfig(env: Record<string, string | undefined>): LoadResult {
+  const config = { ...DEFAULTS };
+  if (env.APP_PORT !== undefined) {
+    const port = Number(env.APP_PORT);
+    if (!Number.isInteger(port) || port < 1 || port > 65535) {
+      return { ok: false, error: `APP_PORT must be an integer in 1-65535, got ${env.APP_PORT}` };
+    }
+    config.port = port;
+  }
+  if (env.APP_HOST) config.host = env.APP_HOST;
+  if (env.APP_DEBUG !== undefined) config.debug = env.APP_DEBUG === "1" || env.APP_DEBUG === "true";
+  for (const key of Object.keys(env)) {
+    if (key.startsWith("APP_") && !["APP_PORT", "APP_HOST", "APP_DEBUG"].includes(key)) {
+      warn(`unknown setting ${key}`);
+    }
+  }
+  return { ok: true, config };
+}
diff --git a/src/index.ts b/src/index.ts
index cb0ff5c..ed7137b 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
-export {};
+export { loadConfig, type Config, type LoadResult } from "./config";
+export * as log from "./log";
diff --git a/src/log.ts b/src/log.ts
new file mode 100644
index 0000000..c434760
--- /dev/null
+++ b/src/log.ts
@@ -0,0 +1,6 @@
+export const warnings: string[] = [];
+
+export function warn(message: string): void {
+  warnings.push(message);
+  console.warn(message);
+}
diff --git a/test/config.test.ts b/test/config.test.ts
new file mode 100644
index 0000000..1f50882
--- /dev/null
+++ b/test/config.test.ts
@@ -0,0 +1,32 @@
+import { describe, expect, it, vi } from "vitest";
+import { loadConfig } from "../src/config";
+
+describe("loadConfig", () => {
+  it("uses defaults when nothing is set", () => {
+    const result = loadConfig({});
+    if (result.ok) {
+      expect(result.config).toEqual({ port: 8080, host: "127.0.0.1", debug: false });
+    }
+  });
+
+  it("reads overrides", () => {
+    const result = loadConfig({ APP_PORT: "9000", APP_HOST: "0.0.0.0", APP_DEBUG: "true" });
+    if (result.ok) {
+      expect(result.config.port).toBe(9000);
+      expect(result.config.debug).toBe(true);
+    }
+  });
+
+  it("rejects an invalid port", () => {
+    const result = loadConfig({ APP_PORT: "70000" });
+    if (!result.ok) {
+      expect(result.error).toContain("APP_PORT");
+    }
+  });
+
+  it("does not warn about known settings", () => {
+    const spy = vi.spyOn(console, "error");
+    loadConfig({ APP_PORT: "9000", APP_DEBUG: "0" });
+    expect(spy).not.toHaveBeenCalled();
+  });
+});
````

</details>

## ts-order-totals

Uncommitted order-total computation; the service test asserts the mock's canned return value and computeTotals is checked with toBeTruthy.

- **asserts-mock-return** (tool): `places an order with a coupon` asserts `order.totalCents` from the mocked repo.save, which returns the canned `saved` object, so it checks the fixture rather than the computation; any totals bug passes. It should assert what save was called with (toHaveBeenCalledWith with subtotal 2000, discount 200, total 1800).
- **truthy-object** (static): `computes totals` uses toBeTruthy() on an object, which is always truthy, so the test cannot fail; every arithmetic mutant in computeTotals (reduce, `*`, `-`, rounding) survives.
- **coupon-clamp** (tool): The coupon clamp to 0..50% (Math.min/Math.max, MAX_COUPON_PERCENT) and rounding to whole cents are never tested; coupons above 50, negative coupons, and an odd subtotal (rounding) are needed.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/orders.ts b/src/orders.ts
new file mode 100644
index 0000000..08a356f
--- /dev/null
+++ b/src/orders.ts
@@ -0,0 +1,20 @@
+import type { LineItem, Order, OrderRepo } from "./types";
+
+const MAX_COUPON_PERCENT = 50;
+
+/** Coupons are clamped to 0-50% and the discount is rounded to whole cents. */
+export function computeTotals(items: LineItem[], couponPercent = 0): Omit<Order, "items"> {
+  const subtotalCents = items.reduce((sum, item) => sum + item.unitCents * item.qty, 0);
+  const pct = Math.min(Math.max(couponPercent, 0), MAX_COUPON_PERCENT);
+  const discountCents = Math.round((subtotalCents * pct) / 100);
+  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
+}
+
+export class OrderService {
+  constructor(private readonly repo: OrderRepo) {}
+
+  async place(items: LineItem[], couponPercent = 0): Promise<Order> {
+    if (items.length === 0) throw new Error("cannot place an empty order");
+    return this.repo.save({ items, ...computeTotals(items, couponPercent) });
+  }
+}
diff --git a/test/orders.test.ts b/test/orders.test.ts
new file mode 100644
index 0000000..09fdaf4
--- /dev/null
+++ b/test/orders.test.ts
@@ -0,0 +1,30 @@
+import { describe, expect, it, vi } from "vitest";
+import { computeTotals, OrderService } from "../src/orders";
+import type { Order } from "../src/types";
+
+const saved: Order = {
+  items: [{ sku: "A", unitCents: 1000, qty: 2 }],
+  subtotalCents: 2000,
+  discountCents: 200,
+  totalCents: 1800,
+};
+
+describe("OrderService", () => {
+  it("places an order with a coupon", async () => {
+    const repo = { save: vi.fn().mockResolvedValue(saved) };
+    const order = await new OrderService(repo).place([{ sku: "A", unitCents: 1000, qty: 2 }], 10);
+    expect(repo.save).toHaveBeenCalled();
+    expect(order.totalCents).toBe(1800);
+  });
+
+  it("rejects empty orders", async () => {
+    const repo = { save: vi.fn() };
+    await expect(new OrderService(repo).place([])).rejects.toThrow();
+  });
+});
+
+describe("computeTotals", () => {
+  it("computes totals", () => {
+    expect(computeTotals([{ sku: "A", unitCents: 500, qty: 1 }])).toBeTruthy();
+  });
+});
````

</details>

## ts-paginate

New paginate() with three tests that only use an exact multiple of the page size. Invoked with the base ref `main`.

- **partial-last-page** (hand): Only 20 items with page size 10 are tested, an exact multiple, so a partial last page is never exercised; `Math.ceil` -> `Math.floor`/`Math.round` survives. A test with e.g. 21 items must expect totalPages 3 and a 1-item last page.
- **clamping-untested** (tool): Out-of-range pages (0, negative, beyond totalPages) and the empty list (totalPages = 1 via Math.max) are never tested, so the clamping in `Math.min(Math.max(1, page), totalPages)` and `Math.max(1, ...)` survives.
- **hasnext-true** (tool): `hasNext` is only ever asserted false; replacing the expression with `false` survives. Page 1 should assert hasNext === true. (The first-page test also checks only the length, not which items.)

<details><summary>Diff under review</summary>

````diff
diff --git a/src/index.ts b/src/index.ts
index ecb3ae8..7d698bd 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
 export const DEFAULT_PAGE_SIZE = 25;
+export { paginate, type Page } from "./paginate";
diff --git a/src/paginate.ts b/src/paginate.ts
new file mode 100644
index 0000000..f2a2e23
--- /dev/null
+++ b/src/paginate.ts
@@ -0,0 +1,20 @@
+export interface Page<T> {
+  items: T[];
+  /** 1-based page number actually returned (out-of-range requests are clamped). */
+  page: number;
+  totalPages: number;
+  hasNext: boolean;
+}
+
+export function paginate<T>(all: readonly T[], page: number, pageSize: number): Page<T> {
+  if (pageSize <= 0) throw new RangeError("pageSize must be positive");
+  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
+  const current = Math.min(Math.max(1, page), totalPages);
+  const start = (current - 1) * pageSize;
+  return {
+    items: all.slice(start, start + pageSize),
+    page: current,
+    totalPages,
+    hasNext: current < totalPages,
+  };
+}
diff --git a/test/paginate.test.ts b/test/paginate.test.ts
new file mode 100644
index 0000000..44011b2
--- /dev/null
+++ b/test/paginate.test.ts
@@ -0,0 +1,22 @@
+import { describe, expect, it } from "vitest";
+import { paginate } from "../src";
+
+const items = Array.from({ length: 20 }, (_, i) => i + 1);
+
+describe("paginate", () => {
+  it("returns the first page", () => {
+    const p = paginate(items, 1, 10);
+    expect(p.items).toHaveLength(10);
+    expect(p.totalPages).toBe(2);
+  });
+
+  it("returns the second page", () => {
+    const p = paginate(items, 2, 10);
+    expect(p.items[0]).toBe(11);
+    expect(p.hasNext).toBe(false);
+  });
+
+  it("throws on an invalid page size", () => {
+    expect(() => paginate(items, 1, 0)).toThrow();
+  });
+});
````

</details>

## ts-range-clamp

Off-by-one fix (clamp to size - 1) with a regression test that never exercises the clamp.

- **regression-test-passes-on-old-code** (revert): `clamps the end to the last byte` uses 500-999 on a 1000-byte resource, where the requested end is already the last byte, so no clamping happens and the test passes on the pre-fix code (`size`); `size - 1` -> `size` / `size + 1` survives. The test needs an end beyond the resource, e.g. parseRange("500-5000", 1000) -> [500, 999].
- **unsatisfiable-path** (tool): The RangeError path (start beyond the clamped end, e.g. "1000-1200" on 1000 bytes, whose behaviour this fix changes from [1000, 1000] to an error) has no test; `start > end` -> `>=` or `false` survives.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/range.ts b/src/range.ts
index bf965ea..d5f47a6 100644
--- a/src/range.ts
+++ b/src/range.ts
@@ -7,7 +7,7 @@ export function parseRange(spec: string, size: number): [number, number] {
   const m = /^(\d+)-(\d+)$/.exec(spec.trim());
   if (!m) throw new SyntaxError(`bad range: ${spec}`);
   const start = Number(m[1]);
-  const end = Math.min(Number(m[2]), size);
+  const end = Math.min(Number(m[2]), size - 1);
   if (start > end) throw new RangeError(`unsatisfiable range: ${spec}`);
   return [start, end];
 }
diff --git a/test/range.test.ts b/test/range.test.ts
index 797d57b..093b405 100644
--- a/test/range.test.ts
+++ b/test/range.test.ts
@@ -9,4 +9,8 @@ describe("parseRange", () => {
   it("rejects malformed specs", () => {
     expect(() => parseRange("abc", 1000)).toThrow(SyntaxError);
   });
+
+  it("clamps the end to the last byte", () => {
+    expect(parseRange("500-999", 1000)).toEqual([500, 999]);
+  });
 });
````

</details>

## ts-retry

New async retry helper with four vitest tests; the no-retry and backoff behaviour is not actually pinned.

- **try-catch-swallows** (static): `does not retry client errors` asserts inside a catch block with no expect.assertions / fail-on-resolve, so it passes if withRetry resolves instead of throwing. It should use `await expect(...).rejects` (or expect.assertions(n)).
- **no-retry-unverified** (tool): The same test checks `toHaveBeenCalled()` instead of `toHaveBeenCalledTimes(1)`, so retrying 4xx errors is not caught: mutating `err.status < 500` (to `<= 500`, `>= 500`, or `false`) survives. The name promises the no-retry behaviour that the body never checks.
- **attempt-count** (tool): `gives up after the configured retries` checks only that it rejects, not that fn ran retries+1 = 3 times; `attempt <= opts.retries` -> `<` survives. Off-by-one in retry count is untested.
- **backoff-delays** (tool): Every test passes `noSleep` and never inspects the delays, so the backoff schedule (`delayMs * 2 ** attempt`, and `attempt < opts.retries` controlling the last sleep) is unpinned; arithmetic mutants survive. A `vi.fn()` sleep should be asserted to receive [10, 20] for retries: 2.

<details><summary>Diff under review</summary>

````diff
diff --git a/src/index.ts b/src/index.ts
index e987f74..83b7c17 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
 export { HttpError } from "./errors";
+export { withRetry, type RetryOptions } from "./retry";
diff --git a/src/retry.ts b/src/retry.ts
new file mode 100644
index 0000000..1b6aa20
--- /dev/null
+++ b/src/retry.ts
@@ -0,0 +1,30 @@
+import { HttpError } from "./errors";
+
+export interface RetryOptions {
+  /** Retries after the first attempt. */
+  retries: number;
+  /** Delay before the first retry; doubles on each further retry. */
+  delayMs: number;
+  sleep?: (ms: number) => Promise<void>;
+}
+
+const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
+
+/**
+ * Runs `fn`, retrying server errors (5xx) and network failures with
+ * exponential backoff. Client errors (4xx) are thrown immediately.
+ */
+export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
+  const sleep = opts.sleep ?? defaultSleep;
+  let lastError: unknown;
+  for (let attempt = 0; attempt <= opts.retries; attempt++) {
+    try {
+      return await fn();
+    } catch (err) {
+      lastError = err;
+      if (err instanceof HttpError && err.status < 500) throw err;
+      if (attempt < opts.retries) await sleep(opts.delayMs * 2 ** attempt);
+    }
+  }
+  throw lastError;
+}
diff --git a/test/retry.test.ts b/test/retry.test.ts
new file mode 100644
index 0000000..15ec4b3
--- /dev/null
+++ b/test/retry.test.ts
@@ -0,0 +1,32 @@
+import { describe, expect, it, vi } from "vitest";
+import { HttpError, withRetry } from "../src";
+
+const noSleep = () => Promise.resolve();
+
+describe("withRetry", () => {
+  it("returns the value on success", async () => {
+    const fn = vi.fn().mockResolvedValue("ok");
+    expect(await withRetry(fn, { retries: 3, delayMs: 10, sleep: noSleep })).toBe("ok");
+  });
+
+  it("retries on server errors", async () => {
+    const fn = vi.fn().mockRejectedValueOnce(new HttpError(503)).mockResolvedValue("ok");
+    const result = await withRetry(fn, { retries: 3, delayMs: 10, sleep: noSleep });
+    expect(result).toBe("ok");
+  });
+
+  it("does not retry client errors", async () => {
+    const fn = vi.fn().mockRejectedValue(new HttpError(404));
+    try {
+      await withRetry(fn, { retries: 3, delayMs: 10, sleep: noSleep });
+    } catch (err) {
+      expect((err as HttpError).status).toBe(404);
+    }
+    expect(fn).toHaveBeenCalled();
+  });
+
+  it("gives up after the configured retries", async () => {
+    const fn = vi.fn().mockRejectedValue(new HttpError(500));
+    await expect(withRetry(fn, { retries: 2, delayMs: 10, sleep: noSleep })).rejects.toBeInstanceOf(HttpError);
+  });
+});
````

</details>

## ts-username-validator

Uncommitted rewrite from boolean to a result type with per-rule reasons; tests check validity only, far from the length limits.

- **length-boundaries** (tool): The length tests use 1 and 30 characters, far from the 3 and 20 limits, so `name.length < 3` -> `<= 3` and `> 20` -> `>= 20` survive. Tests need names of exactly 2, 3, 20 and 21 characters.
- **reasons-unpinned** (tool): The rejection tests assert only `valid === false`, and `reports why a name is rejected` uses `toHaveProperty("reason")`, which passes for any reason. The reason codes are user-facing, yet mutating any reason string (or reordering the checks so a different rule fires) survives. Each rejection should assert toEqual({ valid: false, reason: ... }).

<details><summary>Diff under review</summary>

````diff
diff --git a/src/validate.ts b/src/validate.ts
index 4db6dd8..8234d03 100644
--- a/src/validate.ts
+++ b/src/validate.ts
@@ -1,3 +1,16 @@
-export function isValidUsername(name: string): boolean {
-  return /^[a-z0-9_]{3,20}$/.test(name);
+export type UsernameResult =
+  | { valid: true }
+  | { valid: false; reason: "too_short" | "too_long" | "invalid_chars" | "edge_underscore" };
+
+/**
+ * Usernames are 3-20 characters of lowercase letters, digits, and
+ * underscores, and may not start or end with an underscore. The reason is
+ * shown to the user, so each rule reports its own code.
+ */
+export function validateUsername(name: string): UsernameResult {
+  if (name.length < 3) return { valid: false, reason: "too_short" };
+  if (name.length > 20) return { valid: false, reason: "too_long" };
+  if (!/^[a-z0-9_]+$/.test(name)) return { valid: false, reason: "invalid_chars" };
+  if (name.startsWith("_") || name.endsWith("_")) return { valid: false, reason: "edge_underscore" };
+  return { valid: true };
 }
diff --git a/test/validate.test.ts b/test/validate.test.ts
index c2f5987..2756497 100644
--- a/test/validate.test.ts
+++ b/test/validate.test.ts
@@ -1,6 +1,17 @@
-import { expect, it } from "vitest";
-import { isValidUsername } from "../src/validate";
+import { describe, expect, it } from "vitest";
+import { validateUsername } from "../src/validate";
 
-it("accepts a normal username", () => {
-  expect(isValidUsername("alice_01")).toBe(true);
+describe("validateUsername", () => {
+  it("accepts a normal username", () => {
+    expect(validateUsername("alice_01").valid).toBe(true);
+  });
+
+  it.each(["a", "x".repeat(30), "Alice", "bob smith", "_alice", "alice_"])("rejects %j", (name) => {
+    expect(validateUsername(name).valid).toBe(false);
+  });
+
+  it("reports why a name is rejected", () => {
+    const result = validateUsername("Alice!");
+    expect(result).toHaveProperty("reason");
+  });
 });
````

</details>
