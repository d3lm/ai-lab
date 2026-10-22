//! Golden-file tests. Regenerate with `UPDATE_GOLDEN=1 cargo test`.

use tablefmt::table::{render, Align};

fn normalise(s: &str) -> Vec<Vec<&str>> {
    s.lines().map(|l| l.split_whitespace().collect()).collect()
}

fn check_golden(name: &str, actual: &str) {
    let path = format!("{}/tests/golden/{name}.txt", env!("CARGO_MANIFEST_DIR"));
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    // Compare cell by cell so the test doesn't break on cosmetic spacing changes.
    assert_eq!(normalise(actual), normalise(&expected));
}

fn rows() -> Vec<Vec<String>> {
    [["cargo", "12345", "root"], ["rustc", "987", "alice"], ["README.md", "1", "bob"]]
        .iter()
        .map(|r| r.iter().map(|c| c.to_string()).collect())
        .collect()
}

#[test]
fn basic_table() {
    let out = render(&["name", "size", "owner"], &rows(), &[Align::Left, Align::Right, Align::Left], 7);
    check_golden("basic", &out);
}

#[test]
fn every_line_is_trimmed() {
    let out = render(&["name", "size", "owner"], &rows(), &[Align::Left, Align::Right, Align::Left], 7);
    assert!(out.lines().all(|l| !l.ends_with(' ')));
}
