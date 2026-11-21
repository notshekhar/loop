//! How the drawer looks — Zed's terminal panel: the grab strip, a pane tab
//! bar with its actions, and the active tab's panes side by side or stacked.

use gpui::{
    AnyElement, Context, DispatchPhase, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Render,
    StatefulInteractiveElement, Styled, Window, canvas, div, prelude::FluentBuilder, px,
};

use super::actions::{CloseTerminal, NewTerminal, SplitTerminal, SplitTerminalVertical};
use super::drawer::{Drag, MAX_PANES, TerminalDrawer};
use crate::assets::Icon;
use crate::theme::ActiveTheme;
use crate::ui::controls::tooltip;
use crate::ui::icon::icon;

/// The grab strip along the drawer's top edge (`h-1.5`).
const RESIZE_HANDLE: Pixels = px(6.);
/// Zed's `Tab::container_height` and icon-button size.
const TAB_BAR_HEIGHT: Pixels = px(32.);
const TAB_MAX_WIDTH: Pixels = px(240.);
const CLOSE_SLOT: Pixels = px(16.);
const TOOL_SIZE: Pixels = px(24.);

impl TerminalDrawer {
    fn start_drag(&mut self, event: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.drag = Some(Drag { start_y: event.position.y, start_height: self.height });
        cx.stop_propagation();
    }

