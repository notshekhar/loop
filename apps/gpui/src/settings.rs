//! The few of loop's settings the app shows but never writes: they are read
//! from `~/.loop/settings.json` once, because `loop rpc` only serves its
//! boolean settings.

use std::path::PathBuf;

use serde::Deserialize;

use crate::catalog::THINKING_LEVELS;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    thinking_level: Option<String>,
    agent: Option<String>,
}

/// What a new turn runs with when the composer leaves a choice alone.
#[derive(Clone, Default)]
pub struct Defaults {
    pub thinking: Option<&'static str>,
    pub agent: Option<String>,
}

fn settings_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".loop").join("settings.json"))
}

pub fn load_defaults() -> Defaults {
    let file: File = settings_path()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    parse(file)
}

fn parse(file: File) -> Defaults {
    let thinking = file.thinking_level.and_then(|level| THINKING_LEVELS.iter().copied().find(|known| *known == level));
    Defaults { thinking, agent: file.agent.filter(|agent| !agent.is_empty()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_levels_fall_back_to_none() {
        let defaults = parse(serde_json::from_str(r#"{"thinkingLevel":"medium","agent":"plan"}"#).unwrap());
        assert_eq!(defaults.thinking, Some("medium"));
        assert_eq!(defaults.agent.as_deref(), Some("plan"));
        let defaults = parse(serde_json::from_str(r#"{"thinkingLevel":"turbo","agent":""}"#).unwrap());
        assert_eq!(defaults.thinking, None);
        assert_eq!(defaults.agent, None);
    }
}
