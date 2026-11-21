//! loop's transcript (packages/core/src/transcript/types.ts) in Rust: a turn
//! is a user message and one assistant message whose parts are in the order
//! they happened. Views walk the parts; nothing is ever reordered.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    InputStreaming,
    InputAvailable,
    OutputAvailable,
    OutputError,
}

impl ToolState {
    pub fn is_running(self) -> bool {
        matches!(self, Self::InputStreaming | Self::InputAvailable)
    }
}

/// The run a `task` call started, drawn inside its tool row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubagentRun {
    pub agent: String,
    /// The tools it called, newest last.
    pub tools: Vec<String>,
    /// What it is doing right now, live only.
    pub current: Option<String>,
    pub finished: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolPart {
    pub call_id: String,
    pub name: String,
    pub state: ToolState,
    pub input: Value,
    /// Raw JSON of an input still streaming (a long `write`), live only.
    pub input_text: Option<String>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub subagent: Option<SubagentRun>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Compaction {
    pub running: bool,
    pub summary: Option<String>,
    pub tokens_before: Option<u64>,
    pub tokens_after: Option<u64>,
    pub error: Option<String>,
    pub aborted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text { text: String, streaming: bool },
    Reasoning { text: String, streaming: bool, duration_ms: Option<u64>, started_at: Option<u64> },
    Tool(Box<ToolPart>),
    Image { url: String },
    Compaction(Compaction),
    /// A note loop writes into the reply: a hook's message, a recap, a branch
    /// summary, a team brief.
    Note { label: &'static str, text: String },
    Retry { attempt: u64, max: u64, reason: String },
    Error(String),
}

impl Part {
    pub fn is_open(&self) -> bool {
        match self {
            Part::Text { streaming, .. } | Part::Reasoning { streaming, .. } => *streaming,
            Part::Tool(tool) => tool.state.is_running(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub parts: Vec<Part>,
    pub created_at: u64,
    pub interrupted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Todo {
    pub content: String,
    pub status: String,
    pub active_form: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transcript {
    pub messages: Vec<Message>,
    pub running: bool,
    pub todos: Vec<Todo>,
}

// ─── decoding the host's JSON ────────────────────────────────────────────────

pub fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_f64).map(|number| number.max(0.0) as u64)
}

fn streaming(value: &Value) -> bool {
    value.get("state").and_then(Value::as_str) == Some("streaming")
}

fn tool_state(text: &str) -> ToolState {
    match text {
        "input-streaming" => ToolState::InputStreaming,
        "input-available" => ToolState::InputAvailable,
        "output-error" => ToolState::OutputError,
        _ => ToolState::OutputAvailable,
    }
}

fn subagent_from_json(value: &Value) -> SubagentRun {
    let tools = value
        .get("steps")
        .and_then(Value::as_array)
        .map(|steps| steps.iter().filter(|step| step["type"] == "tool").filter_map(|step| str_field(step, "name")).collect())
        .unwrap_or_default();
    SubagentRun {
        agent: str_field(value, "agent").unwrap_or_else(|| "agent".into()),
        tools,
        current: str_field(value, "current"),
        finished: value.get("finished").and_then(Value::as_bool).unwrap_or(true),
    }
}

pub fn part_from_json(value: &Value) -> Option<Part> {
    let kind = value.get("type")?.as_str()?;
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let note = |label| str_field(&data, "text").or_else(|| str_field(&data, "summary")).map(|text| Part::Note { label, text });
    match kind {
        "text" => Some(Part::Text { text: str_field(value, "text")?, streaming: streaming(value) }),
        "reasoning" => Some(Part::Reasoning {
            text: str_field(value, "text").unwrap_or_default(),
            streaming: streaming(value),
            duration_ms: u64_field(value, "durationMs"),
            started_at: u64_field(value, "startedAt"),
        }),
        "file" => Some(Part::Image { url: str_field(value, "url")? }),
        "data-compaction" => Some(Part::Compaction(Compaction {
            running: data["running"].as_bool().unwrap_or(false),
            summary: str_field(&data, "summary"),
            tokens_before: u64_field(&data, "tokensBefore"),
            tokens_after: u64_field(&data, "tokensAfter"),
            error: str_field(&data, "error"),
            aborted: data["aborted"].as_bool().unwrap_or(false),
        })),
        "data-recap" => note("Recap"),
        "data-hook" => note("Hook"),
        "data-branch-summary" => note("Branch summary"),
        "data-team" => note("Team"),
        "data-retry" => Some(Part::Retry {
            attempt: u64_field(&data, "attempt").unwrap_or(0),
            max: u64_field(&data, "max").unwrap_or(0),
            reason: str_field(&data, "reason").unwrap_or_default(),
        }),
        "data-error" => Some(Part::Error(str_field(&data, "message").unwrap_or_default())),
        tool if tool.starts_with("tool-") => Some(Part::Tool(Box::new(ToolPart {
            call_id: str_field(value, "toolCallId")?,
            name: str_field(value, "toolName").unwrap_or_else(|| tool["tool-".len()..].to_string()),
            state: tool_state(value.get("state").and_then(Value::as_str).unwrap_or("")),
            input: value.get("input").cloned().unwrap_or(Value::Null),
            input_text: str_field(value, "inputText"),
            output: value.get("output").cloned(),
            error: str_field(value, "errorText"),
            subagent: value.get("subagent").map(subagent_from_json),
        }))),
        _ => None,
    }
}

pub fn message_from_json(value: &Value) -> Option<Message> {
    let role = match value.get("role")?.as_str()? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => Role::System,
    };
    let metadata = value.get("metadata").cloned().unwrap_or(Value::Null);
    Some(Message {
        id: str_field(value, "id")?,
        role,
        parts: value.get("parts")?.as_array()?.iter().filter_map(part_from_json).collect(),
        created_at: u64_field(&metadata, "createdAt").unwrap_or(0),
        interrupted: metadata["interrupted"].as_bool().unwrap_or(false),
    })
}

pub fn todos_from_json(value: &Value) -> Vec<Todo> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(Todo {
                        content: str_field(item, "content")?,
                        status: str_field(item, "status").unwrap_or_default(),
                        active_form: str_field(item, "activeForm"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_saved_turn_decodes_in_order() {
        let message = message_from_json(&json!({
            "id": "m1", "role": "assistant", "metadata": { "createdAt": 5 },
            "parts": [
                { "type": "reasoning", "text": "hmm", "state": "done", "durationMs": 1200 },
                { "type": "text", "text": "Hello", "state": "done" },
                { "type": "tool-bash", "toolCallId": "c1", "toolName": "bash",
                  "state": "output-available", "input": { "command": "ls" }, "output": "a\nb" },
                { "type": "data-unknown-to-us", "data": {} }
            ]
        }))
        .unwrap();
        assert_eq!(message.parts.len(), 3);
        assert!(matches!(&message.parts[0], Part::Reasoning { duration_ms: Some(1200), .. }));
        let Part::Tool(tool) = &message.parts[2] else { panic!("not a tool") };
        assert_eq!((tool.name.as_str(), tool.state), ("bash", ToolState::OutputAvailable));
    }
}
