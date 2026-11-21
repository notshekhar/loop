//! The rows a reply is made of besides its prose, as loop draws them:
//! LoopThinkingRow, LoopToolRow and LoopToolGroupRow. Each is a 13px header
//! line — icon, label, then a count and chevron on the right — over a body
//! inset 22px.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, Context, FontWeight, Hsla, InteractiveElement,
    IntoElement, ParentElement, SharedString, StatefulInteractiveElement, Styled, Transformation,
    div, percentage, prelude::FluentBuilder, pulsating_between, px, relative,
};
use serde_json::Value;

use super::ConversationView;
use crate::assets::Icon;
use crate::theme::ActiveTheme;
use crate::transcript::output::{COLLAPSED_LINES, LIVE_TAIL_LINES, gutters, is_diff, output_lines};
use crate::transcript::tools::summary;
use crate::transcript::{ToolPart, ToolState};
use crate::ui::format::seconds;
use crate::ui::icon::icon;

/// Every row's header text.
const LABEL_SIZE: f32 = 13.;
/// Bodies line up with the label, past the 14px icon and 8px gap.
const BODY_INSET: f32 = 22.;

/// Opacity that pulses while the thing it belongs to is still happening.
pub fn pulsing(id: impl Into<SharedString>, element: impl IntoElement + 'static) -> AnyElement {
    let id: SharedString = id.into();
    div()
        .child(element)
        .with_animation(id, Animation::new(Duration::from_millis(1400)).repeat().with_easing(pulsating_between(0.45, 1.)), |row, delta| row.opacity(delta))
        .into_any_element()
}

fn spinning(id: SharedString, glyph: Icon, color: Hsla) -> AnyElement {
    icon(glyph, color)
        .size(px(14.))
        .with_animation(id, Animation::new(Duration::from_secs(1)).repeat(), |glyph, delta| glyph.with_transformation(Transformation::rotate(percentage(delta))))
        .into_any_element()
}

/// The header every row shares; clickable only when it has something to
/// open.
fn row_header(id: SharedString, leading: AnyElement, label: AnyElement, trailing: Option<AnyElement>, toggle: Option<bool>, cx: &mut Context<ConversationView>) -> AnyElement {
    let theme = cx.theme();
    let key = id.clone();
    let chevron = toggle.map(|open| icon(if open { Icon::ChevronDown } else { Icon::ChevronRight }, theme.muted.opacity(0.45)).size(px(14.)));
    let row = div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .p_1()
        .rounded(px(8.))
        .text_size(px(LABEL_SIZE))
        .child(leading)
        .child(div().flex_1().min_w_0().flex().items_center().gap_2().child(label))
        .when(trailing.is_some() || chevron.is_some(), |row| {
            row.child(div().flex_none().flex().items_center().gap_1().text_size(px(11.)).text_color(theme.muted.opacity(0.45)).children(trailing).children(chevron))
        });
    let row = match toggle {
        Some(_) => row.cursor_pointer().hover(|row| row.bg(gpui::rgba(0xffffff04))).on_click(cx.listener(move |view, _, _, cx| view.toggle(key.clone(), cx))),
        None => row,
    };
    div().py(px(1.)).child(row).into_any_element()
}

