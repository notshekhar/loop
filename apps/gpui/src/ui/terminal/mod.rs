//! The terminal drawer (⌘J) and its panes.

pub mod actions;
mod drawer;
mod paint;
mod render;
mod view;

pub use drawer::{DrawerEvent, TerminalDrawer};
