//! Applying one live event to a transcript — a port of
//! packages/core/src/transcript/reduce.ts `applyEvent`, so a reply reads the
//! same while it streams as after it is saved. Text runs on into the open text
//! block; anything else closes it and starts the next block below.

use serde_json::Value;

use super::model::{
    Compaction, Message, Part, Role, SubagentRun, ToolPart, ToolState, Transcript, str_field,
    todos_from_json, u64_field,
};

/// What a call cut off by the end of its turn says instead of a result.
pub const INTERRUPTED: &str = "Interrupted";

/// Events that are a reply being written, as opposed to what trails one.
const REPLY_CONTENT: [&str; 7] = [
    "text-delta",
    "reasoning-start",
    "reasoning-delta",
    "tool-input-start",
    "tool-call",
    "hook-message",
    "compact-start",
];

/// Apply one event. `at` is when it was observed (epoch ms), used only for
/// durations, never for order.
pub fn apply_event(transcript: &mut Transcript, kind: &str, data: &Value, at: u64) {
    if is_idle_compaction(kind, data) {
        transcript.messages.push(idle_compaction_marker(at));
        return;
    }
    if kind == "compact-end" && finish_idle_compaction(transcript, data) {
        return;
    }
    // A reply arriving with no turn running is a NEW turn whose prompt this
    // stream never carried: running it into the last reply would weld two
    // answers into one paragraph.
    if REPLY_CONTENT.contains(&kind) && !transcript.running {
        if transcript.messages.last().is_some_and(|last| last.role == Role::Assistant) {
            transcript.messages.push(empty_reply(format!("reply-{at}"), at));
        }
        transcript.running = true;
    }
    match kind {
        "user-message" => push_user_message(transcript, data, at),
        "attached-images" => attach_images(transcript, data),
        "session-running" => set_running(transcript, data["running"] == true, at),
        "text-delta" => {
            let Some(text) = data.as_str().filter(|text| !text.is_empty()) else { return };
            let parts = reply(transcript, at);
            if matches!(parts.last(), Some(Part::Reasoning { streaming: true, .. })) {
                close_open_block(parts, at);
            }
            append_text(parts, text);
        }
        "reasoning-start" => {
            let parts = reply(transcript, at);
            close_open_block(parts, at);
            parts.push(reasoning("", at));
        }
        "reasoning-delta" => {
            let Some(text) = data.as_str().filter(|text| !text.is_empty()) else { return };
            let parts = reply(transcript, at);
            if let Some(Part::Reasoning { text: open, streaming: true, .. }) = parts.last_mut() {
                open.push_str(text);
            } else {
                close_open_block(parts, at);
                parts.push(reasoning(text, at));
            }
        }
        "reasoning-end" => {
            let parts = reply(transcript, at);
            if matches!(parts.last(), Some(Part::Reasoning { .. })) {
                close_open_block(parts, at);
            }
        }
        "tool-input-start" => {
            let Some(call_id) = str_field(data, "toolCallId") else { return };
            ensure_tool(reply(transcript, at), &call_id, &tool_name(data, "tool"), at);
        }
        "tool-input-delta" => {
            let (Some(call_id), Some(delta)) = (str_field(data, "toolCallId"), str_field(data, "delta")) else { return };
            if let Some(tool) = find_tool(reply(transcript, at), &call_id) {
                tool.input_text.get_or_insert_default().push_str(&delta);
            }
        }
        "tool-call" | "tool-input-updated" => {
            let Some(call_id) = str_field(data, "toolCallId") else { return };
            let parts = reply(transcript, at);
            let tool = ensure_tool(parts, &call_id, &tool_name(data, "tool"), at);
            if let Some(input) = data.get("input") {
                tool.input = input.clone();
            }
            if tool.state == ToolState::InputStreaming {
                tool.state = ToolState::InputAvailable;
            }
        }
        "tool-result" | "tool-error" => {
            let Some(call_id) = str_field(data, "toolCallId") else { return };
            let parts = reply(transcript, at);
            let tool = ensure_tool(parts, &call_id, &tool_name(data, "tool"), at);
            finish_tool(tool, kind == "tool-error", data);
        }
        "subagent-tool" | "subagent-finish" => {
            let Some(call_id) = str_field(data, "toolCallId") else { return };
            let tool = ensure_tool(reply(transcript, at), &call_id, "task", at);
            let run = tool.subagent.get_or_insert_with(|| SubagentRun {
                agent: str_field(data, "agent").unwrap_or_else(|| "agent".into()),
                ..SubagentRun::default()
            });
            if kind == "subagent-tool" {
                let name = tool_name(data, "tool");
                run.current = Some(name.clone());
                run.tools.push(name);
            } else {
                run.current = Some("finishing".into());
            }
        }
        "hook-message" => push_note(transcript, "Hook", data.as_str().unwrap_or_default(), at),
        "data-recap" => push_note(transcript, "Recap", &str_field(data, "text").unwrap_or_default(), at),
        "compact-start" => {
            let parts = reply(transcript, at);
            close_open_block(parts, at);
            parts.push(Part::Compaction(running_compaction()));
        }
        "compact-end" => end_compaction(reply(transcript, at), data),
        "stream-retry" => {
            let parts = reply(transcript, at);
            close_open_block(parts, at);
            parts.push(Part::Retry {
                attempt: u64_field(data, "attempt").unwrap_or(0),
                max: u64_field(data, "max").unwrap_or(0),
                reason: str_field(data, "reason").unwrap_or_default(),
            });
        }
        "todo-update" => transcript.todos = todos_from_json(&data["items"]),
        "error" => {
            let parts = reply(transcript, at);
            close_open_block(parts, at);
            parts.push(Part::Error(error_text(data)));
        }
        "finish" => settle(reply(transcript, at), at),
        // Usage, terminal sequences, list news: nothing a reply shows.
        _ => {}
    }
}

