mod client;
pub mod protocol;

use std::process::Command;

pub use client::{Notification, Notifications, RpcClient};

/// Starts `loop rpc`. `LOOP_BINARY` picks a specific build (e.g. a dev build
/// from packages/cli/dist); otherwise `loop` from PATH.
pub fn spawn_loop_host() -> anyhow::Result<(RpcClient, Notifications)> {
    let binary = std::env::var("LOOP_BINARY").unwrap_or_else(|_| "loop".into());
    let mut command = Command::new(binary);
    command.arg("rpc");
    RpcClient::spawn(command)
}
