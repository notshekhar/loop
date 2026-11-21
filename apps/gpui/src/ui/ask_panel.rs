//! The agent's questions in the composer's place, as loop's
//! ComposerPendingUserInputPanel draws them: one question at a time over
//! numbered options, a typed answer below, and pill buttons to move on.

use gpui::{
    AppContext, Context, Entity, EventEmitter, Focusable, FontWeight, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, prelude::FluentBuilder, px, relative,
};

use crate::assets::Icon;
use crate::session::PendingAsk;
use crate::theme::{ActiveTheme, PROSE_LINE_HEIGHT};
use crate::ui::icon::icon;
use crate::ui::text_input::{InputEvent, TextInput};

/// One answer per question, index-aligned; empty declines that question.
pub struct Answered(pub Vec<Vec<String>>);

pub struct AskPanel {
    ask: PendingAsk,
    current: usize,
    picked: Vec<Vec<String>>,
    other: Entity<TextInput>,
}

impl EventEmitter<Answered> for AskPanel {}

impl AskPanel {
    pub fn new(ask: PendingAsk, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let other = cx.new(|cx| TextInput::new("Type your own answer, or leave this blank to use the selected option", 4, cx));
        cx.subscribe(&other, |panel, _, event: &InputEvent, cx| match event {
            InputEvent::Submit => panel.next(cx),
            InputEvent::Changed => cx.notify(),
        })
        .detach();
        window.focus(&other.focus_handle(cx), cx);
        let picked = vec![Vec::new(); ask.questions.len()];
        Self { ask, current: 0, picked, other }
    }

    pub fn ask_id(&self) -> &str {
        &self.ask.id
    }

    fn toggle(&mut self, label: String, cx: &mut Context<Self>) {
        let multi = self.ask.questions[self.current].multi_select;
        let picked = &mut self.picked[self.current];
        if let Some(ix) = picked.iter().position(|chosen| *chosen == label) {
            picked.remove(ix);
        } else if multi {
            picked.push(label);
        } else {
            *picked = vec![label];
            self.next(cx);
            return;
        }
        cx.notify();
    }

    /// Records a typed answer, then moves on — or sends every answer after
    /// the last question. Nothing picked and nothing typed declines it.
    fn next(&mut self, cx: &mut Context<Self>) {
        let typed = self.other.read(cx).text().trim().to_string();
        if !typed.is_empty() {
            self.picked[self.current] = vec![typed];
            self.other.update(cx, |other, cx| other.set_text("", cx));
        }
        if self.current + 1 < self.ask.questions.len() {
            self.current += 1;
            cx.notify();
        } else {
            cx.emit(Answered(std::mem::take(&mut self.picked)));
        }
    }

    fn previous(&mut self, cx: &mut Context<Self>) {
        self.current = self.current.saturating_sub(1);
        cx.notify();
    }

    fn render_question(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let question = &self.ask.questions[self.current];
        let total = self.ask.questions.len();
        let options: Vec<_> = question.options.iter().enumerate().map(|(ix, option)| self.render_option(ix, option, cx)).collect();
        let progress = div()
            .h(px(20.))
            .px_1p5()
            .flex()
            .items_center()
            .rounded(px(8.))
            .bg(theme.selected)
            .text_size(px(10.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.muted.opacity(0.6))
            .child(format!("{}/{total}", self.current + 1));
        div()
            .px_5()
            .py_3()
            .rounded_t(px(13.))
            .bg(gpui::rgba(0xffffff03))
            .border_b_1()
            .border_color(gpui::rgba(0xffffff0c))
            .child(
                div()
                    .mb_2()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.muted.opacity(0.55)).child(question.header.to_uppercase()))
                    .when(total > 1, |row| row.child(progress)),
            )
            .child(div().text_sm().text_color(theme.text.opacity(0.9)).child(question.question.clone()))
            .when(question.multi_select, |column| column.child(div().mt_1().text_xs().text_color(theme.muted.opacity(0.65)).child("Select one or more options.")))
            .child(div().mt_3().flex().flex_col().gap_1p5().children(options))
    }

    fn render_option(&self, ix: usize, option: &crate::session::AskOption, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme();
        let chosen = self.picked[self.current].contains(&option.label);
        let label = option.label.clone();
        let hint = if chosen {
            icon(Icon::Check, theme.primary).size(px(14.)).into_any_element()
        } else {
            div()
                .size(px(20.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .border_1()
                .border_color(gpui::rgba(0xffffff09))
                .bg(theme.background.opacity(0.35))
                .text_size(px(11.))
                .text_color(theme.muted.opacity(0.7))
                .child((ix + 1).to_string())
                .into_any_element()
        };
        div()
            .id(SharedString::from(format!("ask-option-{ix}")))
            .w_full()
            .px_3()
            .py_2()
            .flex()
            .items_center()
            .gap_3()
            .rounded(px(10.))
            .border_1()
            .cursor_pointer()
            .map(|row| if chosen {
                row.border_color(theme.primary.opacity(0.3)).bg(theme.primary.opacity(0.08)).text_color(theme.text)
            } else {
                row.border_color(gpui::transparent_black()).bg(gpui::rgba(0xffffff03)).text_color(theme.text.opacity(0.85)).hover(|row| row.border_color(gpui::rgba(0xffffff08)).bg(gpui::rgba(0xffffff04)))
            })
            .child(div().size(px(20.)).flex_none().flex().items_center().justify_center().child(hint))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(option.label.clone()))
                    .when_some(option.description.clone(), |column, description| column.child(div().text_xs().text_color(theme.muted).child(description))),
            )
            .on_click(cx.listener(move |panel, _, _, cx| panel.toggle(label.clone(), cx)))
            .into_any_element()
    }

    fn render_buttons(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let last = self.current + 1 == self.ask.questions.len();
        let label = match (last, self.ask.questions.len()) {
            (false, _) => "Next question",
            (true, 1) => "Submit answer",
            (true, _) => "Submit answers",
        };
        let pill = |id: &'static str| div().id(id).h(px(28.)).px_4().flex().items_center().rounded_full().text_sm().font_weight(FontWeight::MEDIUM).cursor_pointer();
        div()
            .flex()
            .gap_2()
            .when(self.current > 0, |row| {
                row.child(
                    pill("ask-previous")
                        .border_1()
                        .border_color(theme.input_border)
                        .bg(gpui::rgba(0xffffff0a))
                        .text_color(theme.text)
                        .hover(|button| button.bg(theme.hover))
                        .child("Previous")
                        .on_click(cx.listener(|panel, _, _, cx| panel.previous(cx))),
                )
            })
            .child(
                pill("ask-next")
                    .bg(theme.primary)
                    .text_color(theme.on_primary)
                    .hover(|button| button.bg(theme.primary.opacity(0.9)))
                    .child(label)
                    .on_click(cx.listener(|panel, _, _, cx| panel.next(cx))),
            )
    }
}

impl Render for AskPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let focused = self.other.focus_handle(cx).is_focused(window);
        div()
            .w_full()
            .rounded(px(14.))
            .border_1()
            .border_color(if focused { theme.primary.opacity(0.55) } else { theme.border })
            .bg(theme.card)
            .child(self.render_question(cx))
            .child(
                div()
                    .px(px(14.))
                    .py_2()
                    .flex()
                    .items_end()
                    .gap_2()
                    .child(div().flex_1().min_w_0().py_0p5().text_sm().line_height(relative(PROSE_LINE_HEIGHT)).text_color(theme.text).child(self.other.clone()))
                    .child(self.render_buttons(cx)),
            )
    }
}
