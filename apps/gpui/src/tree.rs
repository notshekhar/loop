//! A session as a tree (`session.tree`) and the rules for showing it — a
//! port of loop's SessionTree.logic.ts and SessionTreeDialog's row summary.

use std::collections::{BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::Value;

use crate::transcript::tools::args_summary;

#[derive(Debug, Clone, Deserialize)]
pub struct TreeTool {
    pub name: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeRow {
    pub id: String,
    pub ts: u64,
    /// `message`, `compact`, `branch-summary`, `session-info`, …
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub tools: Vec<TreeTool>,
    #[serde(default)]
    pub label: Option<String>,
    /// How far to indent — where the tree forks, not its depth.
    pub indent: usize,
    #[serde(default)]
    pub branch_start: bool,
    /// On the path from the root to the current leaf.
    #[serde(default)]
    pub on_path: bool,
    #[serde(default)]
    pub child_count: usize,
    #[serde(default)]
    pub interrupted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeView {
    pub rows: Vec<TreeRow>,
    #[serde(default)]
    pub leaf_id: Option<String>,
    #[serde(default)]
    pub branch_point_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Default,
    Prompts,
    NoTools,
    All,
}

impl FilterMode {
    pub const ALL: [FilterMode; 4] = [FilterMode::Default, FilterMode::Prompts, FilterMode::NoTools, FilterMode::All];

    pub fn label(self) -> &'static str {
        match self {
            FilterMode::Default => "Default",
            FilterMode::Prompts => "Prompts",
            FilterMode::NoTools => "No tools",
            FilterMode::All => "All",
        }
    }

    pub fn hint(self) -> &'static str {
        match self {
            FilterMode::Default => "Messages and the calls they made",
            FilterMode::Prompts => "Only what you asked",
            FilterMode::NoTools => "Messages only",
            FilterMode::All => "Every entry, bookkeeping included",
        }
    }
}

/// Entry types that are bookkeeping rather than conversation.
fn is_bookkeeping(row: &TreeRow) -> bool {
    matches!(row.kind.as_str(), "session-info" | "label" | "session-name")
}

fn matches_mode(row: &TreeRow, mode: FilterMode) -> bool {
    match mode {
        FilterMode::All => true,
        _ if is_bookkeeping(row) => false,
        FilterMode::Prompts => row.role.as_deref() == Some("user"),
        FilterMode::NoTools => row.role.as_deref() != Some("tool"),
        FilterMode::Default => true,
    }
}

/// Everything a row could be searched by, lowercased.
fn search_text(row: &TreeRow) -> String {
    let mut parts = vec![row.text.clone().unwrap_or_default(), row.label.clone().unwrap_or_default(), row.role.clone().unwrap_or_default(), row.kind.clone()];
    for tool in &row.tools {
        parts.push(tool.name.clone());
        parts.push(match &tool.input {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        });
    }
    parts.join(" ").to_lowercase()
}

/// The rows to draw. The leaf always stays; indents are renumbered 0, 1,
/// 2… over the ones left, so hidden rows don't leave gaps in the nesting.
pub fn filter_rows(view: &TreeView, mode: FilterMode, query: &str) -> Vec<TreeRow> {
    let query = query.trim().to_lowercase();
    let kept: Vec<&TreeRow> = view
        .rows
        .iter()
        .filter(|row| view.leaf_id.as_deref() == Some(row.id.as_str()) || (matches_mode(row, mode) && (query.is_empty() || search_text(row).contains(&query))))
        .collect();
    let levels: BTreeSet<usize> = kept.iter().map(|row| row.indent).collect();
    let rank: HashMap<usize, usize> = levels.into_iter().enumerate().map(|(rank, level)| (level, rank)).collect();
    kept.into_iter().map(|row| TreeRow { indent: rank[&row.indent], ..row.clone() }).collect()
}

/// A row's one line: its text, else the calls it made.
pub fn row_summary(row: &TreeRow, cwd: &str) -> String {
    match row.kind.as_str() {
        "compact" => return "context compacted".into(),
        "branch-summary" => return "branch summary".into(),
        _ => {}
    }
    if let Some(text) = row.text.as_deref().filter(|text| !text.is_empty()) {
        return format!("{text}{}", if row.truncated { "…" } else { "" });
    }
    if !row.tools.is_empty() {
        return row
            .tools
            .iter()
            .map(|tool| {
                let detail = args_summary(&tool.name, &tool.input, cwd);
                if detail.is_empty() { tool.name.clone() } else { format!("{} {detail}", tool.name) }
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    match row.kind.as_str() {
        "message" if row.interrupted => "(cut off)".into(),
        "message" => "(no output)".into(),
        other => other.into(),
    }
}

/// `2 branch points · 48 entries`.
pub fn tree_summary(view: &TreeView) -> String {
    let entries = view.rows.iter().filter(|row| !is_bookkeeping(row)).count();
    let mut summary = format!("{entries} {}", if entries == 1 { "entry" } else { "entries" });
    let points = view.branch_point_ids.len();
    if points > 0 {
        summary = format!("{points} {} · {summary}", if points == 1 { "branch point" } else { "branch points" });
    }
    summary
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn view() -> TreeView {
        serde_json::from_value(json!({
            "leafId": "c",
            "branchPointIds": ["a"],
            "rows": [
                { "id": "i", "ts": 0, "type": "session-info", "indent": 0 },
                { "id": "a", "ts": 1, "type": "message", "role": "user", "text": "fix login", "indent": 0, "onPath": true, "childCount": 2 },
                { "id": "b", "ts": 2, "type": "message", "role": "tool", "tools": [{ "name": "grep", "input": { "pattern": "login" } }], "indent": 3 },
                { "id": "c", "ts": 3, "type": "message", "role": "assistant", "text": "done", "indent": 5, "onPath": true }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn filters_follow_loops_modes_and_the_leaf_always_stays() {
        let view = view();
        let ids = |rows: Vec<TreeRow>| rows.into_iter().map(|row| row.id).collect::<Vec<_>>();
        assert_eq!(ids(filter_rows(&view, FilterMode::Default, "")), ["a", "b", "c"]);
        assert_eq!(ids(filter_rows(&view, FilterMode::Prompts, "")), ["a", "c"]);
        assert_eq!(ids(filter_rows(&view, FilterMode::NoTools, "")), ["a", "c"]);
        assert_eq!(ids(filter_rows(&view, FilterMode::All, "")), ["i", "a", "b", "c"]);
        assert_eq!(ids(filter_rows(&view, FilterMode::Default, "LOGIN")), ["a", "b", "c"]);
    }

    #[test]
    fn indents_are_renumbered_over_what_is_left() {
        let indents: Vec<usize> = filter_rows(&view(), FilterMode::Prompts, "").into_iter().map(|row| row.indent).collect();
        assert_eq!(indents, [0, 1]);
    }

    #[test]
    fn rows_and_the_tree_summarise_like_loop() {
        let view = view();
        assert_eq!(row_summary(&view.rows[2], "/"), "grep login");
        assert_eq!(tree_summary(&view), "1 branch point · 3 entries");
    }
}