fn empty_reply(id: String, at: u64) -> Message {
    Message { id, role: Role::Assistant, parts: Vec::new(), created_at: at, interrupted: false }
}

/// The current assistant reply's parts: the reply after the last prompt,
/// created when there is none yet.
fn reply(transcript: &mut Transcript, at: u64) -> &mut Vec<Part> {
    let needs_reply = transcript.messages.last().is_none_or(|last| last.role != Role::Assistant);
    if needs_reply {
        let id = match transcript.messages.last() {
            Some(last) if last.role == Role::User => format!("{}:reply", last.id),
            _ => format!("reply-{at}"),
        };
        transcript.messages.push(empty_reply(id, at));
    }
    &mut transcript.messages.last_mut().expect("a reply was just ensured").parts
}

fn reasoning(text: &str, at: u64) -> Part {
    Part::Reasoning { text: text.to_string(), streaming: true, duration_ms: None, started_at: Some(at) }
}

fn tool_name(data: &Value, fallback: &str) -> String {
    str_field(data, "toolName").unwrap_or_else(|| fallback.to_string())
}

/// Close an open text or reasoning block: something else is starting below it.
fn close_open_block(parts: &mut [Part], at: u64) {
    match parts.last_mut() {
        Some(Part::Text { streaming, .. }) => *streaming = false,
        Some(Part::Reasoning { streaming, duration_ms, started_at, .. }) if *streaming => {
            *streaming = false;
            if duration_ms.is_none() {
                *duration_ms = started_at.map(|start| at.saturating_sub(start));
            }
        }
        _ => {}
    }
}

fn append_text(parts: &mut Vec<Part>, text: &str) {
    if let Some(Part::Text { text: open, streaming }) = parts.last_mut() {
        open.push_str(text);
        *streaming = true;
    } else {
        parts.push(Part::Text { text: text.to_string(), streaming: true });
    }
}

fn find_tool<'a>(parts: &'a mut [Part], call_id: &str) -> Option<&'a mut ToolPart> {
    parts.iter_mut().rev().find_map(|part| match part {
        Part::Tool(tool) if tool.call_id == call_id => Some(tool.as_mut()),
        _ => None,
    })
}

/// The tool part for `call_id`, created (input still to come) if it is new.
fn ensure_tool<'a>(parts: &'a mut Vec<Part>, call_id: &str, name: &str, at: u64) -> &'a mut ToolPart {
    let exists = parts.iter().any(|part| matches!(part, Part::Tool(tool) if tool.call_id == call_id));
    if !exists {
        close_open_block(parts, at);
        parts.push(Part::Tool(Box::new(ToolPart {
            call_id: call_id.to_string(),
            name: name.to_string(),
            state: ToolState::InputStreaming,
            input: Value::Null,
            input_text: None,
            output: None,
            error: None,
            subagent: None,
        })));
    }
    find_tool(parts, call_id).expect("the tool was just ensured")
}

