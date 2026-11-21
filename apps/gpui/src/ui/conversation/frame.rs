//! What surrounds the transcript, placed as loop's ChatView places it: the
//! draft headline, the error banner, "Scroll to end", and the composer dock.

use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
    Styled, div, prelude::FluentBuilder, px, relative,
};

use super::{ConversationView, todos};
use crate::assets::Icon;
use crate::theme::{ActiveTheme, CONVERSATION_WIDTH};
use crate::threads::folder_name;
use crate::ui::controls::ghost_icon_button;
use crate::ui::icon::icon;

/// Under the composer's toolbar, loop leaves 20px.
const DOCK_BOTTOM: f32 = 20.;

impl ConversationView {
    /// "What should we build in <project>?", 32px above the composer.
    pub(super) fn render_draft_hero(&self, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .pb_8()
            .flex()
            .justify_center()
            .items_baseline()
            .text_size(px(30.))
            .line_height(px(36.))
            .text_color(theme.text)
            .child("What should we build in\u{a0}")
            .child(div().border_b_1().border_dashed().border_color(theme.text.opacity(0.6)).child(folder_name(&self.cwd).to_string()))
            .child("?")
    }

    /// A request that failed outside any turn, above the transcript.
    pub(super) fn render_error_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.theme();
        let error = self.error.clone()?;
        Some(
            div()
                .w_full()
                .pt_3()
                .px_4()
                .flex()
                .justify_center()
                .child(
                    div()
                        .max_w(CONVERSATION_WIDTH)
                        .px(px(14.))
                        .py_3()
                        .flex()
                        .items_start()
                        .gap_2()
                        .rounded(px(14.))
                        .border_1()
                        .border_color(theme.error.opacity(0.32))
                        .bg(theme.error.opacity(0.04))
                        .text_sm()
                        .text_color(theme.error)
                        .child(div().pt_0p5().child(icon(Icon::CircleAlert, theme.error)))
                        .child(div().flex_1().min_w_0().line_clamp(3).child(error))
                        .child(ghost_icon_button("dismiss-error", Icon::X, cx).mt(px(-2.)).on_click(cx.listener(|view, _, _, cx| {
                            view.error = None;
                            cx.notify();
                        }))),
                )
                .into_any_element(),
        )
    }

    /// "Scroll to end", 4px above the composer once the user has scrolled
    /// away from the bottom.
    fn render_scroll_to_end(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        if self.list.is_scrolled_to_end() != Some(false) {
            return None;
        }
        let theme = cx.theme();
        Some(
            div().absolute().bottom(relative(1.)).left_0().right_0().pb_1().flex().justify_center().child(
                div()
                    .id("scroll-to-end")
                    .px_3()
                    .py_1()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .rounded_full()
                    .border_1()
                    .border_color(theme.border.opacity(0.6))
                    .bg(theme.background.opacity(0.8))
                    .shadow_sm()
                    .text_xs()
                    .text_color(theme.muted)
                    .cursor_pointer()
                    .hover(|pill| pill.border_color(theme.border).text_color(theme.text))
                    .child(icon(Icon::ChevronDown, theme.muted).size(px(14.)))
                    .child("Scroll to end")
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.list.scroll_to_end();
                        view.list.set_follow_mode(gpui::FollowMode::Tail);
                        cx.notify();
                    })),
            ),
        )
    }

    /// The composer — or the agent's question in its place — with the todo
    /// list above it, in the transcript's column with loop's 12px inset.
    pub(super) fn render_dock(&mut self, docked: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let todos = self.session.as_ref().map(|session| session.read(cx).transcript.todos.clone()).unwrap_or_default();
        let scroll_to_end = if docked { self.render_scroll_to_end(cx) } else { None };
        let input: AnyElement = match &self.ask_panel {
            Some(panel) => panel.clone().into_any_element(),
            None => self.composer.clone().into_any_element(),
        };
        div()
            .w_full()
            .px_5()
            .flex()
            .justify_center()
            .when(docked, |dock| dock.pt_2().pb(px(DOCK_BOTTOM)))
            .child(
                div()
                    .relative()
                    .w_full()
                    .max_w(CONVERSATION_WIDTH)
                    .px_3()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .children(scroll_to_end)
                    .when(!todos.is_empty(), |column| column.child(todos::render_todos(&todos, cx)))
                    .child(input),
            )
    }
}
