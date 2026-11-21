mod pages;
mod terminals;

use std::collections::HashMap;

use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, PathPromptOptions, Render, SharedString, Styled, Window, div,
    prelude::FluentBuilder,
};
use serde_json::json;

use crate::agents::Agents;
use crate::actions::{NewThread, OpenInEditor, ReloadThreads, ToggleSidebar};
use terminals::Drawers;
use crate::catalog::Catalog;
use crate::host::{HostState, LoopHost, request};
use crate::session::Session;
use crate::settings::load_defaults;
use crate::theme::{ActiveTheme, FRAME_INSET, FRAME_RADIUS};
use crate::threads::ThreadStore;
use crate::ui::conversation::{ConversationView, Services, ThreadCreated};
use crate::ui::header::{Header, HeaderEvent, Target};
use crate::ui::rail::{Page, rail};
use crate::ui::sidebar::{Sidebar, SidebarEvent};
use crate::ui::text_input::{InputEvent, TextInput};

/// The window's root, laid out like loop desktop: the top bar across the
/// window; below it the rail, then an inset frame holding the sidebar and
/// the page.
pub struct Workspace {
    host: Entity<LoopHost>,
    store: Entity<ThreadStore>,
    /// Handed to every conversation.
    services: Services,
    sidebar: Entity<Sidebar>,
    sidebar_open: bool,
    page: Page,
    /// Conversations stay alive while switching, so a thread keeps its
    /// scroll position, open rows and half-typed message.
    conversations: HashMap<SharedString, Entity<ConversationView>>,
    active: Option<Entity<ConversationView>>,
    search: Entity<TextInput>,
    header: Entity<Header>,
    drawers: Drawers,
    focus: FocusHandle,
}

