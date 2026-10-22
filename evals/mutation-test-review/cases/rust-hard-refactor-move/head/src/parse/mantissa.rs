use super::sign::split_sign;
use super::ParseNumberError;

pub(super) fn parse(s: &str) -> Result<f64, ParseNumberError> {
    let (negative, digits) = split_sign(s);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractions() {
        assert_eq!(parse("2.5"), Ok(2.5));
        assert_eq!(parse("-0.25"), Ok(-0.25));
    }

    #[test]
    fn separators() {
        assert_eq!(parse("1_000_000"), Ok(1_000_000.0));
    }
}
