use std::collections::BTreeMap;

/// Why a configuration file was rejected. Line numbers are 1-based.
#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    MissingEquals { line: usize },
    EmptyKey { line: usize },
    DuplicateKey { key: String, line: usize },
}

/// Parses `key = value` lines into a map. Blank lines and lines starting
/// with `#` are ignored. Keys and values are trimmed.
pub fn parse(input: &str) -> Result<BTreeMap<String, String>, ParseError> {
    let mut out = BTreeMap::new();
    for (i, raw) in input.lines().enumerate() {
        let line_no = i + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            return Err(ParseError::MissingEquals { line: line_no });
        };
        let key = k.trim();
        if key.is_empty() {
            return Err(ParseError::EmptyKey { line: line_no });
        }
        if out.contains_key(key) {
            return Err(ParseError::DuplicateKey { key: key.to_string(), line: line_no });
        }
        out.insert(key.to_string(), v.trim().to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_file() {
        let cfg = parse("host = example.com\nport=8080\n");
        assert!(cfg.is_ok());
    }

    #[test]
    fn skips_comments_and_blank_lines() {
        let cfg = parse("# comment\n\nname=demo\n").unwrap();
        assert_eq!(cfg.len(), 1);
    }

    #[test]
    fn rejects_line_without_equals() {
        assert!(parse("host example.com").is_err());
    }

    #[test]
    fn rejects_empty_key() {
        assert!(parse("=value").is_err());
    }

    #[test]
    fn rejects_duplicate_keys() {
        assert!(parse("a=1\na=2").is_err());
    }
}
