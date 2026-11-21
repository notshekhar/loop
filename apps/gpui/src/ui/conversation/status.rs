//! Lines that report on the turn rather than belong to it: loop's working
//! indicator (GeneratingIndicator) and the compaction divider
//! (LoopCompactRow).

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
    relative, rgb,
};

use super::ConversationView;
use super::rows::pulsing;
use crate::assets::Icon;
use crate::insights::format_tokens;
use crate::transcript::model::Compaction;
use crate::transcript::{Part, Role};
use crate::theme::ActiveTheme;
use crate::ui::icon::icon;

/// loop rotates the working verb every 3.2s.
const VERB_EVERY_MS: u128 = 3200;
const VERBS: [&str; 10] = ["Working", "Looping", "Thinking", "Cooking", "Untangling", "Wiring", "Noodling", "Brewing", "Tinkering", "Spelunking"];
/// The comet's body colour, `oklch(.74 .13 264)`.
const COMET: u32 = 0x86a2f8;

/// `12s`, `1m 5s`, `1h 2m` — the working timer.
pub fn elapsed(ms: u128) -> String {
    let seconds = ms / 1000;
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m {}s", seconds / 60, seconds % 60),
        _ => format!("{}h {}m", seconds / 3600, seconds % 3600 / 60),
    }
}

/// What the line says: the call in flight, else a rotating verb and how
/// long the turn has run.
fn working_label(view: &ConversationView, cx: &Context<ConversationView>) -> String {
    let session = view.session.as_ref().map(|session| session.read(cx));
    let running_tool = session.and_then(|session| session.transcript.messages.last()).filter(|message| message.role == Role::Assistant).and_then(|message| {
        message.parts.iter().rev().find_map(|part| match part {
            Part::Tool(tool) if tool.state.is_running() => Some(tool.name.clone()),
            _ => None,
        })
    });
    if let Some(name) = running_tool {
        return format!("Running {name}");
    }
    match view.turn_started {
        Some(started) => {
            let ms = started.elapsed().as_millis();
            format!("{} for {}", VERBS[(ms / VERB_EVERY_MS) as usize % VERBS.len()], elapsed(ms))
        }
        None => format!("{}…", VERBS[0]),
    }
}

fn shimmer(muted: Hsla, text: Hsla, delta: f32) -> Hsla {
    // A band of foreground passing over muted text and back.
    let share = 1. - (delta * 2. - 1.).abs();
    let mix = |a: f32, b: f32| a + (b - a) * share;
    let (muted, text) = (muted.to_rgb(), text.to_rgb());
    gpui::Rgba { r: mix(muted.r, text.r), g: mix(muted.g, text.g), b: mix(muted.b, text.b), a: 1. }.into()
}

pub fn render_working(view: &ConversationView, cx: &Context<ConversationView>) -> AnyElement {
    let theme = cx.theme();
    let comet: Hsla = rgb(COMET).into();
    let mark = pulsing("working-mark", icon(Icon::Infinity, comet).size(px(18.)));
    let label = div()
        .font_weight(FontWeight::MEDIUM)
        .child(working_label(view, cx))
        .with_animation("working-shimmer", Animation::new(Duration::from_millis(2400)).repeat(), move |label, delta| label.text_color(shimmer(theme.muted, theme.text, delta)));
    div().pt_1p5().pb_0p5().pl_1().flex().items_center().gap(px(10.)).text_xs().child(mark).child(label).into_any_element()
}

fn compaction_label(compaction: &Compaction) -> String {
    if compaction.running {
        "Compacting context…".into()
    } else if let Some(error) = &compaction.error {
        format!("Compaction failed · {error}")
    } else if compaction.aborted {
        "Compaction cancelled".into()
    } else {
        match (compaction.tokens_before, compaction.tokens_after) {
            (Some(before), Some(after)) => format!("Context compacted · {} → {} tokens", format_tokens(before), format_tokens(after)),
            _ => "Context compacted".into(),
        }
    }
}

impl ConversationView {
    /// A pill on a rule; opens to "what the model sees instead".
    pub(super) fn render_compaction(&self, key: SharedString, compaction: &Compaction, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let summary = compaction.summary.clone().filter(|summary| !summary.trim().is_empty());
        let open = summary.is_some() && self.expanded.contains(&key);
        let rule_color = if compaction.aborted { theme.border.opacity(0.4) } else { theme.border.opacity(0.7) };
        let rule = || div().flex_1().h(px(1.)).bg(rule_color);
        let scissors = icon(Icon::Scissors, theme.muted.opacity(0.75)).size(px(12.));
        let toggle_key = key.clone();
        let pill = div()
            .id(key.clone())
            .px(px(10.))
            .py_0p5()
            .flex()
            .items_center()
            .gap_1p5()
            .rounded_full()
            .border_1()
            .border_color(theme.border.opacity(0.6))
            .bg(theme.background)
            .text_size(px(11.))
            .text_color(theme.muted.opacity(0.75))
            .child(if compaction.running { pulsing(format!("{key}-pulse"), scissors) } else { scissors.into_any_element() })
            .child(compaction_label(compaction))
            .when(summary.is_some(), |pill| {
                pill.cursor_pointer()
                    .hover(|pill| pill.border_color(theme.border).text_color(theme.text.opacity(0.8)))
                    .child(icon(if open { Icon::ChevronDown } else { Icon::ChevronRight }, theme.muted.opacity(0.75)).size(px(12.)))
                    .on_click(cx.listener(move |view, _, _, cx| view.toggle(toggle_key.clone(), cx)))
            });
        div()
            .py_2()
            .flex()
            .flex_col()
            .child(div().flex().items_center().gap_3().child(rule()).child(pill).child(rule()))
            .when_some(summary.filter(|_| open), |column, summary| {
                column.child(
                    div()
                        .mt_2()
                        .px_3()
                        .py_2()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme.border.opacity(0.5))
                        .bg(gpui::rgba(0xffffff03))
                        .child(div().text_size(px(11.)).font_weight(FontWeight::MEDIUM).text_color(theme.muted.opacity(0.6)).child("WHAT THE MODEL SEES INSTEAD"))
                        .child(div().mt_1().text_size(px(12.5)).line_height(relative(1.6)).text_color(theme.muted).child(summary)),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_working_timer_reads_like_loops() {
        assert_eq!(elapsed(12_400), "12s");
        assert_eq!(elapsed(65_000), "1m 5s");
        assert_eq!(elapsed(3_720_000), "1h 2m");
    }
}
