use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context as _, Result, anyhow};
use futures::channel::{mpsc, oneshot};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

type Reply = oneshot::Sender<Result<Value>>;
type Pending = Arc<Mutex<HashMap<u64, Reply>>>;

/// A message the host sent on its own: `session.event`, `session.status`…
#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

pub type Notifications = mpsc::UnboundedReceiver<Notification>;

/// A JSON-RPC 2.0 client over newline-delimited JSON — the framing `loop rpc`
/// speaks on stdio. The stream is read on a dedicated thread, so a slow host
/// never blocks the UI thread; `request` is an ordinary future any executor
/// can await, and notifications arrive on the receiver `connect` returns.
pub struct RpcClient {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Pending,
    next_id: AtomicU64,
    child: Option<Child>,
}

impl RpcClient {
    /// Starts `command` (normally `loop rpc`) and talks to it over its stdio.
    pub fn spawn(mut command: Command) -> Result<(Self, Notifications)> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("starting {:?}", command.get_program()))?;
        let stdin = child.stdin.take().context("child has no stdin")?;
        let stdout = child.stdout.take().context("child has no stdout")?;
        let (mut client, notifications) = Self::connect(stdout, stdin);
        client.child = Some(child);
        Ok((client, notifications))
    }

    /// Talks JSON-RPC over any byte stream pair.
    pub fn connect(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
    ) -> (Self, Notifications) {
        let pending: Pending = Arc::default();
        let (notify, notifications) = mpsc::unbounded();
        let reader_pending = pending.clone();
        thread::Builder::new()
            .name("loop-rpc-reader".into())
            .spawn(move || read_stream(reader, reader_pending, notify))
            .expect("spawning the rpc reader thread");
        let client = Self {
            writer: Mutex::new(Box::new(writer)),
            pending,
            next_id: AtomicU64::new(1),
            child: None,
        };
        (client, notifications)
    }

    pub async fn request<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let receiver = self.send(method, params)?;
        let value = receiver
            .await
            .map_err(|_| anyhow!("loop rpc dropped the request"))??;
        serde_json::from_value(value).with_context(|| format!("decoding the {method} reply"))
    }

    fn send(&self, method: &str, params: Value) -> Result<oneshot::Receiver<Result<Value>>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut writer = self.writer.lock().unwrap();
        let written = writeln!(writer, "{line}").and_then(|()| writer.flush());
        if let Err(error) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(error).context("loop rpc is not accepting requests");
        }
        Ok(receiver)
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// One line off the wire.
enum Incoming {
    Reply(u64, Result<Value>),
    Notification(Notification),
}

/// Runs on the reader thread until the stream closes, then fails whatever is
/// still waiting so no caller hangs on a dead host.
fn read_stream(reader: impl Read, pending: Pending, notify: mpsc::UnboundedSender<Notification>) {
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        match parse_line(&line) {
            Some(Incoming::Reply(id, reply)) => {
                if let Some(sender) = pending.lock().unwrap().remove(&id) {
                    let _ = sender.send(reply);
                }
            }
            Some(Incoming::Notification(notification)) => {
                let _ = notify.unbounded_send(notification);
            }
            None => {}
        }
    }
    for (_, sender) in pending.lock().unwrap().drain() {
        let _ = sender.send(Err(anyhow!("loop rpc exited")));
    }
}

fn parse_line(line: &str) -> Option<Incoming> {
    let mut message: Value = serde_json::from_str(line).ok()?;
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        let method = message.get("method")?.as_str()?.to_string();
        let params = message.get_mut("params").map(Value::take).unwrap_or(Value::Null);
        return Some(Incoming::Notification(Notification { method, params }));
    };
    if let Some(error) = message.get("error") {
        let text = error["message"].as_str().unwrap_or("unknown error");
        return Some(Incoming::Reply(id, Err(anyhow!("{text}"))));
    }
    let result = message.get_mut("result").map(Value::take).unwrap_or(Value::Null);
    Some(Incoming::Reply(id, Ok(result)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    /// A stand-in for `loop rpc`: answers id 1 with a result and id 2 with an
    /// error, after one notification line, then exits.
    const FAKE_HOST: &str = r#"
        read first; read second
        echo '{"jsonrpc":"2.0","method":"session.event","params":{"seq":7}}'
        echo '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'
        echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no such method"}}'
    "#;

    fn fake_host(script: &str) -> (RpcClient, Notifications) {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        RpcClient::spawn(command).unwrap()
    }

    #[test]
    fn replies_reach_their_request_and_notifications_the_stream() {
        let (client, mut notifications) = fake_host(FAKE_HOST);
        let ok = client.send("hello", json!({})).unwrap();
        let failing = client.send("nope", json!({})).unwrap();
        let ok = futures::executor::block_on(ok).unwrap().unwrap();
        assert_eq!(ok, json!({ "ok": true }));
        let error = futures::executor::block_on(failing).unwrap().unwrap_err();
        assert_eq!(error.to_string(), "no such method");
        let event = futures::executor::block_on(notifications.next()).unwrap();
        assert_eq!((event.method.as_str(), event.params), ("session.event", json!({ "seq": 7 })));
    }

    #[test]
    fn a_host_that_exits_fails_pending_requests() {
        let (client, _notifications) = fake_host("read line");
        let error = futures::executor::block_on(client.request::<Value>("hello", json!({})))
            .unwrap_err();
        assert_eq!(error.to_string(), "loop rpc exited");
    }
}
