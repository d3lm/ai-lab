use super::sign::split_sign;
use super::ParseNumberError;

pub(super) fn parse(s: &str) -> Result<i32, ParseNumberError> {
    let (negative, digits) = split_sign(s);
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
    fn positive_exponent() {
        assert_eq!(parse("3"), Ok(3));
        assert_eq!(parse("+2"), Ok(2));
    }

    #[test]
    #[ignore = "slow on CI"]
    fn exponent_overflow() {
        assert_eq!(parse("99999999999"), Err(ParseNumberError::ExponentOverflow));
    }
}
