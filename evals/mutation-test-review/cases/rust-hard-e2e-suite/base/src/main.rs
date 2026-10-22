use std::io::{self, BufRead, Write};

fn main() {
    let max = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(64);
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        writeln!(out, "{}", slugtool::slugify(&line.unwrap(), max)).unwrap();
    }
}
