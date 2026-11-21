//! The small controls loop's chrome is made of, shared by every view.

use gpui::{
    AnyView, App, AppContext, BoxShadow, ClickEvent, Context, Div, ElementId, FontWeight, Hsla,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString, Stateful,
    StatefulInteractiveElement, Styled, Window, div, hsla, point, prelude::FluentBuilder, px,
};

use crate::assets::Icon;
use crate::theme::ActiveTheme;
use crate::ui::icon::icon;

/// A square icon button, as in the top bar and the rail.
pub fn icon_button(id: impl Into<ElementId>, glyph: Icon, active: bool, size: gpui::Pixels, cx: &App) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .size(size)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .cursor_pointer()
        .when(active, |button| button.bg(theme.rail_active))
        .hover(|button| button.bg(theme.hover))
        .child(icon(glyph, if active { theme.text } else { theme.muted }))
}

/// A small ghost button holding one 12px icon: copy, dismiss, expand.
pub fn ghost_icon_button(id: impl Into<ElementId>, glyph: Icon, cx: &App) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .size(px(24.))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .cursor_pointer()
        .hover(|button| button.bg(theme.hover))
        .child(icon(glyph, theme.muted).size(px(12.)))
}

/// A composer trigger (loop's `ComposerControl`): 24px, 12px medium text,
/// an optional 14px icon, and a 12px chevron.
pub fn menu_button(id: impl Into<ElementId>, leading: Option<gpui::AnyElement>, label: impl Into<gpui::SharedString>, open: bool, cx: &App) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .h(px(24.))
        .px_2()
        .flex()
        .flex_none()
        .items_center()
        .gap_1p5()
        .rounded(px(8.))
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(if open { theme.text.opacity(0.8) } else { theme.muted.opacity(0.7) })
        .cursor_pointer()
        .when(open, |button| button.bg(theme.hover))
        .hover(|button| button.bg(theme.hover).text_color(theme.text.opacity(0.8)))
        .children(leading)
        .child(label.into())
        .child(div().mx(px(-2.)).child(icon(Icon::ChevronDown, theme.muted.opacity(0.7)).size(px(12.))))
}

/// loop's `.dropdown-glass`: every menu and picker floats on this.
pub fn popover(cx: &App) -> Div {
    let theme = cx.theme();
    div()
        .flex()
        .flex_col()
        .rounded(px(10.))
        .border_1()
        .border_color(theme.popover_border)
        .bg(theme.popover)
        .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.8), offset: point(px(0.), px(18.)), blur_radius: px(44.), spread_radius: px(-18.), inset: false }])
        .overflow_hidden()
}

/// A menu: the glass card with loop's 4px inner padding.
pub fn menu(cx: &App) -> Div {
    popover(cx).p_1().min_w(px(128.))
}

/// One clickable row of a menu: 28px, 14px text, a check when picked.
pub fn menu_row(
    id: impl Into<ElementId>,
    leading: Option<gpui::AnyElement>,
    label: impl Into<gpui::SharedString>,
    selected: bool,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .min_h(px(28.))
        .px_2()
        .py_1()
        .flex()
        .items_center()
        .gap_2()
        .rounded(px(6.))
        .text_sm()
        .text_color(theme.text)
        .cursor_pointer()
        .when(selected, |row| row.bg(theme.checked))
        .hover(|row| row.bg(theme.hover))
        .children(leading)
        .child(div().flex_1().truncate().child(label.into()))
        .when(selected, |row| row.child(icon(Icon::Check, theme.muted).size(px(14.))))
        .on_click(on_click)
}

/// The thin rule between groups of composer controls.
pub fn vertical_divider(color: Hsla) -> Div {
    div().w(px(1.)).h(px(16.)).mx_0p5().bg(color)
}

/// loop's tooltip: 12px text on the popover colour, 8px corners.
struct Tooltip(SharedString);

impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .px_2()
            .py_1()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(gpui::rgb(0x212121))
            .font_family(theme.ui_font)
            .text_xs()
            .text_color(theme.text)
            .child(self.0.clone())
    }
}

/// For `.tooltip(...)`: a tooltip saying `text`.
pub fn tooltip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| cx.new(|_| Tooltip(text.clone())).into()
}
