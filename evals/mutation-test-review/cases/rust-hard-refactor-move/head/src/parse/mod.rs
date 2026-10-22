//! Decimal number parsing, split by component.

mod exponent;
mod mantissa;
mod sign;

#[derive(Debug, PartialEq)]
pub enum ParseNumberError {
    Empty,
    InvalidDigit(char),
    ExponentOverflow,
}

/// Parses decimal numbers with an optional sign, fraction, and exponent,
/// plus `_` digit separators: `-1_000.5e-3`.
pub fn parse_number(s: &str) -> Result<f64, ParseNumberError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(ParseNumberError::Empty);
    }
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let value = mantissa::parse(mantissa)?;
    let exp = match exponent {
        Some(e) => exponent::parse(e)?,
        None => 0,
    };
    Ok(value * 10f64.powi(exp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_and_signs() {
        assert_eq!(parse_number("42"), Ok(42.0));
        assert_eq!(parse_number("-42"), Ok(-42.0));
        assert_eq!(parse_number("+7"), Ok(7.0));
    }

    #[test]
    fn errors() {
        assert_eq!(parse_number(""), Err(ParseNumberError::Empty));
        assert_eq!(parse_number("1x"), Err(ParseNumberError::InvalidDigit('x')));
        assert_eq!(parse_number("1e"), Err(ParseNumberError::Empty));
    }
}
