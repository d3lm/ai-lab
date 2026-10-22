use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    Truncated { needed: usize },
    ReservedBits,
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