impl Workspace {
    pub fn new(host: Entity<LoopHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = cx.new(|cx| ThreadStore::new(host.clone(), cx));
        let catalog = cx.new(|cx| Catalog::new(host.clone(), cx));
        let agents = cx.new(|cx| Agents::new(host.clone(), cx));
        let sidebar = cx.new(|cx| Sidebar::new(store.clone(), cx));
        cx.subscribe_in(&sidebar, window, |this, _, event: &SidebarEvent, window, cx| this.on_sidebar(event, window, cx)).detach();
        let header = cx.new(|cx| Header::new(store.clone(), cx));
        cx.subscribe_in(&header, window, |this, _, event: &HeaderEvent, window, cx| match event {
            HeaderEvent::NewThreadIn(cwd) => this.new_draft(cwd.to_string(), window, cx),
            HeaderEvent::OpenForked { session_id, prompt } => this.open_forked(session_id.clone().into(), prompt.clone(), window, cx),
            HeaderEvent::ToggleTerminal => this.toggle_terminal(window, cx),
        })
        .detach();
        let search = cx.new(|cx| TextInput::new("Search threads", 1, cx));
        cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Changed) {
                cx.notify();
            }
        })
        .detach();
        cx.observe(&store, |_, _, cx| cx.notify()).detach();
        cx.observe(&host, |_, _, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            host: host.clone(),
            store,
            services: Services { host, catalog, agents, defaults: load_defaults() },
            sidebar,
            sidebar_open: true,
            page: Page::Home,
            conversations: HashMap::new(),
            active: None,
            search,
            header,
            drawers: Drawers::default(),
            focus,
        }
    }

    fn on_sidebar(&mut self, event: &SidebarEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.page = Page::Home;
        match event {
            SidebarEvent::Open(id) => self.open_thread(id.clone(), window, cx),
            SidebarEvent::NewThreadIn(cwd) => self.new_draft(cwd.to_string(), window, cx),
            SidebarEvent::AddProject => self.add_project(window, cx),
            SidebarEvent::ShowActivity => self.page = Page::Activity,
            SidebarEvent::Archive(id) => self.archive(id.clone(), cx),
        }
        cx.notify();
    }

    pub fn open_thread(&mut self, id: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let row = self.store.read(cx).find(&id).cloned();
        let view = match self.conversations.get(&id) {
            Some(view) => view.clone(),
            None => {
                let session = Session::open(id.to_string(), self.host.clone(), cx);
                let cwd = row.as_ref().map(|row| row.cwd.clone()).unwrap_or_default();
                let model = row.as_ref().and_then(|row| row.current_model().map(str::to_string));
                let view = self.conversation(Some(session), cwd, model, window, cx);
                self.conversations.insert(id.clone(), view.clone());
                view
            }
        };
        let cwd = row.map(|row| SharedString::from(row.cwd));
        self.sidebar.update(cx, |sidebar, cx| sidebar.set_selected(Some(id), cwd, cx));
        window.focus(&view.focus_handle(cx), cx);
        self.active = Some(view);
        cx.notify();
    }

    /// A fork made in the Branches dialog: list it, open it, and put the
    /// prompt it was forked before back in the composer.
    fn open_forked(&mut self, id: SharedString, prompt: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.store.update(cx, |store, cx| store.reload(cx));
        self.open_thread(id, window, cx);
        if let (Some(view), Some(prompt)) = (&self.active, prompt) {
            view.update(cx, |view, cx| view.set_draft(prompt, cx));
        }
    }

    fn new_draft(&mut self, cwd: String, window: &mut Window, cx: &mut Context<Self>) {
        let model = self.store.read(cx).last_model();
        let view = self.conversation(None, cwd.clone(), model, window, cx);
        self.sidebar.update(cx, |sidebar, cx| sidebar.set_selected(None, Some(cwd.into()), cx));
        self.page = Page::Home;
        self.active = Some(view);
        cx.notify();
    }

    fn conversation(&mut self, session: Option<Entity<Session>>, cwd: String, model: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Entity<ConversationView> {
        let services = self.services.clone();
        let view = cx.new(|cx| ConversationView::new(services, session, cwd, model, window, cx));
        cx.subscribe(&view, |this, view, ThreadCreated(id), cx| {
            this.conversations.insert(id.clone(), view.clone());
            let cwd = SharedString::from(view.read(cx).cwd().to_string());
            this.sidebar.update(cx, |sidebar, cx| sidebar.set_selected(Some(id.clone()), Some(cwd), cx));
            this.store.update(cx, |store, cx| store.reload(cx));
        })
        .detach();
        view
    }

    /// "Add project": pick a folder, then start a thread in it — a project
    /// is just a folder that has threads.
    fn add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Add project".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else { return };
            let Some(folder) = paths.into_iter().next() else { return };
            let _ = this.update_in(cx, |this, window, cx| this.new_draft(folder.to_string_lossy().into_owned(), window, cx));
        })
        .detach();
    }

    fn archive(&mut self, id: SharedString, cx: &mut Context<Self>) {
        let archived = request::<serde_json::Value>(&self.host, "session.archive", json!({ "sessionId": id }), cx);
        if self.active.as_ref().is_some_and(|view| view.read(cx).session_id(cx).as_deref() == Some(id.as_ref())) {
            self.active = None;
        }
        if let Some(view) = self.conversations.remove(&id) {
            self.drawers.remove(view.entity_id());
        }
        cx.spawn(async move |this, cx| {
            let _ = archived.await;
            this.update(cx, |this, cx| this.store.update(cx, |store, cx| store.reload(cx)))
        })
        .detach();
    }

    /// A new thread goes in the project on screen, else the most recently
    /// used one, else the home folder.
    fn default_cwd(&self, cx: &App) -> String {
        self.active_cwd(cx)
            .or_else(|| self.sidebar.read(cx).project_cwd(cx).map(|cwd| cwd.to_string()))
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into()))
    }

    fn active_cwd(&self, cx: &App) -> Option<String> {
        self.active.as_ref().map(|view| view.read(cx).cwd().to_string()).filter(|cwd| !cwd.is_empty())
    }

    fn new_thread(&mut self, _: &NewThread, window: &mut Window, cx: &mut Context<Self>) {
        let cwd = self.default_cwd(cx);
        self.new_draft(cwd, window, cx);
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_open = !self.sidebar_open;
        cx.notify();
    }

    fn open_in_editor(&mut self, _: &OpenInEditor, _: &mut Window, cx: &mut Context<Self>) {
        self.header.update(cx, |header, cx| header.open_preferred(cx));
    }

    fn reload_threads(&mut self, _: &ReloadThreads, _: &mut Window, cx: &mut Context<Self>) {
        self.store.update(cx, |store, cx| store.reload(cx));
    }

    fn pick_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        self.page = page;
        if page == Page::Search {
            window.focus(&self.search.focus_handle(cx), cx);
        }
        cx.notify();
    }

    fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        match self.page {
            Page::Home => match &self.active {
                Some(view) => view.clone().into_any_element(),
                None if !self.store.read(cx).loaded => div().into_any_element(),
                None => {
                    // Home with nothing open is a new thread, as in loop.
                    let cwd = self.default_cwd(cx);
                    self.new_draft(cwd, window, cx);
                    self.active.clone().map_or_else(|| div().into_any_element(), |view| view.into_any_element())
                }
            },
            Page::Search | Page::Activity => self.render_thread_list_page(cx),
            Page::Insights | Page::SourceControl | Page::Settings => self.render_missing_page(cx),
        }
    }

    fn render_host_error(&self, cx: &App) -> Option<impl IntoElement> {
        let theme = cx.theme();
        let HostState::Failed(reason) = &self.host.read(cx).state else { return None };
        Some(div().px_4().py_2().text_sm().text_color(theme.error).bg(theme.error.opacity(0.08)).child(format!("loop isn't running: {reason}")))
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let page = self.render_page(window, cx);
        let view = (self.page == Page::Home).then(|| self.active.clone()).flatten();
        let terminal_open = view.as_ref().map(|view| self.drawers.is_open(view.entity_id()));
        let drawer = view.as_ref().and_then(|view| self.drawers.shown(view.entity_id()));
        let target = Target { view, page_title: (self.page != Page::Home).then(|| self.page.title()), sidebar_open: self.sidebar_open && self.page == Page::Home, terminal_open };
        self.header.update(cx, |header, cx| header.set_target(target, cx));
        let workspace = cx.entity().downgrade();
        let frame = div()
            .flex_1()
            .min_w_0()
            .mr(FRAME_INSET)
            .mb(FRAME_INSET)
            .flex()
            .rounded(FRAME_RADIUS)
            .border_1()
            .border_color(theme.frame_border)
            .bg(theme.background)
            .overflow_hidden()
            .when(self.sidebar_open && self.page == Page::Home, |frame| frame.child(self.sidebar.clone()))
            .child(div().flex_1().min_w_0().h_full().flex().flex_col().children(self.render_host_error(cx)).child(div().flex_1().min_h_0().child(page)).children(drawer));
        div()
            .track_focus(&self.focus)
            .key_context("Workspace")
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::reload_threads))
            .on_action(cx.listener(Self::new_thread))
            .on_action(cx.listener(Self::open_in_editor))
            .on_action(cx.listener(Self::on_toggle_terminal))
            .size_full()
            .flex()
            .flex_col()
            .font_family(theme.ui_font)
            .text_color(theme.text)
            .bg(theme.background)
            .child(self.header.clone())
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(rail(self.page, move |page, window, cx| {
                        let _ = workspace.update(cx, |workspace, cx| workspace.pick_page(page, window, cx));
                    }, cx))
                    .child(frame),
            )
    }
}
