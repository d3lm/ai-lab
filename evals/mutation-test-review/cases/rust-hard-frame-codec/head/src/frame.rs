use crate::error::FrameError;
use crate::mask::apply_mask;

/// Largest payload accepted by [`decode`] (16 MiB).
pub const MAX_PAYLOAD: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub opcode: u8,
    pub mask: Option<[u8; 4]>,
    pub payload: Vec<u8>,
}

/// Serialises a frame. Payload lengths up to 125 use the 7-bit form, up to
/// 65535 the 16-bit form, and anything larger the 64-bit form.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.payload.len() + 14);
    out.push(((frame.fin as u8) << 7) | (frame.opcode & 0x0f));
    let mask_bit = if frame.mask.is_some() { 0x80 } else { 0 };
    let len = frame.payload.len();
    if len < 126 {
        out.push(mask_bit | len as u8);
    } else if len <= 0xffff {
        out.push(mask_bit | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(mask_bit | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    if let Some(key) = frame.mask {
        out.extend_from_slice(&key);
    }
    let body = out.len();
    out.extend_from_slice(&frame.payload);
    if let Some(key) = frame.mask {
        apply_mask(&mut out[body..], key);
    }
    out
}

/// Parses one frame from the start of `buf`, returning it and the number of
/// bytes consumed.
pub fn decode(buf: &[u8]) -> Result<(Frame, usize), FrameError> {
    if buf.len() < 2 {
        return Err(FrameError::Truncated { needed: 2 - buf.len() });
    }
    if buf[0] & 0x70 != 0 {
        return Err(FrameError::ReservedBits);
    }
    let fin = buf[0] & 0x80 != 0;
    let opcode = buf[0] & 0x0f;
    let masked = buf[1] & 0x80 != 0;
    let (len, mut pos) = match buf[1] & 0x7f {
        126 => {
            if buf.len() < 4 {
                return Err(FrameError::Truncated { needed: 4 - buf.len() });
            }
            (u16::from_be_bytes([buf[2], buf[3]]) as u64, 4)
        }
        127 => {
            if buf.len() < 10 {
                return Err(FrameError::Truncated { needed: 10 - buf.len() });
            }
            (u64::from_be_bytes(buf[2..10].try_into().unwrap()), 10)
        }
        n => (n as u64, 2),
    };
    if len > MAX_PAYLOAD {
        return Err(FrameError::TooLarge(len));
    }
    let mask = if masked {
        if buf.len() < pos + 4 {
            return Err(FrameError::Truncated { needed: pos + 4 - buf.len() });
        }
        let key = [buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]];
        pos += 4;
        Some(key)
    } else {
        None
    };
    let end = pos + len as usize;
    if buf.len() < end {
        return Err(FrameError::Truncated { needed: end - buf.len() });
    }
    let mut payload = buf[pos..end].to_vec();
    if let Some(key) = mask {
        apply_mask(&mut payload, key);
    }
    Ok((Frame { fin, opcode, mask, payload }, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(len: usize, mask: Option<[u8; 4]>) -> Frame {
        Frame { fin: true, opcode: 2, mask, payload: (0..len).map(|i| i as u8).collect() }
    }

    #[test]
    fn small_frame_header_bytes() {
        let bytes = encode(&frame(5, None));
        assert_eq!(&bytes[..2], &[0x82, 0x05]);
    }

    #[test]
    fn roundtrips_small_and_medium_frames() {
        for len in [0, 5, 200, 1000] {
            let f = frame(len, None);
            let (decoded, used) = decode(&encode(&f)).unwrap();
            assert_eq!(decoded, f);
            assert_eq!(used, encode(&f).len());
        }
    }

    #[test]
    fn masked_payload_differs_on_the_wire() {
        let f = frame(8, Some([1, 2, 3, 4]));
        let bytes = encode(&f);
        assert_ne!(&bytes[bytes.len() - 8..], &f.payload[..]);
    }

    #[test]
    fn rejects_truncated_input() {
        assert!(decode(&[0x82]).is_err());
        assert!(decode(&[0x82, 0x05, 1, 2]).is_err());
    }

    #[test]
    fn rejects_reserved_bits() {
        assert_eq!(decode(&[0xc2, 0x00]), Err(FrameError::ReservedBits));
    }
}
