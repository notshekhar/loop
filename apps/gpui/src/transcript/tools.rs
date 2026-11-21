//! How tool calls read: one call as `read src/app.ts:120-180`, a run of
//! finished calls as `Read 2 files, Ran 1 command`. Ports of loop's
//! apps/web loopToolSummary.ts and loopVerbGroup.ts (themselves ports of the
//! CLI's tool-summary.ts / verb-group.ts) — every surface must agree.

use serde_json::Value;

use super::model::{Part, ToolPart, ToolState};

/// A kind's grammar: a past-tense verb plus a singular/plural noun.
struct Kind {
    past: &'static str,
    one: &'static str,
    many: &'static str,
    /// Whether a run of these collapses into a header; plans stay readable.
    folds: bool,
}

const fn kind(past: &'static str, one: &'static str, many: &'static str) -> Kind {
    Kind { past, one, many, folds: true }
}

const FILE: Kind = kind("Read", "file", "files");
const SKILL: Kind = kind("Read", "skill", "skills");
const DIR: Kind = kind("Listed", "dir", "dirs");
const SEARCH: Kind = kind("Searched", "pattern", "patterns");
const WEB: Kind = kind("Fetched", "website", "websites");
const MEMORY: Kind = kind("Searched", "memory", "memories");
const SUBAGENT: Kind = kind("Ran", "subagent", "subagents");
const TODO: Kind = kind("Updated", "todo list", "todo lists");
const DATA: Kind = kind("Queried", "datasource", "datasources");
const ARTIFACT: Kind = kind("Created", "artifact", "artifacts");
const COMMAND: Kind = kind("Ran", "command", "commands");
const SHELL: Kind = kind("Checked", "shell", "shells");
const MCP: Kind = kind("Called", "MCP tool", "MCP tools");
const EXTENSION: Kind = kind("Called", "extension tool", "extension tools");
const EDIT: Kind = kind("Edited", "file", "files");
const ASK: Kind = kind("Asked", "question", "questions");
const PLAN: Kind = Kind { folds: false, ..kind("Planned", "plan", "plans") };
const SPAWN: Kind = Kind { folds: false, ..kind("Started", "thread team", "thread teams") };
const WAIT: Kind = Kind { folds: false, ..kind("Waited for", "the team", "the team") };
const REPORT: Kind = Kind { folds: false, ..kind("Reported", "to the lead", "to the lead") };
const MESSAGE: Kind = kind("Messaged", "teammate", "teammates");
const BOARD: Kind = kind("Updated", "team board", "team board");

fn kind_of(tool: &str) -> &'static Kind {
    match tool {
        "read" => &FILE,
        "skill" => &SKILL,
        "ls" | "tree" => &DIR,
        "glob" | "grep" | "find" | "websearch" => &SEARCH,
        "webfetch" => &WEB,
        "memory" => &MEMORY,
        "task" => &SUBAGENT,
        "todo" => &TODO,
        "bash" => &COMMAND,
        "shells" => &SHELL,
        "edit" | "write" => &EDIT,
        "sql" => &DATA,
        "artifact" => &ARTIFACT,
        "ask" => &ASK,
        "plan" | "enter_plan_mode" | "exit_plan_mode" => &PLAN,
        "spawn_threads" => &SPAWN,
        "wait_for_team" => &WAIT,
        "report" => &REPORT,
        "send_message" => &MESSAGE,
        "team_board" => &BOARD,
        // MCP tools arrive namespaced as `server__tool`.
        name if name.contains("__") => &MCP,
        _ => &EXTENSION,
    }
}

const ROW_LIMIT: usize = 80;

fn clamp(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > ROW_LIMIT {
        format!("{}…", flat.chars().take(ROW_LIMIT - 3).collect::<String>())
    } else {
        flat
    }
}

/// An absolute path under `cwd` as a repo-relative one (`.` for cwd itself).
fn relative(value: &Value, cwd: &str) -> String {
    let Some(path) = value.as_str() else { return String::new() };
    match path.strip_prefix(cwd) {
        Some(rest) => {
            let rest = rest.trim_start_matches('/');
            if rest.is_empty() { ".".into() } else { rest.into() }
        }
        None => path.into(),
    }
}

