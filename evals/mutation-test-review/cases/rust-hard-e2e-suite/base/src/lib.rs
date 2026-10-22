//! Turns titles into URL slugs.

/// Lowercases ASCII letters and digits, joins words with `-`.
pub fn slugify(title: &str, max_len: usize) -> String {
    let mut out = String::new();
    for word in title.split_whitespace() {
        let word: String = word.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&word.to_ascii_lowercase());
    }
    out.truncate(max_len);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_words() {
        assert_eq!(slugify("Hello World", 64), "hello-world");
    }
}
