use std::ops::Range;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FontWeight, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window, anchored,
    deferred, div, prelude::FluentBuilder, px, uniform_list,
};

use crate::assets::Icon;
use crate::theme::{ActiveTheme, LIST_ROW_HEIGHT, SIDEBAR_WIDTH};
use crate::threads::{Project, ThreadStore, thread_title};
use crate::ui::controls::{menu, menu_row};
use crate::ui::format::{age, now_millis};
use crate::ui::icon::icon;

pub enum SidebarEvent {
    /// The user picked a thread.
    Open(SharedString),
    /// The user asked for a new thread in this folder.
    NewThreadIn(SharedString),
    /// "Add project": pick a folder and start a thread there.
    AddProject,
    /// "All activity": every project's threads.
    ShowActivity,
    Archive(SharedString),
}

/// loop's project sidebar: one project at a time (switched from its header),
/// its actions, and its recent threads.
pub struct Sidebar {
    store: Entity<ThreadStore>,
    /// The project being shown; the most recently used one until picked.
    project: Option<SharedString>,
    selected: Option<SharedString>,
    recent_collapsed: bool,
    project_menu_open: bool,
}

impl EventEmitter<SidebarEvent> for Sidebar {}

impl Sidebar {
    pub fn new(store: Entity<ThreadStore>, cx: &mut Context<Self>) -> Self {
        cx.observe(&store, |_, _, cx| cx.notify()).detach();
        Self { store, project: None, selected: None, recent_collapsed: false, project_menu_open: false }
    }

    /// Highlights a thread opened some other way, and shows its project.
    pub fn set_selected(&mut self, id: Option<SharedString>, cwd: Option<SharedString>, cx: &mut Context<Self>) {
        self.selected = id;
        if cwd.is_some() {
            self.project = cwd;
        }
        cx.notify();
    }

    pub fn project_cwd(&self, cx: &App) -> Option<SharedString> {
        self.current_project(cx).map(|project| project.cwd.clone())
    }

