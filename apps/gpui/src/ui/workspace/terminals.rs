//! Each thread's terminal drawer: made on first ⌘J, kept while the thread
//! is open elsewhere, hidden — not killed — by the next ⌘J.

use std::collections::{HashMap, HashSet};

use gpui::{AppContext, Context, Entity, EntityId, Focusable, Window};

use super::Workspace;
use crate::actions::ToggleTerminal;
use crate::ui::rail::Page;
use crate::ui::terminal::{DrawerEvent, TerminalDrawer};

#[derive(Default)]
pub(super) struct Drawers {
    by_view: HashMap<EntityId, Entity<TerminalDrawer>>,
    open: HashSet<EntityId>,
}

impl Drawers {
    pub(super) fn is_open(&self, view: EntityId) -> bool {
        self.open.contains(&view)
    }

    /// The drawer to draw under `view`, when it's open.
    pub(super) fn shown(&self, view: EntityId) -> Option<Entity<TerminalDrawer>> {
        self.open.contains(&view).then(|| self.by_view.get(&view).cloned()).flatten()
    }

    /// Drops a thread's drawer, hanging up its shells.
    pub(super) fn remove(&mut self, view: EntityId) {
        self.by_view.remove(&view);
        self.open.remove(&view);
    }
}

impl Workspace {
    pub(super) fn on_toggle_terminal(&mut self, _: &ToggleTerminal, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_terminal(window, cx);
    }

    pub fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page != Page::Home {
            return;
        }
        let Some(view) = self.active.clone() else { return };
        let id = view.entity_id();
        if self.drawers.open.remove(&id) {
            window.focus(&view.focus_handle(cx), cx);
        } else {
            self.open_drawer(&view, window, cx);
        }
        cx.notify();
    }

    fn open_drawer(&mut self, view: &Entity<crate::ui::conversation::ConversationView>, window: &mut Window, cx: &mut Context<Self>) {
        let id = view.entity_id();
        let drawer = match self.drawers.by_view.get(&id) {
            Some(drawer) => {
                if drawer.read(cx).is_empty() {
                    drawer.update(cx, |drawer, cx| drawer.open_tab(window, cx));
                }
                drawer.clone()
            }
            None => {
                let cwd = view.read(cx).cwd().to_string();
                let drawer = cx.new(|cx| TerminalDrawer::new(cwd, window, cx));
                let conversation = view.downgrade();
                cx.subscribe_in(&drawer, window, move |this, _, DrawerEvent::Emptied, window, cx| {
                    this.drawers.open.remove(&id);
                    if let Some(view) = conversation.upgrade() {
                        window.focus(&view.focus_handle(cx), cx);
                    }
                    cx.notify();
                })
                .detach();
                self.drawers.by_view.insert(id, drawer.clone());
                drawer
            }
        };
        self.drawers.open.insert(id);
        // The drawer isn't drawn until the next frame (see `activate`).
        cx.on_next_frame(window, move |_, window, cx| drawer.update(cx, |drawer, cx| drawer.focus_active(window, cx)));
    }
}
