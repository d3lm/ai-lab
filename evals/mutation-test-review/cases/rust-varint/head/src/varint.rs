//! LEB128 unsigned varints, as used by protobuf.

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// The buffer ended before a byte without the continuation bit.
    Truncated,
    /// More than 10 bytes, which cannot fit in a u64.
    Overflow,
}

/// Appends `value` to `out` as an unsigned LEB128 varint.
pub fn encode(mut value: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Decodes a varint from the start of `buf`, returning the value and the
/// number of bytes consumed.
pub fn decode(buf: &[u8]) -> Result<(u64, usize), DecodeError> {
    let mut result: u64 = 0;
    for (i, &byte) in buf.iter().enumerate() {
        if i >= 10 {
            return Err(DecodeError::Overflow);
        }
        result |= ((byte & 0x7f) as u64) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok((result, i + 1));
        }
    }
    Err(DecodeError::Truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_small_values() {
        for v in [0u64, 1, 42, 127] {
            let mut buf = Vec::new();
            encode(v, &mut buf);
            assert_eq!(decode(&buf).unwrap().0, v);
        }
    }

    #[test]
    fn decode_rejects_truncated() {
        assert!(decode(&[0x80]).is_err());
    }
}
