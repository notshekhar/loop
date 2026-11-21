//! The terminal drawer (loop's ThreadTerminalDrawer, drawn like Zed's terminal
//! panel): a resizable strip under the thread with one
//! tab per group of panes (a split group is one tab), and split / new /
//! close on the right. Each thread keeps its own drawer, so its shells
//! and output survive switching away.

use gpui::{App, AppContext, Context, Entity, EntityId, EventEmitter, FocusHandle, Focusable, Pixels, SharedString, Subscription, Window, px};

use super::actions::{CloseTerminal, NewTerminal, SplitTerminal, SplitTerminalVertical};
use super::view::{TerminalEvent, TerminalView};
use crate::threads::folder_name;

/// Zed's terminal `default_height`; loop's `MIN_DRAWER_HEIGHT` and
/// `MAX_DRAWER_HEIGHT_RATIO`.
const DEFAULT_HEIGHT: Pixels = px(320.);
const MIN_HEIGHT: Pixels = px(180.);
const MAX_HEIGHT_RATIO: f32 = 0.75;
/// `MAX_TERMINALS_PER_GROUP`.
pub(super) const MAX_PANES: usize = 4;

pub enum DrawerEvent {
    /// The last terminal closed; the workspace hides the drawer.
    Emptied,
}

pub(super) struct Group {
    pub(super) panes: Vec<Entity<TerminalView>>,
    pub(super) vertical: bool,
}

pub(super) struct Drag {
    pub(super) start_y: Pixels,
    pub(super) start_height: Pixels,
}

pub struct TerminalDrawer {
    pub(super) cwd: String,
    pub(super) groups: Vec<Group>,
    pub(super) active: Option<EntityId>,
    pub(super) height: Pixels,
    pub(super) drag: Option<Drag>,
    /// Why the last shell failed to start.
    pub(super) error: Option<SharedString>,
    pub(super) focus: FocusHandle,
    _subscriptions: Vec<(EntityId, Subscription)>,
}

impl EventEmitter<DrawerEvent> for TerminalDrawer {}

impl TerminalDrawer {
    /// A drawer in `cwd`, opened on one terminal.
    pub fn new(cwd: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut drawer = Self { cwd, groups: Vec::new(), active: None, height: DEFAULT_HEIGHT, drag: None, error: None, focus: cx.focus_handle(), _subscriptions: Vec::new() };
        drawer.open_tab(window, cx);
        drawer
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    /// A tab's name: each pane's title, else the folder it started in.
    pub(super) fn tab_label(&self, group: &Group, cx: &App) -> String {
        let folder = match folder_name(&self.cwd) {
            "" => "terminal",
            name => name,
        };
        group.panes.iter().map(|pane| pane.read(cx).title().unwrap_or(folder).to_string()).collect::<Vec<_>>().join(" · ")
    }

    pub(super) fn active_group(&self) -> Option<usize> {
        let active = self.active?;
        self.groups.iter().position(|group| group.panes.iter().any(|pane| pane.entity_id() == active))
    }

    fn watch(&mut self, pane: &Entity<TerminalView>, cx: &mut Context<Self>) {
        let id = pane.entity_id();
        let subscription = cx.subscribe(pane, move |drawer, _, event, cx| match event {
            TerminalEvent::Exited => drawer.close(id, cx),
            TerminalEvent::TitleChanged => cx.notify(),
        });
        self._subscriptions.push((id, subscription));
    }

    pub(super) fn activate(&mut self, pane: &Entity<TerminalView>, window: &mut Window, cx: &mut Context<Self>) {
        self.active = Some(pane.entity_id());
        // A new pane isn't drawn until the next frame, and focus given to
        // something not yet drawn doesn't stick.
        let focus = pane.focus_handle(cx);
        cx.on_next_frame(window, move |_, window, cx| window.focus(&focus, cx));
        cx.notify();
    }

    fn start(&mut self, cx: &mut Context<Self>) -> Option<Entity<TerminalView>> {
        let cwd = self.cwd.clone();
        match TerminalView::start(&cwd) {
            Ok(started) => {
                self.error = None;
                let pane = cx.new(|cx| TerminalView::new(started, cx));
                self.watch(&pane, cx);
                Some(pane)
            }
            Err(error) => {
                eprintln!("loop-gpui: couldn't start a shell in {cwd}: {error:#}");
                self.error = Some(format!("Couldn't start a shell: {error}").into());
                cx.notify();
                None
            }
        }
    }

    pub fn open_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        eprintln!("DEBUG open_tab {}", std::backtrace::Backtrace::force_capture().to_string().lines().filter(|l| l.contains("loop_gpui")).take(6).collect::<Vec<_>>().join(" | "));
        let Some(pane) = self.start(cx) else { return };
        self.groups.push(Group { panes: vec![pane.clone()], vertical: false });
        self.activate(&pane, window, cx);
    }

    pub(super) fn split(&mut self, vertical: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.active_group() else { return self.open_tab(window, cx) };
        if self.groups[index].panes.len() >= MAX_PANES {
            return;
        }
        let Some(pane) = self.start(cx) else { return };
        let group = &mut self.groups[index];
        if group.panes.len() == 1 {
            group.vertical = vertical;
        }
        group.panes.push(pane.clone());
        self.activate(&pane, window, cx);
    }

    /// Closes one pane; its shell is hung up when the view drops.
    fn close(&mut self, id: EntityId, cx: &mut Context<Self>) {
        eprintln!("DEBUG close {id:?}");
        self._subscriptions.retain(|(pane, _)| *pane != id);
        for group in &mut self.groups {
            group.panes.retain(|pane| pane.entity_id() != id);
        }
        self.groups.retain(|group| !group.panes.is_empty());
        if self.active == Some(id) {
            self.active = self.groups.last().and_then(|group| group.panes.last()).map(|pane| pane.entity_id());
        }
        if self.groups.is_empty() {
            cx.emit(DrawerEvent::Emptied);
        }
        cx.notify();
    }

    pub(super) fn close_group(&mut self, index: usize, cx: &mut Context<Self>) {
        let ids: Vec<EntityId> = self.groups.get(index).map(|group| group.panes.iter().map(|pane| pane.entity_id()).collect()).unwrap_or_default();
        for id in ids {
            self.close(id, cx);
        }
    }

    /// Keys go to the pane last used.
    pub fn focus_active(&self, window: &mut Window, cx: &mut App) {
        let pane = self.groups.iter().flat_map(|group| &group.panes).find(|pane| Some(pane.entity_id()) == self.active);
        match pane {
            Some(pane) => window.focus(&pane.focus_handle(cx), cx),
            None => window.focus(&self.focus, cx),
        }
    }

    pub(super) fn on_new(&mut self, _: &NewTerminal, window: &mut Window, cx: &mut Context<Self>) {
        self.open_tab(window, cx);
    }

    pub(super) fn on_split(&mut self, _: &SplitTerminal, window: &mut Window, cx: &mut Context<Self>) {
        self.split(false, window, cx);
    }

    pub(super) fn on_split_vertical(&mut self, _: &SplitTerminalVertical, window: &mut Window, cx: &mut Context<Self>) {
        self.split(true, window, cx);
    }

    pub(super) fn on_close(&mut self, _: &CloseTerminal, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.active {
            self.close(id, cx);
            self.focus_active(window, cx);
        }
    }

    pub(super) fn clamp_height(height: Pixels, window: &Window) -> Pixels {
        let max = (window.viewport_size().height * MAX_HEIGHT_RATIO).max(MIN_HEIGHT);
        height.clamp(MIN_HEIGHT, max)
    }
}

impl Focusable for TerminalDrawer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
