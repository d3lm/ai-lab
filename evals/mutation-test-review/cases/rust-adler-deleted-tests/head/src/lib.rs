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
    fn wikipedia_example() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn single_byte() {
        assert_eq!(adler32(b"a"), 0x0062_0062);
    }

    #[test]
    fn checksum_is_deterministic() {
        let data = b"The quick brown fox jumps over the lazy dog";
        let first = adler32(data);
        assert_eq!(first, first);
    }
}
