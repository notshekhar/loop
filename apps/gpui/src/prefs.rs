//! What the app remembers between launches that is its own, not loop's —
//! kept out of ~/.loop so nothing loop or pi reads ever changes shape.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// The editor "Open" uses, as loop's `loop:last-editor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_editor: Option<String>,
}

/// `~/Library/Application Support/loop-gpui/prefs.json`.
pub fn default_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support/loop-gpui/prefs.json"))
}

impl Prefs {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_survive_a_round_trip_and_a_missing_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("loop-gpui-prefs-{}", std::process::id()));
        let path = dir.join("nested/prefs.json");
        assert_eq!(Prefs::load(&path), Prefs::default());
        let prefs = Prefs { last_editor: Some("zed".into()) };
        prefs.save(&path).unwrap();
        assert_eq!(Prefs::load(&path), prefs);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
