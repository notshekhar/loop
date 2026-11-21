use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use gpui::{AppContext, AsyncApp, Context, Entity, EventEmitter, SharedString, Task, WeakEntity};
use serde_json::Value;

use crate::rpc::protocol::hello_params;
use crate::rpc::{Notification, Notifications, RpcClient};
use crate::session::Session;

/// Where the connection to `loop rpc` stands.
#[derive(Debug, Clone)]
pub enum HostState {
    Connecting,
    Ready,
    Failed(SharedString),
}

/// Something about the session list changed on the host.
pub struct SessionsChanged;

/// The one connection to `loop rpc`. Owns the client, says whether it is up,
/// and routes each live `session.event` to the open session it belongs to.
pub struct LoopHost {
    client: Option<Arc<RpcClient>>,
    pub state: HostState,
    sessions: HashMap<String, WeakEntity<Session>>,
    _notifications: Option<Task<()>>,
}

impl EventEmitter<SessionsChanged> for LoopHost {}

impl LoopHost {
    pub fn new(connection: anyhow::Result<(RpcClient, Notifications)>, cx: &mut Context<Self>) -> Self {
        match connection {
            Ok((client, notifications)) => {
                let client = Arc::new(client);
                let mut host = Self {
                    client: Some(client.clone()),
                    state: HostState::Connecting,
                    sessions: HashMap::new(),
                    _notifications: Some(cx.spawn(async move |this, cx| route(this, notifications, cx).await)),
                };
                host.greet(client, cx);
                host
            }
            Err(error) => Self {
                client: None,
                state: HostState::Failed(format!("{error:#}").into()),
                sessions: HashMap::new(),
                _notifications: None,
            },
        }
    }

    pub fn client(&self) -> Option<Arc<RpcClient>> {
        self.client.clone()
    }

    fn greet(&mut self, client: Arc<RpcClient>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let hello = client.request::<serde_json::Value>("hello", hello_params()).await;
            this.update(cx, |host, cx| {
                host.state = match hello {
                    Ok(_) => HostState::Ready,
                    Err(error) => HostState::Failed(format!("{error:#}").into()),
                };
                cx.notify();
            })
        })
        .detach();
    }

    /// Live events for `id` go to `session` from now on.
    pub fn register(&mut self, id: &str, session: &Entity<Session>) {
        self.sessions.insert(id.to_string(), session.downgrade());
    }

    fn dispatch(&mut self, notification: Notification, cx: &mut Context<Self>) {
        match notification.method.as_str() {
            "session.event" => {
                let params = notification.params;
                let id = params["sessionId"].as_str().unwrap_or_default();
                let Some(session) = self.sessions.get(id).and_then(WeakEntity::upgrade) else { return };
                let seq = params["seq"].as_u64().unwrap_or(0);
                let kind = params["part"]["type"].as_str().unwrap_or_default().to_string();
                let data = params["part"].get("data").cloned().unwrap_or(Value::Null);
                session.update(cx, |session, cx| session.apply(seq, &kind, &data, cx));
            }
            // Names, running dots and new threads all live in the list.
            "session.status" => cx.emit(SessionsChanged),
            _ => {}
        }
    }
}

async fn route(this: WeakEntity<LoopHost>, mut notifications: Notifications, cx: &mut AsyncApp) {
    while let Some(notification) = notifications.next().await {
        if this.update(cx, |host, cx| host.dispatch(notification, cx)).is_err() {
            break;
        }
    }
    let _ = this.update(cx, |host, cx| {
        host.state = HostState::Failed("loop rpc exited".into());
        cx.notify();
    });
}

/// Runs `method` on the host, off the UI thread. Fails when loop is not
/// connected.
pub fn request<T: serde::de::DeserializeOwned + Send + 'static>(
    host: &Entity<LoopHost>,
    method: &'static str,
    params: Value,
    cx: &gpui::App,
) -> Task<anyhow::Result<T>> {
    let client = host.read(cx).client();
    cx.background_spawn(async move {
        let client = client.ok_or_else(|| anyhow::anyhow!("loop is not connected"))?;
        client.request(method, params).await
    })
}
