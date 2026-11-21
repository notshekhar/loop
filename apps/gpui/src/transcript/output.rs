//! The lines a tool row shows under its header — loop's LoopToolRow rules:
//! a write as its added lines, a replayed edit as the diff its arguments
//! describe, and a read numbered from the file's own line numbers.

use serde_json::Value;

use super::tools::output_text;
use super::{ToolPart, ToolState};

/// A row shows this many lines until it is opened.
pub const COLLAPSED_LINES: usize = 6;
/// A tool whose input is still arriving shows its last few lines.
pub const LIVE_TAIL_LINES: usize = 3;

pub fn output_lines(tool: &ToolPart) -> Vec<String> {
    let output = output_text(tool);
    write_additions(tool, &output)
        .or_else(|| edit_replay_diff(tool, &output))
        .unwrap_or_else(|| if output.is_empty() { Vec::new() } else { output.split('\n').map(str::to_string).collect() })
}

/// Whether `+`/`-` lines are diff lines to colour.
pub fn is_diff(tool: &ToolPart) -> bool {
    tool.state != ToolState::OutputError && matches!(tool.name.as_str(), "edit" | "write")
}

fn settled(tool: &ToolPart) -> bool {
    tool.state == ToolState::OutputAvailable
}

/// A new file's content as additions — the output only says it was written.
fn write_additions(tool: &ToolPart, output: &str) -> Option<Vec<String>> {
    if tool.name != "write" || !settled(tool) || output.is_empty() || output.contains("\n+") || output.ends_with("(content unchanged)") {
        return None;
    }
    let content = tool.input.get("content").and_then(Value::as_str).filter(|content| !content.is_empty())?;
    let lines: Vec<&str> = content.split('\n').collect();
    let width = lines.len().to_string().len();
    Some(lines.iter().enumerate().map(|(ix, line)| format!("+{:>width$} {line}", ix + 1)).collect())
}

/// A replayed edit keeps only its arguments; they are the diff.
fn edit_replay_diff(tool: &ToolPart, output: &str) -> Option<Vec<String>> {
    if tool.name != "edit" || !settled(tool) || output.is_empty() || output.lines().any(|line| line.starts_with(['+', '-'])) {
        return None;
    }
    let mut lines = vec![output.to_string()];
    for edit in tool.input.get("edits")?.as_array()? {
        let (old, new) = (edit.get("oldText")?.as_str()?, edit.get("newText")?.as_str()?);
        lines.extend(old.split('\n').map(|line| format!("-{line}")));
        lines.extend(new.split('\n').map(|line| format!("+{line}")));
    }
    (lines.len() > 1).then_some(lines)
}

/// A `[…]` line is one of read's notices, never file content.
fn is_read_notice(line: &str) -> bool {
    let line = line.trim();
    line.starts_with('[') && line.ends_with(']')
}

/// Line numbers for a read's output, starting at its offset; notices get
/// none. Empty for every other tool.
pub fn gutters(tool: &ToolPart, lines: &[String]) -> Vec<String> {
    if tool.name != "read" || tool.state == ToolState::OutputError || lines.is_empty() {
        return Vec::new();
    }
    if lines.len() == 1 && is_read_notice(&lines[0]) {
        return vec![String::new()];
    }
    let base = tool.input.get("offset").and_then(Value::as_u64).unwrap_or(1);
    let mut body_end = lines.len();
    if body_end >= 2 && is_read_notice(&lines[body_end - 1]) && lines[body_end - 2].trim().is_empty() {
        body_end -= 2;
    }
    let width = (base + body_end.saturating_sub(1) as u64).to_string().len();
    (0..lines.len()).map(|ix| if ix < body_end { format!("{:>width$}", base + ix as u64) } else { String::new() }).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn tool(name: &str, input: Value, output: &str) -> ToolPart {
        ToolPart {
            call_id: "c".into(),
            name: name.into(),
            state: ToolState::OutputAvailable,
            input,
            input_text: None,
            output: Some(Value::String(output.into())),
            error: None,
            subagent: None,
        }
    }

    #[test]
    fn a_write_shows_its_content_as_numbered_additions() {
        let write = tool("write", json!({ "content": "a\nb" }), "Wrote 2 lines");
        assert_eq!(output_lines(&write), ["+1 a", "+2 b"]);
        let live = tool("write", json!({ "content": "a" }), "Wrote\n+1 a");
        assert_eq!(output_lines(&live), ["Wrote", "+1 a"]);
    }

    #[test]
    fn a_replayed_edit_rebuilds_its_diff() {
        let edit = tool("edit", json!({ "edits": [{ "oldText": "x", "newText": "y\nz" }] }), "Edited f.rs");
        assert_eq!(output_lines(&edit), ["Edited f.rs", "-x", "+y", "+z"]);
    }

    #[test]
    fn a_read_is_numbered_from_its_offset_and_skips_the_notice() {
        let read = tool("read", json!({ "offset": 9 }), "");
        let lines: Vec<String> = ["a", "b", "", "[3 more lines]"].map(String::from).to_vec();
        assert_eq!(gutters(&read, &lines), [" 9", "10", "", ""]);
    }
}
