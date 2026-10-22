//! Adler-32 checksum (RFC 1950).

const MOD: u32 = 65521;

pub fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_one() {
        assert_eq!(adler32(b""), 1);
    }

    #[test]
    fn wikipedia_example() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn large_input_wraps_modulus() {
        let data = vec![0xFFu8; 6000];
        assert_eq!(adler32(&data), 0xA497_59EA);
    }

    #[test]
    fn single_byte() {
        assert_eq!(adler32(b"a"), 0x0062_0062);
    }
}