/// loop's ToolIcon: one glyph per kind of tool.
fn tool_icon(name: &str) -> Icon {
    match name {
        "bash" => Icon::Terminal,
        "read" => Icon::Eye,
        "write" | "edit" => Icon::SquarePen,
        "grep" | "find" => Icon::Search,
        "ls" => Icon::Folder,
        "websearch" | "webfetch" => Icon::Globe,
        "sql" => Icon::Database,
        "task" => Icon::Bot,
        "skill" => Icon::Sparkles,
        _ => Icon::Wrench,
    }
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn calls(count: usize) -> String {
    if count == 1 { "1 call".into() } else { format!("{count} calls") }
}

impl ConversationView {
    /// `🧠 Thought for 14s ›`; open, the reasoning in italics behind a rule.
    /// While it streams, the last three lines show even closed.
    pub(super) fn render_reasoning(&self, key: SharedString, text: &str, streaming: bool, duration_ms: Option<u64>, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let open = self.expanded.contains(&key);
        let label = match (streaming, duration_ms) {
            (true, _) => "Thinking…".to_string(),
            (false, Some(ms)) => format!("Thought for {}", seconds(ms)),
            (false, None) => "Thought".to_string(),
        };
        let brain = icon(Icon::Brain, if streaming { theme.text.opacity(0.6) } else { theme.muted.opacity(0.6) }).size(px(14.));
        let leading = if streaming { pulsing(format!("{key}-pulse"), brain) } else { brain.into_any_element() };
        let label = div().truncate().text_color(if streaming { theme.text.opacity(0.75) } else { theme.muted.opacity(0.8) }).child(label).into_any_element();
        let body = if open { Some(text.trim().to_string()) } else if streaming { Some(last_lines(text, LIVE_TAIL_LINES)) } else { None };
        div()
            .flex()
            .flex_col()
            .child(row_header(key, leading, label, None, Some(open), cx))
            .when_some(body.filter(|body| !body.is_empty()), |row, body| {
                row.child(
                    div()
                        .mt_1()
                        .ml(px(BODY_INSET))
                        .pl_3()
                        .border_l_2()
                        .border_color(theme.border.opacity(0.6))
                        .text_size(px(12.5))
                        .line_height(relative(1.625))
                        .italic()
                        .text_color(theme.muted)
                        .child(body),
                )
            })
            .into_any_element()
    }

    /// One call: `name detail … status`, with its output below — the first
    /// six lines, all of them once opened.
    pub(super) fn render_tool(&self, tool: &ToolPart, cwd: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let key: SharedString = format!("tool-{}", tool.call_id).into();
        let open = self.expanded.contains(&key);
        let running = tool.state.is_running();
        let failed = tool.state == ToolState::OutputError;
        let lines = output_lines(tool);
        let can_open = lines.len() > COLLAPSED_LINES;
        let leading = if running {
            spinning(format!("{key}-spin").into(), Icon::CircleDashed, theme.warning)
        } else if failed {
            icon(Icon::CircleAlert, theme.error).size(px(14.)).into_any_element()
        } else {
            icon(tool_icon(&tool.name), theme.muted.opacity(0.7)).size(px(14.)).into_any_element()
        };
        let (name, detail) = match &tool.subagent {
            Some(run) => (format!("task {}", run.agent), tool.input.get("prompt").and_then(Value::as_str).and_then(|prompt| prompt.lines().next()).unwrap_or_default().chars().take(60).collect()),
            None => (tool.name.clone(), summary(tool, cwd)),
        };
        let status = match &tool.subagent {
            Some(run) if !run.finished => run.current.clone().unwrap_or_else(|| "running".into()),
            _ if running => "running".into(),
            _ => String::new(),
        };
        let label = div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .gap_2()
            .child(div().flex_none().font_weight(FontWeight::MEDIUM).text_color(if failed { theme.error } else { theme.text.opacity(0.85) }).child(name))
            .child(div().flex_1().min_w_0().truncate().font_family(theme.mono_font).text_size(px(12.)).text_color(theme.muted.opacity(0.75)).child(detail))
            .when(!status.is_empty(), |row| row.child(div().flex_none().text_size(px(11.)).text_color(theme.muted.opacity(0.55)).child(status)))
            .into_any_element();
        let count = (can_open && !open).then(|| div().child(format!("{} lines", lines.len())).into_any_element());
        let streaming = match (&tool.input_text, tool.state) {
            (Some(text), ToolState::InputStreaming) => Some(last_lines(text, LIVE_TAIL_LINES)),
            _ => None,
        };
        div()
            .flex()
            .flex_col()
            .child(row_header(key.clone(), leading, label, count, can_open.then_some(open), cx))
            .when_some(streaming, |row, text| row.child(output_surface(cx).child(div().px_2().py_1().text_color(theme.text.opacity(0.6)).child(text))))
            .when(!lines.is_empty(), |row| row.child(self.render_output(tool, key, &lines, open, cx)))
            .into_any_element()
    }

    fn render_output(&self, tool: &ToolPart, key: SharedString, lines: &[String], open: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let shown = if open { lines } else { &lines[..lines.len().min(COLLAPSED_LINES)] };
        let hidden = lines.len() - shown.len();
        let gutters = gutters(tool, shown);
        let gutter_width = gutters.iter().map(String::len).max().unwrap_or(0);
        let diff = is_diff(tool);
        let failed = tool.state == ToolState::OutputError;
        let body = div().py_1().children(shown.iter().enumerate().map(|(ix, line)| {
            let (background, color) = match line.chars().next() {
                Some('+') if diff => (Some(theme.success.opacity(0.1)), theme.success),
                Some('-') if diff => (Some(theme.error.opacity(0.1)), theme.error),
                _ if failed => (None, theme.error.opacity(0.9)),
                _ => (None, theme.text.opacity(0.7)),
            };
            div()
                .flex()
                .px_2()
                .when_some(background, |row, background| row.bg(background))
                .when(gutter_width > 0, |row| {
                    row.child(div().flex_none().w(px(gutter_width as f32 * 7.) + px(12.)).pr_3().text_right().text_color(theme.muted.opacity(0.4)).child(gutters[ix].clone()))
                })
                .child(div().flex_1().min_w_0().text_color(color).child(if line.is_empty() { " ".to_string() } else { line.clone() }))
        }));
        let footer = (hidden > 0 || (open && lines.len() > COLLAPSED_LINES)).then(|| {
            div()
                .id(SharedString::from(format!("{key}-more")))
                .w_full()
                .px_2()
                .py_1()
                .border_t_1()
                .border_color(theme.border.opacity(0.4))
                .text_size(px(11.))
                .text_color(theme.muted.opacity(0.6))
                .cursor_pointer()
                .hover(|button| button.bg(gpui::rgba(0xffffff04)).text_color(theme.muted))
                .child(if open { "Show less".to_string() } else { format!("Show {hidden} more lines") })
                .on_click(cx.listener(move |view, _, _, cx| view.toggle(key.clone(), cx)))
        });
        output_surface(cx).child(body).children(footer).into_any_element()
    }

    /// Finished calls folded under one line: `Ran 2 commands   2 calls ›`.
    pub(super) fn render_tool_run(&self, label: &str, failed: usize, tools: &[&ToolPart], cwd: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let key: SharedString = format!("run-{}", tools.first().map_or("", |tool| tool.call_id.as_str())).into();
        let open = self.expanded.contains(&key);
        let text = div()
            .flex()
            .min_w_0()
            .child(div().truncate().text_color(theme.muted.opacity(0.8)).child(label.to_string()))
            .when(failed > 0, |row| row.child(div().flex_none().text_color(theme.error).child(format!(" · {failed} failed"))))
            .into_any_element();
        let count = (!open).then(|| div().child(calls(tools.len())).into_any_element());
        div()
            .flex()
            .flex_col()
            .child(row_header(key, icon(Icon::Layers, theme.muted.opacity(0.55)).size(px(14.)).into_any_element(), text, count, Some(open), cx))
            .when(open, |run| {
                run.child(
                    div()
                        .ml(px(10.))
                        .pl_2()
                        .border_l_1()
                        .border_color(theme.border.opacity(0.5))
                        .flex()
                        .flex_col()
                        .children(tools.iter().map(|tool| self.render_tool(tool, cwd, cx))),
                )
            })
            .into_any_element()
    }
}

/// The code surface tool output sits on.
fn output_surface(cx: &Context<ConversationView>) -> gpui::Div {
    let theme = cx.theme();
    div()
        .mt_1()
        .ml(px(BODY_INSET))
        .overflow_hidden()
        .rounded(px(8.))
        .border_1()
        .border_color(theme.border.opacity(0.5))
        .bg(gpui::rgba(0xffffff03))
        .font_family(theme.mono_font)
        .text_size(px(11.5))
        .line_height(relative(1.55))
}