fn text<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `read`'s `:start` / `:start-end` line range from offset/limit.
fn read_range(args: &Value) -> String {
    let offset = args.get("offset").and_then(Value::as_u64);
    let limit = args.get("limit").and_then(Value::as_u64);
    match (offset, limit) {
        (None, None) => String::new(),
        (offset, Some(limit)) => {
            let start = offset.unwrap_or(1);
            format!(":{start}-{}", start + limit - 1)
        }
        (Some(start), None) => format!(":{start}"),
    }
}

/// Arguments an unknown tool most likely describes itself with, best first.
const DESCRIPTIVE_KEYS: [&str; 15] = [
    "path", "file_path", "filePath", "file", "command", "cmd", "query", "pattern", "url", "name",
    "title", "id", "prompt", "message", "text",
];

fn describe_unknown(args: &Value, cwd: &str) -> String {
    if let Some(value) = DESCRIPTIVE_KEYS.iter().filter_map(|key| args.get(*key)).find(|value| value.as_str().is_some_and(|text| !text.trim().is_empty())) {
        return clamp(&relative(value, cwd));
    }
    let Some(object) = args.as_object() else { return String::new() };
    let scalars: Vec<String> = object
        .iter()
        .filter_map(|(key, value)| match value {
            Value::String(text) => Some(format!("{key}={text}")),
            Value::Number(number) => Some(format!("{key}={number}")),
            Value::Bool(flag) => Some(format!("{key}={flag}")),
            _ => None,
        })
        .collect();
    if !scalars.is_empty() && scalars.len() == object.len() {
        return clamp(&scalars.join(" "));
    }
    clamp(&args.to_string())
}

/// The one-line argument summary for a call; empty when its input has not
/// arrived yet.
pub fn summary(tool: &ToolPart, cwd: &str) -> String {
    args_summary(&tool.name, &tool.input, cwd)
}

/// A call's one-line detail from its name and arguments alone — what the
/// session tree has for a call (loop's formatToolArgs).
pub fn args_summary(name: &str, args: &Value, cwd: &str) -> String {
    if args.as_object().is_none_or(|object| object.is_empty()) {
        return String::new();
    }
    match name {
        "read" => format!("{}{}", relative(path_arg(args), cwd), read_range(args)),
        "write" | "edit" | "ls" => relative(path_arg(args), cwd),
        "bash" => clamp(text(args, "command").lines().next().unwrap_or("")),
        "grep" => {
            let path = relative(&args["path"], cwd);
            let pattern = text(args, "pattern");
            if path.is_empty() { pattern.into() } else { format!("{pattern} in {path}") }
        }
        "find" => text(args, "pattern").into(),
        "websearch" => text(args, "query").into(),
        "skill" => text(args, "name").into(),
        "task" => {
            let agent = args.get("agent").and_then(Value::as_str).unwrap_or("default");
            let prompt: String = text(args, "prompt").lines().next().unwrap_or("").chars().take(60).collect();
            if prompt.is_empty() { agent.into() } else { format!("{agent}: {prompt}") }
        }
        "plan" => clamp(text(args, "plan").lines().next().unwrap_or("").trim_start_matches('#').trim()),
        _ => describe_unknown(args, cwd),
    }
}

fn path_arg(args: &Value) -> &Value {
    ["path", "file_path", "filePath"].iter().map(|key| &args[*key]).find(|value| value.is_string()).unwrap_or(&Value::Null)
}