    fn current_project<'a>(&self, cx: &'a App) -> Option<&'a Project> {
        let projects = &self.store.read(cx).projects;
        self.project.as_ref().and_then(|cwd| projects.iter().find(|project| &project.cwd == cwd)).or(projects.first())
    }

    fn render_threads(&mut self, range: Range<usize>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = cx.theme();
        let now = now_millis();
        let Some(project) = self.current_project(cx).cloned() else { return Vec::new() };
        project.threads[range]
            .iter()
            .map(|thread| {
                let id: SharedString = thread.id.clone().into();
                let group: SharedString = format!("thread-{id}").into();
                let is_selected = self.selected.as_ref() == Some(&id);
                let (open_id, archive_id) = (id.clone(), id.clone());
                let trailing = if thread.running {
                    icon(Icon::Loader, theme.muted).size(px(13.)).into_any_element()
                } else {
                    div().text_xs().text_color(theme.muted).group_hover(group.clone(), |age| age.invisible()).child(age(now, thread.mtime)).into_any_element()
                };
                div()
                    .id(id.clone())
                    .group(group.clone())
                    .relative()
                    .h(LIST_ROW_HEIGHT)
                    .w_full()
                    .pl(px(14.))
                    .pr_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(px(8.))
                    .text_sm()
                    .text_color(theme.text)
                    .cursor_pointer()
                    .when(is_selected, |row| row.bg(theme.selected))
                    .hover(|row| row.bg(theme.hover))
                    .child(div().flex_1().min_w_0().truncate().child(thread_title(thread)))
                    .child(trailing)
                    .child(
                        div()
                            .id(SharedString::from(format!("archive-{id}")))
                            .absolute()
                            .right_2()
                            .p_0p5()
                            .rounded_sm()
                            .invisible()
                            .group_hover(group, |button| button.visible())
                            .hover(|button| button.bg(theme.hover))
                            .child(icon(Icon::Archive, theme.muted).size(px(14.)))
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.stop_propagation();
                                cx.emit(SidebarEvent::Archive(archive_id.clone()));
                            })),
                    )
                    .on_click(cx.listener(move |sidebar, _, _, cx| {
                        sidebar.selected = Some(open_id.clone());
                        cx.emit(SidebarEvent::Open(open_id.clone()));
                        cx.notify();
                    }))
                    .into_any_element()
            })
            .collect()
    }

    fn nav_row(&self, id: &'static str, glyph: Icon, label: &'static str, event: fn(&Self, &App) -> Option<SidebarEvent>, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .id(id)
            .h(px(30.))
            .px_2()
            .flex()
            .items_center()
            .gap_2()
            .rounded(px(8.))
            .text_sm()
            .text_color(theme.muted)
            .cursor_pointer()
            .hover(|row| row.bg(theme.hover).text_color(theme.text))
            .child(icon(glyph, theme.muted))
            .child(label)
            .on_click(cx.listener(move |sidebar, _, _, cx| {
                if let Some(event) = event(sidebar, cx) {
                    cx.emit(event);
                }
            }))
    }

    fn render_project_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let name = self.current_project(cx).map(|project| project.name().to_string()).unwrap_or_else(|| "No projects yet".into());
        div()
            .id("project-switcher")
            .h(px(32.))
            .px_2()
            .flex()
            .items_center()
            .gap_2()
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|row| row.bg(theme.hover))
            .child(icon(Icon::Folder, theme.muted))
            .child(div().flex_1().min_w_0().truncate().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme.text).child(name))
            .child(icon(Icon::ChevronsUpDown, theme.muted).size(px(14.)))
            .on_click(cx.listener(|sidebar, _, _, cx| {
                sidebar.project_menu_open = !sidebar.project_menu_open;
                cx.notify();
            }))
    }

    fn render_project_menu(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let current = self.project_cwd(cx);
        let projects: Vec<(SharedString, String, usize)> = self.store.read(cx).projects.iter().map(|project| (project.cwd.clone(), project.name().to_string(), project.threads.len())).collect();
        let entity = cx.entity().downgrade();
        menu(cx)
            .w(px(240.))
            .max_h(px(360.))
            .id("project-menu")
            .overflow_y_scroll()
            .children(projects.into_iter().map(|(cwd, name, _count)| {
                let selected = current.as_ref() == Some(&cwd);
                let entity = entity.clone();
                let pick = cwd.clone();
                menu_row(SharedString::from(format!("pick-{cwd}")), Some(icon(Icon::Folder, theme.muted).into_any_element()), name, selected, cx, move |_, _, cx| {
                    let pick = pick.clone();
                    let _ = entity.update(cx, |sidebar, cx| {
                        sidebar.project = Some(pick);
                        sidebar.project_menu_open = false;
                        cx.notify();
                    });
                })
            }))
    }

    fn render_recent_header(&self, count: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .id("recent-header")
            .mt_4()
            .mb_1()
            .px_2()
            .flex()
            .items_center()
            .gap_2()
            .cursor_pointer()
            .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme.muted).child("RECENT"))
            .child(div().text_xs().text_color(theme.muted).child(count.to_string()))
            .child(div().flex_1().h(px(1.)).bg(theme.divider))
            .child(icon(if self.recent_collapsed { Icon::ChevronRight } else { Icon::ChevronDown }, theme.muted).size(px(14.)))
            .on_click(cx.listener(|sidebar, _, _, cx| {
                sidebar.recent_collapsed = !sidebar.recent_collapsed;
                cx.notify();
            }))
    }
}

impl Render for Sidebar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let count = self.current_project(cx).map_or(0, |project| project.threads.len());
        let list = uniform_list("threads", if self.recent_collapsed { 0 } else { count }, cx.processor(|sidebar, range, _, cx| sidebar.render_threads(range, cx)))
            .flex_1()
            .min_h_0();
        div()
            .w(SIDEBAR_WIDTH)
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .px_2()
            .pb_2()
            .border_r_1()
            .border_color(theme.divider)
            .child(div().px_2().pt_4().pb_3().text_lg().font_weight(FontWeight::SEMIBOLD).text_color(theme.text).child("loop"))
            .child(
                div()
                    .relative()
                    .child(self.render_project_header(cx))
                    .when(self.project_menu_open, |header| {
                        header.child(
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .child(deferred(anchored().child(div().mt(px(34.)).child(self.render_project_menu(cx)))).with_priority(2)),
                        )
                    }),
            )
            .child(
                div()
                    .mt_1()
                    .flex()
                    .flex_col()
                    .child(self.nav_row("new-thread", Icon::Plus, "New thread", |sidebar, cx| sidebar.project_cwd(cx).map(SidebarEvent::NewThreadIn), cx))
                    .child(self.nav_row("add-project", Icon::FolderPlus, "Add project", |_, _| Some(SidebarEvent::AddProject), cx))
                    .child(self.nav_row("all-activity", Icon::Layers, "All activity", |_, _| Some(SidebarEvent::ShowActivity), cx)),
            )
            .child(self.render_recent_header(count, cx))
            .child(list)
    }
}
