//! One message of the transcript, as loop's MessagesTimeline draws it: the
//! user's prompt as a bubble on the right, the reply as its parts in order.

use gpui::{
    AnyElement, ClipboardItem, Context, InteractiveElement, IntoElement, ObjectFit, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, StyledImage, div, img, prelude::FluentBuilder,
    px, relative,
};

use super::ConversationView;
use super::status::render_working;
use crate::assets::Icon;
use crate::markdown::{parse, render_markdown};
use crate::theme::{ActiveTheme, CONVERSATION_WIDTH, PROSE_LINE_HEIGHT};
use crate::transcript::tools::{Block, blocks};
use crate::transcript::{Message, Part, Role};
use crate::ui::controls::ghost_icon_button;
use crate::ui::icon::icon;

/// A prompt longer than this folds to `FOLDED_HEIGHT` behind "Show full
/// message" (loop's MessagesTimeline: 600 characters or 8 lines).
const FOLD_CHARS: usize = 600;
const FOLD_LINES: usize = 8;
const FOLDED_HEIGHT: f32 = 176.;
/// Space under a prompt or a finished reply.
const MESSAGE_GAP: f32 = 16.;

fn text_of(message: &Message, separator: &str) -> String {
    message
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(separator)
}

impl ConversationView {
    pub(super) fn render_message(&self, message: &Message, is_last: bool, cx: &mut Context<Self>) -> AnyElement {
        let body = match message.role {
            Role::User => self.render_prompt(message, cx),
            Role::Assistant => self.render_reply(message, is_last, cx),
            Role::System => self.render_marker(message, cx),
        };
        // A turn that has not written anything yet still says it is working;
        // once a reply exists, the reply draws that line itself.
        let waiting = is_last && message.role != Role::Assistant && self.running(cx);
        div()
            .w_full()
            .px_5()
            .pb(px(MESSAGE_GAP))
            .flex()
            .justify_center()
            .child(div().w_full().max_w(CONVERSATION_WIDTH).flex().flex_col().child(body).when(waiting, |column| column.child(div().pt(px(MESSAGE_GAP)).child(render_working(self, cx)))))
            .into_any_element()
    }

    fn render_prompt(&self, message: &Message, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let text = text_of(message, "\n");
        let images: Vec<&str> = message.parts.iter().filter_map(|part| match part {
            Part::Image { url } => Some(url.as_str()),
            _ => None,
        }).collect();
        let group: SharedString = format!("prompt-{}", message.id).into();
        let fold_key: SharedString = format!("unfold-{}", message.id).into();
        let foldable = text.chars().count() > FOLD_CHARS || text.lines().count() > FOLD_LINES;
        let unfolded = self.expanded.contains(&fold_key);
        let bubble = div()
            .max_w(relative(0.8))
            .p_3()
            .rounded(px(18.))
            .bg(theme.bubble)
            .when(!images.is_empty(), |bubble| bubble.child(render_images(&images, cx)))
            .when(!text.is_empty(), |bubble| {
                bubble.child(
                    div()
                        .text_sm()
                        .line_height(relative(PROSE_LINE_HEIGHT))
                        .text_color(theme.text)
                        .when(foldable && !unfolded, |body| body.max_h(px(FOLDED_HEIGHT)).overflow_hidden())
                        .child(text.clone()),
                )
            })
            .when(foldable, |bubble| {
                let key = fold_key.clone();
                bubble.child(
                    div().pt_1p5().child(
                        div()
                            .id(SharedString::from(format!("{fold_key}-button")))
                            .h(px(24.))
                            .px_1p5()
                            .flex()
                            .items_center()
                            .rounded(px(8.))
                            .text_xs()
                            .text_color(theme.muted.opacity(0.72))
                            .cursor_pointer()
                            .hover(|button| button.bg(theme.selected).text_color(theme.text.opacity(0.85)))
                            .child(if unfolded { "Show less" } else { "Show full message" })
                            .on_click(cx.listener(move |view, _, _, cx| view.toggle(key.clone(), cx))),
                    ),
                )
            });
        let actions = div()
            .max_w(relative(0.8))
            .pr_1()
            .flex()
            .justify_end()
            .invisible()
            .group_hover(group.clone(), |row| row.visible())
            .child(self.copy_button(format!("copy-{}", message.id).into(), text, cx));
        div().group(group).flex().flex_col().items_end().gap_1().child(bubble).child(actions).into_any_element()
    }

