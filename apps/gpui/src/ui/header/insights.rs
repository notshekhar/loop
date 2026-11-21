//! loop's SessionInsights: a context ring and the thread's cost, opening
//! to the context breakdown, the cost, and "Compact context".

use gpui::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Transformation, div, percentage,
    prelude::FluentBuilder, px, relative,
};
use gpui::{Animation, AnimationExt};

use super::{Header, Menu};
use crate::assets::Icon;
use crate::insights::{ContextReport, SessionCost, format_tokens, format_usd};
use crate::session::Session;
use crate::theme::ActiveTheme;
use crate::ui::controls::popover;
use crate::ui::icon::icon;
use crate::ui::ring::context_ring;

/// The popover's width and its stacked padding (12px popup + 16px body).
const WIDTH: f32 = 320.;
const PADDING: f32 = 28.;

impl Header {
    fn session(&self, cx: &gpui::App) -> Option<Entity<Session>> {
        self.target.view.as_ref()?.read(cx).session().cloned()
    }

    /// Nothing for a draft: no context and no spend to report yet.
    pub(super) fn render_insights(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.theme();
        let session = self.session(cx)?;
        let insights = session.read(cx).insights.clone();
        let leading = match &insights.context {
            Some(report) => context_ring(report.fraction(), theme.border, if report.warn() { theme.warning } else { theme.muted.opacity(0.7) }).into_any_element(),
            None => icon(Icon::Gauge, theme.muted).into_any_element(),
        };
        let trigger = div()
            .id("session-insights")
            .px_1()
            .flex()
            .items_center()
            .gap_1p5()
            .rounded(px(6.))
            .text_xs()
            .text_color(theme.muted)
            .cursor_pointer()
            .hover(|trigger| trigger.text_color(theme.text))
            .child(leading)
            .when_some(insights.cost.as_ref(), |trigger, cost| trigger.child(format_usd(cost.usd, cost.estimated)))
            .on_click(cx.listener(|header, _, _, cx| header.toggle_menu(Menu::Insights, cx)));
        let popover = (self.menu == Some(Menu::Insights)).then(|| self.render_insights_popover(&session, cx));
        Some(super::actions::anchor_below(trigger, popover))
    }

    fn render_insights_popover(&self, session: &Entity<Session>, cx: &mut Context<Self>) -> AnyElement {
        let state = session.read(cx);
        let (insights, running, compacting, note) = (state.insights.clone(), state.running(), state.compacting, state.compact_note.clone());
        let session = session.clone();
        let theme = cx.theme();
        let section = || div().mt_3().pt_3().border_t_1().border_color(theme.border.opacity(0.6));
        popover(cx)
            .w(px(WIDTH))
            .p(px(PADDING))
            .on_mouse_down_out(cx.listener(|header, _, _, cx| header.dismiss_menu(cx)))
            .child(match &insights.context {
                Some(report) => render_context(report, cx),
                None => div().text_xs().text_color(theme.muted).child("This loop does not report a context breakdown.").into_any_element(),
            })
            .when_some(insights.cost.as_ref(), |card, cost| card.child(section().child(render_cost(cost, cx))))
            .child(section().child(render_compact(session, running, compacting, note, cx)))
            .into_any_element()
    }
}

fn row(label: impl IntoElement, value: impl IntoElement) -> gpui::Div {
    div().flex().items_baseline().justify_between().gap_2().child(label).child(value)
}