    /// While dragging, the whole window reports the pointer, so the drawer
    /// follows it over the conversation too.
    fn render_drag_tracker(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.drag.as_ref()?;
        let drawer = cx.entity().downgrade();
        Some(
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let moved = drawer.clone();
                    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                        if phase != DispatchPhase::Capture {
                            return;
                        }
                        let _ = moved.update(cx, |drawer, cx| {
                            let Some(drag) = &drawer.drag else { return };
                            // Dragging up makes the drawer taller.
                            drawer.height = TerminalDrawer::clamp_height(drag.start_height + (drag.start_y - event.position.y), window);
                            cx.notify();
                        });
                    });
                    let released = drawer.clone();
                    window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = released.update(cx, |drawer, cx| {
                                drawer.drag = None;
                                cx.notify();
                            });
                        }
                    });
                },
            )
            .absolute()
            .size_full()
            .into_any_element(),
        )
    }

    /// A Zed pane tab: the active one is open to the terminal below it
    /// (no bottom border), the rest sit on the bar; close shows on hover.
    fn render_tab(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let group = &self.groups[index];
        let active = self.active_group() == Some(index);
        let glyph = match (group.panes.len() > 1, group.vertical) {
            (false, _) => Icon::Terminal,
            (true, true) => Icon::SquareSplitVertical,
            (true, false) => Icon::SquareSplitHorizontal,
        };
        let label = self.tab_label(group, cx);
        let first = group.panes[0].clone();
        let hover_group = format!("terminal-tab-{index}");
        let color = if active { theme.text } else { theme.muted };
        let close = div()
            .id(("close-terminal-tab", index))
            .size(CLOSE_SLOT)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .cursor_pointer()
            .invisible()
            .group_hover(hover_group.clone(), |button| button.visible())
            .hover(|button| button.bg(theme.hover))
            .child(icon(Icon::X, theme.muted).size(px(12.)))
            .tooltip(tooltip("Close Terminal (⌘W)"))
            .on_click(cx.listener(move |drawer, _, window, cx| {
                drawer.close_group(index, cx);
                drawer.focus_active(window, cx);
            }));
        div()
            .id(("terminal-tab", index))
            .group(hover_group)
            .h_full()
            .flex_none()
            .max_w(TAB_MAX_WIDTH)
            .flex()
            .items_center()
            .gap_1()
            .pl_2()
            .pr_1()
            .border_r_1()
            .border_color(theme.border)
            .text_sm()
            .text_color(color)
            .map(|tab| if active { tab.bg(theme.card) } else { tab.border_b_1().hover(|tab| tab.bg(theme.hover)) })
            .cursor_pointer()
            .on_click(cx.listener(move |drawer, _, window, cx| drawer.activate(&first, window, cx)))
            .child(icon(glyph, color).size(px(14.)))
            .child(div().min_w_0().truncate().child(label))
            .child(close)
            .into_any_element()
    }

    /// A Zed ghost icon button.
    fn render_tool(&self, id: &'static str, glyph: Icon, hint: String, disabled: bool, cx: &mut Context<Self>, on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static) -> AnyElement {
        let theme = cx.theme();
        div()
            .id(id)
            .size(TOOL_SIZE)
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .map(|button| if disabled { button.opacity(0.4) } else { button.cursor_pointer().hover(|button| button.bg(theme.hover)) })
            .child(icon(glyph, theme.muted).size(px(14.)))
            .tooltip(tooltip(hint))
            .when(!disabled, |button| button.on_click(cx.listener(move |drawer, _, window, cx| on_click(drawer, window, cx))))
            .into_any_element()
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let full = self.active_group().is_some_and(|index| self.groups[index].panes.len() >= MAX_PANES);
        let split_hint = |direction: &str, keys: &str| if full { format!("Split {direction} (max {MAX_PANES} per tab)") } else { format!("Split {direction} ({keys})") };
        div()
            .h_full()
            .flex()
            .flex_none()
            .items_center()
            .gap_1()
            .px_1p5()
            .border_b_1()
            .border_color(theme.border)
            .child(self.render_tool("new-terminal", Icon::Plus, "New Terminal (⌘N)".into(), false, cx, |drawer, window, cx| drawer.on_new(&NewTerminal, window, cx)))
            .child(self.render_tool("split-terminal", Icon::SquareSplitHorizontal, split_hint("Right", "⌘D"), full, cx, |drawer, window, cx| drawer.on_split(&SplitTerminal, window, cx)))
            .child(self.render_tool("split-terminal-vertical", Icon::SquareSplitVertical, split_hint("Down", "⇧⌘D"), full, cx, |drawer, window, cx| drawer.on_split_vertical(&SplitTerminalVertical, window, cx)))
            .child(self.render_tool("close-terminal", Icon::Trash, "Close Terminal (⌘W)".into(), false, cx, |drawer, window, cx| drawer.on_close(&CloseTerminal, window, cx)))
            .into_any_element()
    }

    /// Zed's tab bar: tabs from the left, the empty rest of the bar ruled
    /// along its bottom, actions on the right.
    fn render_tab_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let tabs: Vec<AnyElement> = (0..self.groups.len()).map(|index| self.render_tab(index, cx)).collect();
        div()
            .h(TAB_BAR_HEIGHT)
            .flex_none()
            .flex()
            .bg(theme.selected)
            .child(div().id("terminal-tabs").h_full().flex().flex_none().max_w_3_4().overflow_x_scroll().children(tabs))
            .child(div().h_full().flex_1().border_b_1().border_color(theme.border))
            .child(self.render_toolbar(cx))
            .into_any_element()
    }

    /// The active tab's panes. As in Zed, only the cursor says which pane
    /// has the keys: solid there, hollow elsewhere.
    fn render_panes(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let Some(index) = self.active_group() else { return self.render_empty(cx) };
        let group = &self.groups[index];
        let panes = group.panes.iter().enumerate().map(|(position, pane)| {
            let clicked = pane.clone();
            div()
                .relative()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .when(position > 0, |cell| if group.vertical { cell.border_t_1() } else { cell.border_l_1() })
                .border_color(theme.border.opacity(0.6))
                .on_mouse_down(MouseButton::Left, cx.listener(move |drawer, _, _, cx| {
                    drawer.active = Some(clicked.entity_id());
                    cx.notify();
                }))
                .child(pane.clone())
        });
        div().flex_1().min_h_0().flex().when(group.vertical, |stack| stack.flex_col()).children(panes).into_any_element()
    }

    /// No shell: loop's "No terminal sessions" state, with the reason a
    /// shell failed to start when there is one.
    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let message = self.error.clone().unwrap_or_else(|| "No terminal sessions for this thread yet.".into());
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .text_sm()
            .text_color(theme.muted)
            .child(message)
            .child(
                div()
                    .id("first-terminal")
                    .px_3()
                    .py_1p5()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(theme.border.opacity(0.8))
                    .text_xs()
                    .text_color(theme.text)
                    .cursor_pointer()
                    .hover(|button| button.bg(theme.hover))
                    .child("New Terminal (⌘N)")
                    .on_click(cx.listener(|drawer, _, window, cx| drawer.open_tab(window, cx))),
            )
            .into_any_element()
    }
}

impl Render for TerminalDrawer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let body = if self.groups.is_empty() { self.render_empty(cx) } else { div().flex_1().min_h_0().flex().flex_col().child(self.render_tab_bar(cx)).child(self.render_panes(cx)).into_any_element() };
        div()
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::on_new))
            .on_action(cx.listener(Self::on_split))
            .on_action(cx.listener(Self::on_split_vertical))
            .on_action(cx.listener(Self::on_close))
            .relative()
            .flex_none()
            .h(self.height)
            .flex()
            .flex_col()
            .overflow_hidden()
            .border_t_1()
            .border_color(theme.border.opacity(0.8))
            .bg(theme.card)
            .child(body)
            .child(div().id("terminal-resize").absolute().top_0().left_0().right_0().h(RESIZE_HANDLE).cursor_row_resize().on_mouse_down(MouseButton::Left, cx.listener(Self::start_drag)))
            .children(self.render_drag_tracker(cx))
    }
}
