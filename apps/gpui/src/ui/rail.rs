use gpui::{App, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div, px};

use crate::assets::Icon;
use crate::theme::RAIL_WIDTH;
use crate::ui::controls::icon_button;

/// The pages the rail switches between, top to bottom as loop orders them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Home,
    Search,
    Insights,
    Activity,
    SourceControl,
    Settings,
}

impl Page {
    const TOP: [Page; 5] = [Page::Home, Page::Search, Page::Insights, Page::Activity, Page::SourceControl];

    fn icon(self) -> Icon {
        match self {
            Page::Home => Icon::House,
            Page::Search => Icon::Search,
            Page::Insights => Icon::ChartColumn,
            Page::Activity => Icon::Layers,
            Page::SourceControl => Icon::GitPullRequest,
            Page::Settings => Icon::Settings,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Page::Home => "Home",
            Page::Search => "Search",
            Page::Insights => "Insights",
            Page::Activity => "All activity",
            Page::SourceControl => "Source control",
            Page::Settings => "Settings",
        }
    }
}

/// The app rail on the far left: loop's pages, settings at the bottom.
pub fn rail(active: Page, on_pick: impl Fn(Page, &mut Window, &mut App) + Clone + 'static, cx: &App) -> impl IntoElement {
    let item = |page: Page| {
        let on_pick = on_pick.clone();
        icon_button(page.title(), page.icon(), page == active, px(36.), cx).on_click(move |_, window, cx| on_pick(page, window, cx))
    };
    div()
        .w(RAIL_WIDTH)
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .items_center()
        .justify_between()
        .pt_1()
        .pb_2()
        .child(div().flex().flex_col().items_center().gap_2().children(Page::TOP.map(item)))
        .child(item(Page::Settings))
}
