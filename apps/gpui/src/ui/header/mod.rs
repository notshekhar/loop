//! loop's chat header (ChatView's `workspace-topbar` + ChatHeader): the
//! sidebar toggle, `project / title`, then the thread's usage, "Open", git,
//! and the panel toggles.

mod actions;
mod insights;
mod open_in;
mod tree_dialog;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui::{
    App, AppContext, Context, Entity, EventEmitter, FontWeight, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    WindowControlArea, div, px,
};

use crate::actions::ToggleSidebar;
use crate::assets::Icon;
use crate::editors::{self, Installed};
use crate::prefs::{self, Prefs};
use crate::theme::{ActiveTheme, RAIL_WIDTH, SIDEBAR_WIDTH, TOP_BAR_HEIGHT, TRAFFIC_LIGHT_PADDING};
use crate::threads::{ThreadStore, folder_name, thread_title};
use crate::ui::controls::{icon_button, tooltip};
use crate::ui::conversation::ConversationView;
use crate::ui::icon::icon;
use tree_dialog::{TreeDialog, TreeDialogEvent};

/// The header's side padding (`sm:px-5`).
const SIDE_PADDING: f32 = 20.;
/// The sidebar toggle is a 28px control.
const CONTROL_SIZE: f32 = 28.;
/// A click on a menu's own trigger lands just after the outside-click that
/// closed it; within this window it must not reopen the menu.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

pub enum HeaderEvent {
    NewThreadIn(SharedString),
    /// A fork from the Branches dialog: open it, the prompt back in its
    /// composer.
    OpenForked { session_id: String, prompt: Option<String> },
    ToggleTerminal,
}

#[derive(Clone, Copy, PartialEq)]
enum Menu {
    Insights,
    OpenIn,
}

#[derive(Clone, Copy, PartialEq)]
enum GitState {
    /// Being asked; says nothing until it knows.
    Checking,
    Repo,
    NotRepo,
    Initializing,
}

/// What the header describes; the workspace sets it every frame.
#[derive(Clone, PartialEq)]
pub struct Target {
    pub view: Option<Entity<ConversationView>>,
    /// A rail page other than Home names itself instead of a thread.
    pub page_title: Option<&'static str>,
    pub sidebar_open: bool,
    /// The thread's terminal drawer: None when there's no thread to hold one.
    pub terminal_open: Option<bool>,
}

pub struct Header {
    store: Entity<ThreadStore>,
    target: Target,
    menu: Option<Menu>,
    dismissed: Option<(Menu, Instant)>,
    editors: Installed,
    prefs: Prefs,
    git: HashMap<String, GitState>,
    /// Repaints when the thread on screen changes (title, usage, running).
    _view_changed: Option<Subscription>,
    /// The Branches dialog, while open.
    tree: Option<Entity<TreeDialog>>,
    /// Branch points per session, learnt when its tree was last read.
    branch_points: HashMap<String, usize>,
}

impl EventEmitter<HeaderEvent> for Header {}

impl Header {
    pub fn new(store: Entity<ThreadStore>, cx: &mut Context<Self>) -> Self {
        cx.observe(&store, |_, _, cx| cx.notify()).detach();
        // Asking the login shell for every editor takes a moment.
        cx.spawn(async move |this, cx| {
            let installed = cx.background_spawn(async { editors::detect() }).await;
            this.update(cx, |header, cx| {
                header.editors = installed;
                cx.notify();
            })
        })
        .detach();
        let prefs = prefs::default_path().map(|path| Prefs::load(&path)).unwrap_or_default();
        Self { store, target: Target { view: None, page_title: None, sidebar_open: true, terminal_open: None }, menu: None, dismissed: None, editors: Installed::default(), prefs, git: HashMap::new(), _view_changed: None, tree: None, branch_points: HashMap::new() }
    }

    pub fn set_target(&mut self, target: Target, cx: &mut Context<Self>) {
        if self.target == target {
            return;
        }
        let switched = self.target.view != target.view || self.target.page_title != target.page_title;
        self.target = target;
        if switched {
            self.on_switched(cx);
        }
        cx.notify();
    }

    /// A different thread or page: menus close, and the git check and
    /// repaint follow the new view.
    fn on_switched(&mut self, cx: &mut Context<Self>) {
        // The folder can arrive after the thread does (it loads), so the
        // git check runs whenever the view changes, not only on switching.
        self._view_changed = self.target.view.as_ref().map(|view| {
            cx.observe(view, |header, _, cx| {
                if let Some(cwd) = header.cwd(cx) {
                    header.check_git(cwd, cx);
                }
                cx.notify();
            })
        });
        self.menu = None;
        self.tree = None;
        if let Some(cwd) = self.cwd(cx) {
            self.check_git(cwd, cx);
        }
    }

    fn cwd(&self, cx: &App) -> Option<String> {
        self.target.view.as_ref().map(|view| view.read(cx).cwd().to_string()).filter(|cwd| !cwd.is_empty())
    }

    fn toggle_menu(&mut self, menu: Menu, cx: &mut Context<Self>) {
        let just_closed = self.dismissed.is_some_and(|(closed, at)| closed == menu && at.elapsed() < REOPEN_GUARD);
        self.menu = if self.menu == Some(menu) || just_closed { None } else { Some(menu) };
        cx.notify();
    }