fn finish_tool(tool: &mut ToolPart, failed: bool, data: &Value) {
    tool.input_text = None;
    let failure = if failed { Some(error_text(&data["error"])) } else { result_failure(&data["output"]) };
    match failure {
        Some(error) => {
            tool.state = ToolState::OutputError;
            tool.error = Some(error);
        }
        None => {
            tool.state = ToolState::OutputAvailable;
            tool.output = data.get("output").cloned();
        }
    }
    if let Some(run) = &mut tool.subagent {
        run.finished = true;
        run.current = None;
    }
}

/// MCP-style tools report failure as `{ content, isError: true }` rather
/// than throwing; that is still a failed call.
fn result_failure(output: &Value) -> Option<String> {
    if output.get("isError") != Some(&Value::Bool(true)) {
        return None;
    }
    let text: String = output["content"]
        .as_array()
        .map(|content| content.iter().filter_map(|part| part["text"].as_str()).collect())
        .unwrap_or_default();
    Some(if text.trim().is_empty() { "Failed".into() } else { text.trim().to_string() })
}

fn error_text(error: &Value) -> String {
    match error {
        Value::String(text) => text.clone(),
        Value::Object(_) if error.get("message").is_some() => error["message"].as_str().map_or_else(|| error["message"].to_string(), str::to_string),
        Value::Null => "Unknown error".into(),
        other => other.to_string(),
    }
}

/// Everything still open is finished: the turn is over, however it ended.
fn settle(parts: &mut [Part], at: u64) {
    for part in parts.iter_mut() {
        match part {
            Part::Text { streaming, .. } => *streaming = false,
            Part::Reasoning { streaming, duration_ms, started_at, .. } if *streaming => {
                *streaming = false;
                if duration_ms.is_none() {
                    *duration_ms = started_at.map(|start| at.saturating_sub(start));
                }
            }
            // A call with no result when its turn ends never got one: it
            // was cut off, not left spinning.
            Part::Tool(tool) if tool.state.is_running() => {
                tool.state = ToolState::OutputError;
                tool.error = Some(INTERRUPTED.into());
            }
            Part::Compaction(compaction) if compaction.running => {
                compaction.running = false;
                compaction.aborted = true;
            }
            _ => {}
        }
    }
}

fn set_running(transcript: &mut Transcript, running: bool, at: u64) {
    if running {
        transcript.running = true;
        return;
    }
    let had_open = transcript.messages.last().is_some_and(|last| last.parts.iter().any(Part::is_open));
    transcript.running = false;
    if had_open && let Some(last) = transcript.messages.last_mut().filter(|last| last.role == Role::Assistant) {
        settle(&mut last.parts, at);
    }
}

fn push_user_message(transcript: &mut Transcript, data: &Value, at: u64) {
    let id = str_field(data, "id").unwrap_or_else(|| format!("user-{at}"));
    if transcript.messages.iter().any(|message| message.id == id) {
        return;
    }
    let text = str_field(data, "text").unwrap_or_default();
    let parts = if text.is_empty() { Vec::new() } else { vec![Part::Text { text, streaming: false }] };
    transcript.running = true;
    transcript.messages.push(Message {
        id,
        role: Role::User,
        parts,
        created_at: u64_field(data, "ts").unwrap_or(at),
        interrupted: false,
    });
}

fn attach_images(transcript: &mut Transcript, data: &Value) {
    let urls: Vec<String> = data.as_array().map(|urls| urls.iter().filter_map(|url| url.as_str().map(str::to_string)).collect()).unwrap_or_default();
    if let Some(prompt) = transcript.messages.iter_mut().rev().find(|message| message.role == Role::User) {
        prompt.parts.extend(urls.into_iter().map(|url| Part::Image { url }));
    }
}

fn push_note(transcript: &mut Transcript, label: &'static str, text: &str, at: u64) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let parts = reply(transcript, at);
    close_open_block(parts, at);
    parts.push(Part::Note { label, text: text.to_string() });
}

fn running_compaction() -> Compaction {
    Compaction { running: true, summary: None, tokens_before: None, tokens_after: None, error: None, aborted: false }
}

fn apply_compaction_end(compaction: &mut Compaction, data: &Value) {
    compaction.running = false;
    compaction.summary = str_field(data, "summary").filter(|summary| !summary.is_empty());
    compaction.tokens_before = u64_field(data, "tokensBefore");
    compaction.tokens_after = u64_field(data, "tokensAfter");
    compaction.error = str_field(data, "error");
    compaction.aborted = data["aborted"] == true;
}

