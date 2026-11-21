use std::collections::HashMap;

use gpui::{Context, Entity, SharedString};

use crate::host::{LoopHost, SessionsChanged, request};
use crate::rpc::protocol::SessionRow;

/// The threads in one working folder, newest first.
#[derive(Debug, Clone)]
pub struct Project {
    pub cwd: SharedString,
    pub threads: Vec<SessionRow>,
}

impl Project {
    /// The folder's last path segment, the way Zed names a worktree.
    pub fn name(&self) -> &str {
        folder_name(&self.cwd)
    }
}

pub fn folder_name(path: &str) -> &str {
    path.rsplit('/').find(|part| !part.is_empty()).unwrap_or(path)
}

/// Every loop session, grouped by project; reloads whenever the host says
/// the list changed.
pub struct ThreadStore {
    host: Entity<LoopHost>,
    pub projects: Vec<Project>,
    pub error: Option<SharedString>,
    /// The first list has arrived (it may be empty).
    pub loaded: bool,
}

impl ThreadStore {
    pub fn new(host: Entity<LoopHost>, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&host, |store, _, _: &SessionsChanged, cx| store.reload(cx)).detach();
        let mut store = Self { host, projects: Vec::new(), error: None, loaded: false };
        store.reload(cx);
        store
    }

    pub fn find(&self, id: &str) -> Option<&SessionRow> {
        self.projects.iter().flat_map(|project| &project.threads).find(|row| row.id == id)
    }

    /// The model of the most recently used thread: what a new thread starts on.
    pub fn last_model(&self) -> Option<String> {
        self.projects.first()?.threads.first()?.current_model().map(str::to_string)
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let rows = request::<Vec<SessionRow>>(&self.host, "session.list", serde_json::json!({}), cx);
        cx.spawn(async move |this, cx| {
            let rows = rows.await;
            this.update(cx, |store, cx| {
                match rows {
                    Ok(rows) => {
                        store.projects = group_by_project(rows);
                        store.error = None;
                    }
                    Err(error) => store.error = Some(format!("{error:#}").into()),
                }
                store.loaded = true;
                cx.notify();
            })
        })
        .detach();
    }
}

/// Groups rows by working folder; projects and the threads in each are
/// ordered by most recent activity.
pub fn group_by_project(rows: Vec<SessionRow>) -> Vec<Project> {
    let mut by_cwd: HashMap<String, Vec<SessionRow>> = HashMap::new();
    for row in rows {
        by_cwd.entry(row.cwd.clone()).or_default().push(row);
    }
    let mut projects: Vec<Project> = by_cwd
        .into_iter()
        .map(|(cwd, mut threads)| {
            threads.sort_by_key(|thread| std::cmp::Reverse(thread.mtime));
            Project { cwd: cwd.into(), threads }
        })
        .collect();
    projects.sort_by_key(|project| std::cmp::Reverse(project.threads[0].mtime));
    projects
}

/// What a thread is called in lists: its name, else the first line of its
/// first prompt.
pub fn thread_title(row: &SessionRow) -> SharedString {
    let named = row.name.as_deref().map(str::trim).filter(|name| !name.is_empty());
    let prompt = row.first_user_message.as_deref().and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()));
    named.or(prompt).unwrap_or("New thread").to_string().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, cwd: &str, mtime: u64) -> SessionRow {
        SessionRow {
            id: id.into(),
            cwd: cwd.into(),
            mtime,
            name: None,
            first_user_message: None,
            last_model: None,
            model: None,
            running: false,
        }
    }

    #[test]
    fn projects_and_threads_are_newest_first() {
        let projects = group_by_project(vec![
            row("a1", "/w/a", 10),
            row("b1", "/w/b", 30),
            row("a2", "/w/a", 20),
        ]);
        let order: Vec<(&str, Vec<&str>)> = projects
            .iter()
            .map(|p| (p.name(), p.threads.iter().map(|t| t.id.as_str()).collect()))
            .collect();
        assert_eq!(order, vec![("b", vec!["b1"]), ("a", vec!["a2", "a1"])]);
    }

    #[test]
    fn title_prefers_name_then_first_prompt_line() {
        let mut thread = row("x", "/w", 0);
        assert_eq!(thread_title(&thread), "New thread");
        thread.first_user_message = Some("\n  fix the build\nmore".into());
        assert_eq!(thread_title(&thread), "fix the build");
        thread.name = Some("Build fix".into());
        assert_eq!(thread_title(&thread), "Build fix");
    }
}
