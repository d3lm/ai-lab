use std::fmt;

/// Errors produced while decoding a frame.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The buffer ended early; `needed` more bytes are required.
    Truncated { needed: usize },
    /// RSV1-3 were set, which this protocol never does.
    ReservedBits,
    /// The declared payload length exceeds [`crate::MAX_PAYLOAD`].
    TooLarge(u64),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::Truncated { needed } => write!(f, "frame truncated, need {needed} more bytes"),
            FrameError::ReservedBits => write!(f, "reserved bits set"),
            FrameError::TooLarge(n) => write!(f, "frame of {n} bytes exceeds limit"),
        }
    }
}

impl std::error::Error for FrameError {}
