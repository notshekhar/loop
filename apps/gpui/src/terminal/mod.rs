//! A terminal: a shell in a pty (`session`), the screen read out of it
//! (`frame`), its colours (Zed's) and its keyboard encoding. Nothing here draws —
//! `ui::terminal` does.

pub mod colors;
mod contrast;
pub mod frame;
pub mod keys;
pub mod session;
