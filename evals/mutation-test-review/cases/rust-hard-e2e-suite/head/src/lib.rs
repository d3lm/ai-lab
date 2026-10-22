//! Turns titles into URL slugs.

/// Lowercases ASCII letters and digits and joins words with `-`.
///
/// Accented Latin letters are folded to ASCII (`é` -> `e`) instead of being
/// dropped. When the slug is longer than `max_len` it is cut at the last word
/// boundary that fits, so slugs never end in a partial word or a `-`.
pub fn slugify(title: &str, max_len: usize) -> String {
    let mut out = String::new();
    for word in title.split_whitespace() {
        let word: String = word.chars().filter_map(fold).collect();
        if word.is_empty() {
            continue;
        }
        let extra = if out.is_empty() { word.len() } else { word.len() + 1 };
        if out.len() + extra > max_len {
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&word);
    }
    out
}

fn fold(c: char) -> Option<char> {
    let c = match c {
        'à' | 'á' | 'â' | 'ä' | 'À' | 'Á' | 'Â' | 'Ä' => 'a',
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'ö' | 'Ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'Ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        c => c,
    };
    c.is_ascii_alphanumeric().then(|| c.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_words() {
        assert_eq!(slugify("Hello World", 64), "hello-world");
    }

    #[test]
    fn folds_accents() {
        assert!(slugify("Crème Brûlée", 64).starts_with("creme"));
    }
}
