//! The header's right side: usage, "Open", git, and loop's two panel
//! toggles pinned to the far right.

use gpui::{
    AnyElement, App, AppContext, Context, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, anchored, deferred, div, prelude::FluentBuilder, px,
};

use super::open_in::{OUTLINE_FILL, OUTLINE_HOVER};
use super::{GitState, Header, HeaderEvent};
use crate::assets::Icon;
use crate::git;
use crate::theme::{ActiveTheme, TOP_BAR_HEIGHT};
use crate::ui::controls::tooltip;
use crate::ui::icon::icon;

/// Room the panel toggles take at the right edge (loop's `pr-16`).
const PANEL_TOGGLES_ROOM: f32 = 64.;
/// Header popovers sit 6px under their trigger.
const POPOVER_GAP: f32 = 6.;

/// A trigger with its popover under it, left edges aligned.
pub(super) fn anchor_below(trigger: impl IntoElement, popover: Option<AnyElement>) -> AnyElement {
    anchor(trigger, popover, gpui::Anchor::TopLeft)
}

/// A trigger with its popover under it, right edges aligned.
pub(super) fn anchor_below_end(trigger: impl IntoElement, popover: Option<AnyElement>) -> AnyElement {
    anchor(trigger, popover, gpui::Anchor::TopRight)
}

fn anchor(trigger: impl IntoElement, popover: Option<AnyElement>, corner: gpui::Anchor) -> AnyElement {
    let end = corner == gpui::Anchor::TopRight;
    div()
        .relative()
        .child(trigger)
        .when_some(popover, |anchor, popover| {
            let pin = div().absolute().bottom_0().map(|pin| if end { pin.right_0() } else { pin.left_0() });
            anchor.child(pin.child(deferred(anchored().anchor(corner).child(div().mt(px(POPOVER_GAP)).child(popover))).with_priority(2)))
        })
        .into_any_element()
}

impl Header {
    pub(super) fn render_actions(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex_none()
            .flex()
            .items_center()
            .justify_end()
            .gap_2()
            .pr(px(PANEL_TOGGLES_ROOM))
            .children(self.render_insights(cx))
            .children(self.render_tree_trigger(cx))
            .children(self.render_open_in(cx))
            .children(self.render_git(cx))
            .into_any_element()
    }

    /// The Branches button: a branch icon, with the count of branch points
    /// once the tree has been read. Not for drafts.
    fn render_tree_trigger(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let session = self.target.view.as_ref()?.read(cx).session()?.read(cx).id.clone();
        let theme = cx.theme();
        let count = self.branch_points.get(&session).copied().filter(|count| *count > 0);
        Some(
            div()
                .id("session-tree")
                .px_1()
                .flex()
                .items_center()
                .gap_1p5()
                .rounded(px(6.))
                .text_xs()
                .text_color(theme.muted)
                .cursor_pointer()
                .hover(|trigger| trigger.text_color(theme.text))
                .child(icon(Icon::GitBranch, theme.muted))
                .when_some(count, |trigger, count| trigger.child(count.to_string()))
                .tooltip(tooltip("Session branches"))
                .on_click(cx.listener(|header, _, window, cx| header.open_tree(window, cx)))
                .into_any_element(),
        )
    }

    /// Learns, off the main thread, whether `cwd` is a git repository.
    pub(super) fn check_git(&mut self, cwd: String, cx: &mut Context<Self>) {
        if self.git.contains_key(&cwd) {
            return;
        }
        self.git.insert(cwd.clone(), GitState::Checking);
        cx.spawn(async move |this, cx| {
            let folder = cwd.clone();
            let repo = cx.background_spawn(async move { git::is_repo(&folder) }).await;
            this.update(cx, |header, cx| {
                header.git.insert(cwd, if repo { GitState::Repo } else { GitState::NotRepo });
                cx.notify();
            })
        })
        .detach();
    }

    fn init_git(&mut self, cwd: String, cx: &mut Context<Self>) {
        self.git.insert(cwd.clone(), GitState::Initializing);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let folder = cwd.clone();
            let result = cx.background_spawn(async move { git::init(&folder) }).await;
            this.update(cx, |header, cx| {
                if let Err(error) = &result {
                    eprintln!("loop-gpui: git init failed in {cwd}: {error:#}");
                }
                header.git.insert(cwd, if result.is_ok() { GitState::Repo } else { GitState::NotRepo });
                cx.notify();
            })
        })
        .detach();
    }

    /// "Initialize Git" in a folder that is not a repository. A repository's
    /// commit/push actions come with the git panel.
    fn render_git(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let cwd = self.cwd(cx)?;
        let state = *self.git.get(&cwd)?;
        if matches!(state, GitState::Repo | GitState::Checking) {
            return None;
        }
        let theme = cx.theme();
        let initializing = state == GitState::Initializing;
        Some(
            div()
                .id("init-git")
                .h(px(24.))
                .px_2()
                .flex()
                .items_center()
                .gap_0p5()
                .rounded(px(8.))
                .border_1()
                .border_color(theme.input_border)
                .bg(gpui::rgba(OUTLINE_FILL))
                .text_xs()
                .text_color(theme.text)
                .map(|button| if initializing { button.opacity(0.64) } else { button.cursor_pointer().hover(|button| button.bg(gpui::rgba(OUTLINE_HOVER))) })
                .child(div().mr_1().child(icon(Icon::GitBranchPlus, theme.text).size(px(14.))))
                .child(if initializing { "Initializing..." } else { "Initialize Git" })
                .when(!initializing, |button| button.on_click(cx.listener(move |header, _, _, cx| header.init_git(cwd.clone(), cx))))
                .into_any_element(),
        )
    }

    /// loop's PanelLayoutControls: the terminal drawer, and the right
    /// panel (still to come here, so it shows disabled).
    pub(super) fn render_panel_toggles(&self, cx: &mut Context<Self>) -> AnyElement {
        let terminal = match self.target.terminal_open {
            Some(open) => panel_toggle("toggle-terminal", Icon::PanelBottom, Some(open), "Toggle terminal drawer (⌘J)", cx).on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::ToggleTerminal))),
            None => panel_toggle("toggle-terminal", Icon::PanelBottom, None, "Terminal drawer is unavailable", cx),
        };
        div()
            .absolute()
            .top_0()
            .right_3()
            .h(TOP_BAR_HEIGHT)
            .flex()
            .items_center()
            .gap_1()
            .child(terminal)
            .child(panel_toggle("toggle-right-panel", Icon::PanelRight, None, "Right panel (⌘⌥B) isn't in the GPUI app yet", cx))
            .into_any_element()
    }
}

/// A ghost toggle: `Some(pressed)` when it can be used, None when disabled.
fn panel_toggle(id: &'static str, glyph: Icon, pressed: Option<bool>, hint: &'static str, cx: &App) -> gpui::Stateful<gpui::Div> {
    let theme = cx.theme();
    let color = if pressed.is_some() { theme.text } else { theme.muted };
    div()
        .id(id)
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .when(pressed == Some(true), |toggle| toggle.bg(theme.hover))
        .when(pressed.is_some(), |toggle| toggle.cursor_pointer().hover(|toggle| toggle.bg(theme.hover)))
        .child(icon(glyph, color).size(px(14.)).opacity(0.8))
        .tooltip(tooltip(hint))
}