    fn dismiss_menu(&mut self, cx: &mut Context<Self>) {
        if let Some(menu) = self.menu.take() {
            self.dismissed = Some((menu, Instant::now()));
            cx.notify();
        }
    }

    /// The left inset: past the rail and sidebar when it is open, else past
    /// the traffic lights and the toggle.
    fn left_inset(&self) -> gpui::Pixels {
        if self.target.sidebar_open { RAIL_WIDTH + SIDEBAR_WIDTH + px(SIDE_PADDING) } else { TRAFFIC_LIGHT_PADDING + px(CONTROL_SIZE + 12.) }
    }

    fn open_tree(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(view) = &self.target.view else { return };
        let Some(session) = view.read(cx).session().cloned() else { return };
        let cwd = self.cwd(cx).unwrap_or_default();
        let session_id = session.read(cx).id.clone();
        let dialog = cx.new(|cx| TreeDialog::new(session, cwd, window, cx));
        cx.subscribe(&dialog, move |header, _, event: &TreeDialogEvent, cx| {
            match event {
                TreeDialogEvent::Close => header.tree = None,
                TreeDialogEvent::Loaded(count) => {
                    header.branch_points.insert(session_id.clone(), *count);
                }
                TreeDialogEvent::Forked { session_id, prompt } => {
                    header.tree = None;
                    cx.emit(HeaderEvent::OpenForked { session_id: session_id.clone(), prompt: prompt.clone() });
                }
            }
            cx.notify();
        })
        .detach();
        self.tree = Some(dialog);
        cx.notify();
    }

    /// The Branches dialog over a dimmed window; a click outside closes it.
    fn render_tree_overlay(&self, window: &Window, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let dialog = self.tree.clone()?;
        let size = window.viewport_size();
        Some(
            gpui::deferred(
                gpui::anchored().position(gpui::point(px(0.), px(0.))).child(
                    div()
                        .id("tree-backdrop")
                        .w(size.width)
                        .h(size.height)
                        .flex()
                        .items_center()
                        .justify_center()
                        .p_6()
                        .bg(gpui::hsla(0., 0., 0., 0.5))
                        .on_mouse_down(gpui::MouseButton::Left, cx.listener(|header, _, _, cx| {
                            header.tree = None;
                            cx.notify();
                        }))
                        .child(dialog),
                ),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }

    fn render_sidebar_toggle(&self, cx: &App) -> gpui::AnyElement {
        let open = self.target.sidebar_open;
        div().absolute().top_0().left(TRAFFIC_LIGHT_PADDING).h(TOP_BAR_HEIGHT).flex().items_center().child(
            icon_button("toggle-sidebar", if open { Icon::PanelLeftClose } else { Icon::PanelLeft }, false, px(CONTROL_SIZE), cx)
                .tooltip(tooltip("Toggle main sidebar (⌘B)"))
                .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleSidebar), cx)),
        )
        .into_any_element()
    }

    /// `📁 project / title`: the project starts a new thread in it.
    fn render_crumbs(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme();
        let view = self.target.view.as_ref().map(|view| view.read(cx));
        let cwd = view.map(|view| view.cwd().to_string()).filter(|cwd| !cwd.is_empty());
        let title: SharedString = match (self.target.page_title, view) {
            (Some(page), _) => page.into(),
            (None, Some(view)) => view.session_id(cx).and_then(|id| self.store.read(cx).find(&id).map(thread_title)).unwrap_or_else(|| "New thread".into()),
            (None, None) => SharedString::default(),
        };
        let project = cwd.filter(|_| self.target.page_title.is_none()).map(|cwd| {
            let name = folder_name(&cwd).to_string();
            let target = SharedString::from(cwd);
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .id("project-crumb")
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .rounded(px(6.))
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.muted)
                        .cursor_pointer()
                        .hover(|crumb| crumb.text_color(theme.text))
                        .child(icon(Icon::Folder, theme.muted.opacity(0.5)).size(px(14.)))
                        .child(div().max_w(px(160.)).truncate().child(name.clone()))
                        .tooltip(tooltip(format!("New thread in {name}")))
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(HeaderEvent::NewThreadIn(target.clone())))),
                )
                .child(div().text_color(theme.muted.opacity(0.4)).child("/"))
        });
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .gap_3()
            .overflow_hidden()
            .children(project)
            .child(
                div()
                    .id("thread-title")
                    .flex_1()
                    .min_w(px(96.))
                    .truncate()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(title.clone())
                    .tooltip(tooltip(title)),
            )
            .into_any_element()
    }
}

impl Render for Header {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let overlay = self.render_tree_overlay(window, cx);
        let actions = self.render_actions(cx);
        let toggle = self.render_sidebar_toggle(cx);
        let crumbs = self.render_crumbs(cx);
        let panels = self.render_panel_toggles(cx);
        div()
            .window_control_area(WindowControlArea::Drag)
            .relative()
            .h(TOP_BAR_HEIGHT)
            .flex_none()
            .flex()
            .items_center()
            .child(toggle)
            .child(
                div()
                    .size_full()
                    .pl(self.left_inset())
                    .pr(px(SIDE_PADDING))
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(crumbs)
                    .child(actions),
            )
            .child(panels)
            .children(overlay)
    }
}
