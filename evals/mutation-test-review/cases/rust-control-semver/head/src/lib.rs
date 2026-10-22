//! A tiny subset of semantic versioning.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    WrongPartCount(usize),
    InvalidNumber(String),
}

/// Parses `MAJOR.MINOR.PATCH`, ignoring surrounding whitespace.
pub fn parse(s: &str) -> Result<Version, ParseError> {
    let parts: Vec<&str> = s.trim().split('.').collect();
    if parts.len() != 3 {
        return Err(ParseError::WrongPartCount(parts.len()));
    }
    let num = |p: &str| p.parse::<u64>().map_err(|_| ParseError::InvalidNumber(p.to_string()));
    Ok(Version { major: num(parts[0])?, minor: num(parts[1])?, patch: num(parts[2])? })
}

/// Cargo-style caret requirement: `^req` allows changes that do not modify
/// the left-most non-zero component.
pub fn satisfies_caret(v: Version, req: Version) -> bool {
    if v < req {
        return false;
    }
    if req.major > 0 {
        return v.major == req.major;
    }
    if req.minor > 0 {
        return v.major == 0 && v.minor == req.minor;
    }
    v.major == 0 && v.minor == 0 && v.patch == req.patch
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        parse(s).unwrap()
    }

    #[test]
    fn parses_each_component() {
        assert_eq!(parse("1.2.3"), Ok(Version { major: 1, minor: 2, patch: 3 }));
    }

    #[test]
    fn parse_trims_whitespace() {
        assert_eq!(parse("  4.5.6\n"), Ok(Version { major: 4, minor: 5, patch: 6 }));
    }

    #[test]
    fn parse_rejects_wrong_part_count() {
        assert_eq!(parse("1.2"), Err(ParseError::WrongPartCount(2)));
        assert_eq!(parse("1.2.3.4"), Err(ParseError::WrongPartCount(4)));
    }

    #[test]
    fn parse_reports_the_invalid_component() {
        assert_eq!(parse("1.x.3"), Err(ParseError::InvalidNumber("x".to_string())));
        assert_eq!(parse("1.2.-3"), Err(ParseError::InvalidNumber("-3".to_string())));
    }

    #[test]
    fn versions_order_by_major_then_minor_then_patch() {
        assert!(v("1.0.0") > v("0.9.9"));
        assert!(v("1.2.0") > v("1.1.9"));
        assert!(v("1.1.2") > v("1.1.1"));
    }

    #[test]
    fn caret_with_nonzero_major() {
        let req = v("1.2.3");
        assert!(satisfies_caret(v("1.2.3"), req));
        assert!(satisfies_caret(v("1.9.0"), req));
        assert!(!satisfies_caret(v("1.2.2"), req));
        assert!(!satisfies_caret(v("2.0.0"), req));
    }

    #[test]
    fn caret_with_zero_major() {
        let req = v("0.2.3");
        assert!(satisfies_caret(v("0.2.3"), req));
        assert!(satisfies_caret(v("0.2.9"), req));
        assert!(!satisfies_caret(v("0.2.2"), req));
        assert!(!satisfies_caret(v("0.3.0"), req));
        assert!(!satisfies_caret(v("1.2.3"), req));
    }

    #[test]
    fn caret_with_zero_major_and_minor() {
        let req = v("0.0.3");
        assert!(satisfies_caret(v("0.0.3"), req));
        assert!(!satisfies_caret(v("0.0.4"), req));
        assert!(!satisfies_caret(v("0.1.3"), req));
        assert!(!satisfies_caret(v("1.0.3"), req));
    }
}
