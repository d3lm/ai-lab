//! Framing for the relay protocol.
//!
//! A frame is a header followed by the (optionally masked) payload. The
//! header layout follows RFC 6455 section 5.2.

pub mod error;
pub mod frame;
pub mod mask;

pub use error::FrameError;
pub use frame::{decode, encode, Frame, MAX_PAYLOAD};
