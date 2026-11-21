//! The slice of loop's RPC protocol this app uses
//! (packages/core/src/rpc/protocol.ts is the source of truth).

use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

/// The protocol version this client was written against, [major, minor].
pub const PROTOCOL: [u32; 2] = [1, 3];

pub fn hello_params() -> Value {
    json!({ "protocol": PROTOCOL, "client": "loop-gpui" })
}

/// One row of `session.list`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub cwd: String,
    /// Last activity, in milliseconds since the epoch.
    #[serde(deserialize_with = "whole_millis")]
    pub mtime: u64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub first_user_message: Option<String>,
    #[serde(default)]
    pub last_model: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub running: bool,
}

impl SessionRow {
    /// The model the session runs now, not the one it was created with.
    pub fn current_model(&self) -> Option<&str> {
        self.last_model.as_deref().or(self.model.as_deref())
    }
}

/// Some sessions carry a file mtime with sub-millisecond precision
/// (`1782938194848.9668`): JS numbers don't promise an integer.
fn whole_millis<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    f64::deserialize(deserializer).map(|millis| millis.max(0.0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fractional_mtime_still_decodes() {
        let row: SessionRow =
            serde_json::from_value(json!({ "id": "s", "cwd": "/w", "mtime": 1782938194848.9668 }))
                .unwrap();
        assert_eq!(row.mtime, 1782938194848);
    }
}
