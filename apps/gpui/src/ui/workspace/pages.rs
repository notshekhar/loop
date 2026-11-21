//! The rail's pages other than Home.

use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, px, uniform_list,
};

use super::Workspace;
use crate::rpc::protocol::SessionRow;
use crate::theme::{ActiveTheme, CONVERSATION_WIDTH, LIST_ROW_HEIGHT};
use crate::threads::{folder_name, thread_title};
use crate::ui::format::{age, now_millis};
use crate::ui::rail::Page;

/// A thread as the Activity and Search pages list it: across projects.
#[derive(Clone)]
struct Listed {
    id: SharedString,
    title: SharedString,
    project: String,
    mtime: u64,
}

impl Listed {
    fn of(row: &SessionRow) -> Self {
        Self { id: row.id.clone().into(), title: thread_title(row), project: folder_name(&row.cwd).to_string(), mtime: row.mtime }
    }
}

impl Workspace {
    /// Every thread in every project, newest first, or those matching the
    /// search box on the Search page.
    fn listed(&self, cx: &gpui::App) -> Vec<Listed> {
        let query = if self.page == Page::Search { self.search.read(cx).text().to_lowercase() } else { String::new() };
        let mut rows: Vec<Listed> = self
            .store
            .read(cx)
            .projects
            .iter()
            .flat_map(|project| &project.threads)
            .map(Listed::of)
            .filter(|listed| query.split_whitespace().all(|word| listed.title.to_lowercase().contains(word) || listed.project.to_lowercase().contains(word)))
            .collect();
        rows.sort_by_key(|listed| std::cmp::Reverse(listed.mtime));
        rows
    }

    fn render_listed(rows: &[Listed], cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = cx.theme();
        let now = now_millis();
        rows.iter()
            .map(|listed| {
                let id = listed.id.clone();
                div()
                    .id(SharedString::from(format!("listed-{}", listed.id)))
                    .h(LIST_ROW_HEIGHT + px(8.))
                    .w_full()
                    .px_3()
                    .flex()
                    .items_center()
                    .gap_3()
                    .rounded(px(8.))
                    .text_sm()
                    .cursor_pointer()
                    .hover(|row| row.bg(theme.hover))
                    .child(div().flex_1().min_w_0().truncate().text_color(theme.text).child(listed.title.clone()))
                    .child(div().flex_none().text_color(theme.muted).child(listed.project.clone()))
                    .child(div().flex_none().w(px(36.)).text_xs().text_color(theme.muted).child(age(now, listed.mtime)))
                    .on_click(cx.listener(move |workspace, _, window, cx| {
                        workspace.page = Page::Home;
                        workspace.open_thread(id.clone(), window, cx);
                    }))
                    .into_any_element()
            })
            .collect()
    }

    pub(super) fn render_thread_list_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let rows = self.listed(cx);
        let count = rows.len();
        let searching = self.page == Page::Search;
        let list = uniform_list("listed-threads", count, cx.processor(move |_, range: std::ops::Range<usize>, _, cx| Self::render_listed(&rows[range], cx))).flex_1().min_h_0();
        div()
            .size_full()
            .flex()
            .justify_center()
            .px_6()
            .pt_6()
            .child(
                div()
                    .w_full()
                    .max_w(CONVERSATION_WIDTH)
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).text_color(theme.text).child(self.page.title()))
                    .child(if searching {
                        div().px_3().py_2().rounded(px(10.)).border_1().border_color(theme.input_border).text_sm().child(self.search.clone()).into_any_element()
                    } else {
                        div().text_sm().text_color(theme.muted).child(format!("{count} threads across every project")).into_any_element()
                    })
                    .child(list),
            )
            .into_any_element()
    }

    /// A page the GPUI app does not have yet (tracked in PARITY.md).
    pub(super) fn render_missing_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_1()
            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).text_color(theme.text).child(self.page.title()))
            .child(div().text_sm().text_color(theme.muted).child("Not in the GPUI app yet"))
            .into_any_element()
    }
}