fn end_compaction(parts: &mut Vec<Part>, data: &Value) {
    let open = parts.iter_mut().rev().find_map(|part| match part {
        Part::Compaction(compaction) if compaction.running => Some(compaction),
        _ => None,
    });
    match open {
        Some(compaction) => apply_compaction_end(compaction, data),
        None => {
            let mut compaction = running_compaction();
            apply_compaction_end(&mut compaction, data);
            parts.push(Part::Compaction(compaction));
        }
    }
}

/// Idle compaction runs between turns: a marker of its own, never a reply.
fn is_idle_compaction(kind: &str, data: &Value) -> bool {
    kind == "compact-start" && data["reason"] == "idle"
}

fn idle_compaction_marker(at: u64) -> Message {
    Message {
        id: format!("compact-idle-{at}"),
        role: Role::System,
        parts: vec![Part::Compaction(running_compaction())],
        created_at: at,
        interrupted: false,
    }
}

/// Closes a running idle-compaction marker; an aborted one leaves nothing
/// behind. False when there is no such marker (a turn's own compaction).
fn finish_idle_compaction(transcript: &mut Transcript, data: &Value) -> bool {
    let Some(index) = transcript.messages.iter().rposition(|message| {
        message.role == Role::System && matches!(message.parts.first(), Some(Part::Compaction(c)) if c.running)
    }) else {
        return false;
    };
    if data["aborted"] == true {
        transcript.messages.remove(index);
    } else if let Some(Part::Compaction(compaction)) = transcript.messages[index].parts.first_mut() {
        apply_compaction_end(compaction, data);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(events: &[(&str, Value)]) -> Transcript {
        let mut transcript = Transcript::default();
        for (at, (kind, data)) in events.iter().enumerate() {
            apply_event(&mut transcript, kind, data, at as u64 * 1000);
        }
        transcript
    }

    #[test]
    fn a_streamed_turn_builds_parts_in_order() {
        let transcript = run(&[
            ("user-message", json!({ "id": "u1", "text": "hi" })),
            ("reasoning-delta", json!("thinking")),
            ("text-delta", json!("Hel")),
            ("text-delta", json!("lo")),
            ("tool-input-start", json!({ "toolCallId": "c1", "toolName": "bash" })),
            ("tool-call", json!({ "toolCallId": "c1", "toolName": "bash", "input": { "command": "ls" } })),
            ("tool-result", json!({ "toolCallId": "c1", "output": "a" })),
            ("text-delta", json!("done")),
            ("finish", json!({})),
        ]);
        let reply = &transcript.messages[1];
        assert_eq!(reply.id, "u1:reply");
        let kinds: Vec<&str> = reply
            .parts
            .iter()
            .map(|part| match part {
                Part::Reasoning { duration_ms: Some(1000), streaming: false, .. } => "thought 1s",
                Part::Text { text, streaming: false } if text == "Hello" => "Hello",
                Part::Text { text, streaming: false } if text == "done" => "done",
                Part::Tool(tool) if tool.state == ToolState::OutputAvailable => "tool",
                _ => "unexpected",
            })
            .collect();
        assert_eq!(kinds, ["thought 1s", "Hello", "tool", "done"]);
    }

    #[test]
    fn a_stopped_turn_marks_unfinished_calls_interrupted() {
        let transcript = run(&[
            ("user-message", json!({ "id": "u1", "text": "go" })),
            ("tool-call", json!({ "toolCallId": "c1", "toolName": "bash", "input": {} })),
            ("session-running", json!({ "running": false })),
        ]);
        assert!(!transcript.running);
        let Part::Tool(tool) = &transcript.messages[1].parts[0] else { panic!("not a tool") };
        assert_eq!((tool.state, tool.error.as_deref()), (ToolState::OutputError, Some(INTERRUPTED)));
    }

    #[test]
    fn a_reply_without_a_running_turn_starts_a_new_message() {
        let transcript = run(&[
            ("user-message", json!({ "id": "u1", "text": "a" })),
            ("text-delta", json!("first")),
            ("finish", json!({})),
            ("session-running", json!({ "running": false })),
            ("text-delta", json!("second")),
        ]);
        assert_eq!(transcript.messages.len(), 3);
    }

    #[test]
    fn mcp_style_failures_are_errors() {
        let transcript = run(&[(
            "tool-result",
            json!({ "toolCallId": "c1", "toolName": "x__y", "output": { "isError": true, "content": [{ "text": "nope" }] } }),
        )]);
        let Part::Tool(tool) = &transcript.messages[0].parts[0] else { panic!("not a tool") };
        assert_eq!(tool.error.as_deref(), Some("nope"));
    }
}