/// One item of a reply as it is drawn: a part on its own, or a run of
/// finished tool calls folded under one header.
#[derive(Debug, PartialEq)]
pub enum Block<'a> {
    Part(&'a Part),
    ToolRun { label: String, failed: usize, tools: Vec<&'a ToolPart> },
}

/// A call that may fold: finished, and of a kind that folds. A running call
/// is the row worth watching, so it never groups.
fn foldable(tool: &ToolPart) -> bool {
    !tool.state.is_running() && kind_of(&tool.name).folds
}

/// `Read 2 files, Ran 1 command`: one segment per kind, first-seen order.
fn run_label(tools: &[&ToolPart]) -> String {
    let mut segments: Vec<(&'static Kind, usize)> = Vec::new();
    for tool in tools {
        let kind = kind_of(&tool.name);
        match segments.iter_mut().find(|(seen, _)| std::ptr::eq(*seen, kind)) {
            Some((_, count)) => *count += 1,
            None => segments.push((kind, 1)),
        }
    }
    segments
        .iter()
        .map(|(kind, count)| format!("{} {count} {}", kind.past, if *count == 1 { kind.one } else { kind.many }))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Fold a reply's parts into blocks, in order. Anything that is not a
/// foldable call breaks a run.
pub fn blocks(parts: &[Part]) -> Vec<Block<'_>> {
    let mut blocks = Vec::new();
    let mut run: Vec<&ToolPart> = Vec::new();
    for part in parts {
        match part {
            Part::Tool(tool) if foldable(tool) => run.push(tool),
            _ => {
                close_run(&mut run, &mut blocks);
                blocks.push(Block::Part(part));
            }
        }
    }
    close_run(&mut run, &mut blocks);
    blocks
}

fn close_run<'a>(run: &mut Vec<&'a ToolPart>, blocks: &mut Vec<Block<'a>>) {
    if run.is_empty() {
        return;
    }
    let failed = run.iter().filter(|tool| tool.state == ToolState::OutputError).count();
    blocks.push(Block::ToolRun { label: run_label(run), failed, tools: std::mem::take(run) });
}

/// A tool's output as plain text for its expanded body.
pub fn output_text(tool: &ToolPart) -> String {
    if let Some(error) = &tool.error {
        return error.clone();
    }
    match &tool.output {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other
            .get("content")
            .and_then(Value::as_array)
            .map(|content| content.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n"))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| serde_json::to_string_pretty(other).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str, state: ToolState, input: Value) -> Part {
        Part::Tool(Box::new(ToolPart {
            call_id: name.into(),
            name: name.into(),
            state,
            input,
            input_text: None,
            output: None,
            error: None,
            subagent: None,
        }))
    }

    #[test]
    fn summaries_match_the_terminal() {
        let Part::Tool(read) = tool("read", ToolState::OutputAvailable, json!({ "path": "/repo/src/a.ts", "offset": 120, "limit": 61 })) else { unreachable!() };
        assert_eq!(summary(&read, "/repo"), "src/a.ts:120-180");
        let Part::Tool(grep) = tool("grep", ToolState::OutputAvailable, json!({ "pattern": "foo", "path": "/repo/src" })) else { unreachable!() };
        assert_eq!(summary(&grep, "/repo"), "foo in src");
        let Part::Tool(mcp) = tool("gh__search", ToolState::OutputAvailable, json!({ "limit": 3, "draft": true })) else { unreachable!() };
        assert_eq!(summary(&mcp, "/repo"), "limit=3 draft=true");
    }

    #[test]
    fn finished_calls_fold_and_running_ones_stand_alone() {
        let parts = vec![
            tool("read", ToolState::OutputAvailable, json!({})),
            tool("grep", ToolState::OutputAvailable, json!({})),
            tool("read", ToolState::OutputError, json!({})),
            Part::Text { text: "x".into(), streaming: false },
            tool("bash", ToolState::InputAvailable, json!({})),
            tool("plan", ToolState::OutputAvailable, json!({})),
        ];
        let blocks = blocks(&parts);
        assert_eq!(blocks.len(), 4);
        let Block::ToolRun { label, failed, .. } = &blocks[0] else { panic!("not a run") };
        assert_eq!((label.as_str(), *failed), ("Read 2 files, Searched 1 pattern", 1));
        assert!(matches!(blocks[2], Block::Part(Part::Tool(_))));
        assert!(matches!(blocks[3], Block::Part(Part::Tool(_))));
    }
}