    fn render_reply(&self, message: &Message, is_last: bool, cx: &mut Context<Self>) -> AnyElement {
        let cwd = self.cwd.clone();
        let group: SharedString = format!("reply-{}", message.id).into();
        let working = is_last && self.running(cx);
        let mut column = div().group(group.clone()).px_1().py_0p5().flex().flex_col().gap_0p5();
        for (ix, block) in blocks(&message.parts).into_iter().enumerate() {
            column = column.child(match block {
                Block::ToolRun { label, failed, tools } => self.render_tool_run(&label, failed, &tools, &cwd, cx),
                Block::Part(part) => self.render_part(&message.id, ix, part, &cwd, cx),
            });
        }
        let text = text_of(message, "\n\n");
        let muted = cx.theme().muted;
        column
            .when(message.interrupted, |column| column.child(div().p_1().text_xs().text_color(muted).child("Interrupted")))
            .when(working, |column| column.child(render_working(self, cx)))
            .when(!working && !text.trim().is_empty(), |column| {
                // Copy fades in while the pointer is over the reply.
                column.child(div().mt_1p5().flex().gap_2().invisible().group_hover(group, |row| row.visible()).child(self.copy_button(format!("copy-{}", message.id).into(), text, cx)))
            })
            .into_any_element()
    }

    fn render_part(&self, message_id: &str, ix: usize, part: &Part, cwd: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        match part {
            // A paragraph sits ~8px from the rows around it, as in loop.
            Part::Text { text, .. } => div().py_1p5().child(render_markdown(&format!("{message_id}-{ix}"), &parse(text), cx)).into_any_element(),
            Part::Reasoning { text, streaming, duration_ms, .. } => self.render_reasoning(format!("think-{message_id}-{ix}").into(), text, *streaming, *duration_ms, cx),
            Part::Tool(tool) => self.render_tool(tool, cwd, cx),
            Part::Image { url } => img(std::path::PathBuf::from(url.as_str())).max_w(px(320.)).rounded(px(10.)).into_any_element(),
            Part::Compaction(compaction) => self.render_compaction(format!("compact-{message_id}-{ix}").into(), compaction, cx),
            Part::Note { label, text } => div()
                .my_1()
                .px_3()
                .py_2()
                .rounded(px(10.))
                .bg(theme.card)
                .border_1()
                .border_color(theme.border)
                .text_sm()
                .text_color(theme.prose)
                .child(div().text_xs().text_color(theme.muted).child(*label))
                .child(text.clone())
                .into_any_element(),
            Part::Retry { attempt, max, reason } => div().p_1().text_xs().text_color(theme.warning).child(format!("Retrying ({attempt}/{max}): {reason}")).into_any_element(),
            Part::Error(text) => render_error(text, cx),
        }
    }

    fn render_marker(&self, message: &Message, cx: &mut Context<Self>) -> AnyElement {
        let compaction = message.parts.iter().find_map(|part| match part {
            Part::Compaction(compaction) => Some(compaction),
            _ => None,
        });
        match compaction {
            Some(compaction) => self.render_compaction(format!("compact-{}", message.id).into(), compaction, cx),
            None => div().into_any_element(),
        }
    }

    /// loop's MessageCopyButton: a 12px copy icon that turns into a blue
    /// check for a second after copying.
    fn copy_button(&self, id: SharedString, text: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        if self.copied.as_ref() == Some(&id) {
            return div().size(px(24.)).flex().items_center().justify_center().child(icon(Icon::Check, theme.primary).size(px(12.))).into_any_element();
        }
        let key = id.clone();
        ghost_icon_button(id, Icon::Copy, cx)
            .on_click(cx.listener(move |view, _, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                view.show_copied(key.clone(), cx);
            }))
            .into_any_element()
    }
}

/// Attached images: two columns, cover-cropped, up to 420px wide.
fn render_images(urls: &[&str], cx: &Context<ConversationView>) -> impl IntoElement {
    let theme = cx.theme();
    div().max_w(px(420.)).mb_2().flex().flex_wrap().gap_2().children(urls.iter().map(|url| {
        div().w(px(206.)).overflow_hidden().rounded(px(10.)).border_1().border_color(theme.border.opacity(0.8)).bg(theme.background.opacity(0.7)).child(
            img(std::path::PathBuf::from(url.trim_start_matches("file://"))).w_full().max_h(px(220.)).object_fit(ObjectFit::Cover),
        )
    }))
}

/// A turn's failure, in loop's error-banner style.
fn render_error(text: &str, cx: &Context<ConversationView>) -> AnyElement {
    let theme = cx.theme();
    div()
        .my_1()
        .px(px(14.))
        .py_3()
        .flex()
        .gap_2()
        .rounded(px(14.))
        .border_1()
        .border_color(theme.error.opacity(0.32))
        .bg(theme.error.opacity(0.04))
        .text_sm()
        .text_color(theme.error)
        .child(div().pt_0p5().child(icon(Icon::CircleAlert, theme.error)))
        .child(div().flex_1().min_w_0().child(text.to_string()))
        .into_any_element()
}