fn render_context(report: &ContextReport, cx: &Context<Header>) -> AnyElement {
    let theme = cx.theme();
    let totals = if report.context_window > 0 { format!("{} / {}", format_tokens(report.total_tokens), format_tokens(report.context_window)) } else { format_tokens(report.total_tokens) };
    let used = report.categories.iter().filter(|category| category.tokens > 0);
    let tools = format!(
        "{} tool{}{}",
        report.tool_count,
        if report.tool_count == 1 { "" } else { "s" },
        if report.mcp_tool_count > 0 { format!(" ({} from MCP)", report.mcp_tool_count) } else { String::new() }
    );
    div()
        .child(row(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme.text).child("Context"), div().text_xs().text_color(theme.muted).child(totals)))
        .child(match report.fraction() {
            Some(fraction) => {
                let mut summary = format!("{}% used", (fraction * 100.).round());
                if report.auto_compact_threshold > 0. {
                    summary.push_str(&format!(" · loop compacts at {}%", (report.auto_compact_threshold * 100.).round()));
                }
                div()
                    .mt_2()
                    .child(category_bar(report, cx))
                    .child(div().mt_1().text_xs().text_color(if report.warn() { theme.warning } else { theme.muted }).child(summary))
                    .into_any_element()
            }
            None => div().mt_1().text_xs().text_color(theme.muted).child(format!("loop does not know {}'s context window.", report.model_id)).into_any_element(),
        })
        .child(div().mt_3().flex().flex_col().gap_0p5().children(used.map(|category| {
            row(div().min_w_0().truncate().text_xs().text_color(theme.muted).child(category.label.clone()), div().flex_none().text_xs().text_color(theme.muted.opacity(0.7)).child(format_tokens(category.tokens)))
        })))
        .child(div().mt_2().text_xs().text_color(theme.muted.opacity(0.6)).child(tools))
        .into_any_element()
}

/// The window split by category, alternating two greys.
fn category_bar(report: &ContextReport, cx: &Context<Header>) -> impl IntoElement {
    let theme = cx.theme();
    let window = report.context_window as f32;
    div().h(px(6.)).flex().overflow_hidden().rounded_full().bg(theme.selected).children(report.categories.iter().filter(|category| category.tokens > 0).enumerate().map(|(ix, category)| {
        let share = (category.tokens as f32 / window).max(0.005);
        div().h_full().w(relative(share)).bg(if ix % 2 == 0 { theme.muted.opacity(0.6) } else { theme.muted.opacity(0.35) })
    }))
}

fn render_cost(cost: &SessionCost, cx: &Context<Header>) -> AnyElement {
    let theme = cx.theme();
    div()
        .child(row(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme.text).child("Cost"), div().text_sm().text_color(theme.text).child(format_usd(cost.usd, cost.estimated))))
        .child(div().mt_1().text_xs().text_color(theme.muted).child(format!(
            "{} in · {} out · {} cached",
            format_tokens(cost.input_tokens),
            format_tokens(cost.output_tokens),
            format_tokens(cost.cached_input_tokens)
        )))
        .when(cost.estimated, |card| card.child(div().mt_1().text_xs().text_color(theme.muted.opacity(0.6)).child("Includes an estimate for an interrupted turn.")))
        .into_any_element()
}

fn render_compact(session: Entity<Session>, running: bool, compacting: bool, note: Option<SharedString>, cx: &Context<Header>) -> AnyElement {
    let theme = cx.theme();
    let disabled = running || compacting;
    let glyph = if compacting {
        icon(Icon::Loader, theme.text)
            .size(px(14.))
            .with_animation("compacting", Animation::new(std::time::Duration::from_secs(1)).repeat(), |glyph, delta| glyph.with_transformation(Transformation::rotate(percentage(delta))))
            .into_any_element()
    } else {
        icon(Icon::Scissors, theme.text).size(px(14.)).into_any_element()
    };
    let help = if running { "Not while a turn is running." } else { "Summarizes the older conversation and keeps the most recent part word for word." };
    div()
        .child(
            div()
                .id("compact-context")
                .h(px(32.))
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .gap_2()
                .rounded(px(8.))
                .border_1()
                .border_color(theme.input_border)
                .bg(gpui::rgba(0xffffff0a))
                .text_sm()
                .text_color(theme.text)
                .map(|button| if disabled { button.opacity(0.64) } else { button.cursor_pointer().hover(|button| button.bg(gpui::rgba(0xffffff14))) })
                .child(glyph)
                .child(if compacting { "Compacting…" } else { "Compact context" })
                .when(!disabled, |button| button.on_click(move |_, _, cx| session.update(cx, |session, cx| session.compact(cx)))),
        )
        .child(div().mt_1p5().text_xs().text_color(theme.muted.opacity(0.6)).child(help))
        .when_some(note, |card, note| card.child(div().mt_1p5().text_xs().text_color(theme.error).child(note)))
        .into_any_element()
}
