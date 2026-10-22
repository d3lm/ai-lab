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
    let value = parse_mantissa(mantissa)?;
    let exp = match exponent {
        Some(e) => parse_exponent(e)?,
        None => 0,
    };
    Ok(value * 10f64.powi(exp))
}

fn parse_mantissa(s: &str) -> Result<f64, ParseNumberError> {
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let mut value = 0f64;
    let mut scale = None::<f64>;
    for c in digits.chars() {
        match c {
            '_' => continue,
            '.' if scale.is_none() => scale = Some(1.0),
            '0'..='9' => {
                let d = c.to_digit(10).unwrap() as f64;
                match scale.as_mut() {
                    Some(sc) => {
                        *sc /= 10.0;
                        value += d * *sc;
                    }
                    None => value = value * 10.0 + d,
                }
            }
            other => return Err(ParseNumberError::InvalidDigit(other)),
        }
    }
    Ok(if negative { -value } else { value })
}

fn parse_exponent(s: &str) -> Result<i32, ParseNumberError> {
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    if digits.is_empty() {
        return Err(ParseNumberError::Empty);
    }
    let mut exp: i32 = 0;
    for c in digits.chars() {
        let d = c.to_digit(10).ok_or(ParseNumberError::InvalidDigit(c))? as i32;
        exp = exp.checked_mul(10).and_then(|e| e.checked_add(d)).ok_or(ParseNumberError::ExponentOverflow)?;
    }
    Ok(if negative { -exp } else { exp })
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
    fn fractions() {
        assert_eq!(parse_number("2.5"), Ok(2.5));
        assert_eq!(parse_number("-0.25"), Ok(-0.25));
    }

    #[test]
    fn separators() {
        assert_eq!(parse_number("1_000_000"), Ok(1_000_000.0));
    }

    #[test]
    fn positive_exponent() {
        assert_eq!(parse_number("1.5e3"), Ok(1500.0));
        assert_eq!(parse_number("2E+2"), Ok(200.0));
    }

    #[test]
    fn negative_exponent() {
        assert_eq!(parse_number("25e-2"), Ok(0.25));
    }

    #[test]
    fn errors() {
        assert_eq!(parse_number(""), Err(ParseNumberError::Empty));
        assert_eq!(parse_number("1x"), Err(ParseNumberError::InvalidDigit('x')));
        assert_eq!(parse_number("1e"), Err(ParseNumberError::Empty));
    }

    #[test]
    fn exponent_overflow() {
        assert_eq!(parse_number("1e99999999999"), Err(ParseNumberError::ExponentOverflow));
    }
}
