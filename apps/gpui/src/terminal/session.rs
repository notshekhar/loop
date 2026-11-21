//! One shell in a pty, parsed into an alacritty grid on its own thread.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::tty;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};

/// Lines kept above the screen (xterm.js's default scrollback in loop).
const SCROLLBACK_LINES: usize = 10_000;

/// Hands the parser's events to the app thread.
#[derive(Clone)]
pub struct Listener(UnboundedSender<Event>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let _ = self.0.unbounded_send(event);
    }
}

/// The grid's size in cells, and a cell's size in pixels (programs can ask).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridSize {
    pub columns: u16,
    pub lines: u16,
    pub cell_width: u16,
    pub cell_height: u16,
}

impl GridSize {
    pub fn window_size(self) -> WindowSize {
        WindowSize { num_lines: self.lines, num_cols: self.columns, cell_width: self.cell_width, cell_height: self.cell_height }
    }
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.lines as usize
    }

    fn screen_lines(&self) -> usize {
        self.lines as usize
    }

    fn columns(&self) -> usize {
        self.columns as usize
    }
}

pub type Grid = Term<Listener>;

pub struct Session {
    term: Arc<FairMutex<Grid>>,
    sender: EventLoopSender,
    size: Mutex<GridSize>,
}

fn shell_env() -> HashMap<String, String> {
    [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")].into_iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
}

impl Session {
    /// The user's login shell in `cwd`. Its events (new output, title,
    /// exit) arrive on the receiver.
    pub fn spawn(cwd: &str, size: GridSize) -> anyhow::Result<(Self, UnboundedReceiver<Event>)> {
        Self::start(None, cwd, size)
    }

    /// `shell` runs in place of the login shell when given.
    fn start(shell: Option<tty::Shell>, cwd: &str, size: GridSize) -> anyhow::Result<(Self, UnboundedReceiver<Event>)> {
        let (events, receiver) = unbounded();
        let listener = Listener(events);
        let options = tty::Options { shell, working_directory: Some(cwd.into()), drain_on_exit: true, env: shell_env(), ..Default::default() };
        let pty = tty::new(&options, size.window_size(), 0)?;
        let config = Config { scrolling_history: SCROLLBACK_LINES, ..Default::default() };
        let term = Arc::new(FairMutex::new(Term::new(config, &size, listener.clone())));
        let io = EventLoop::new(term.clone(), listener, pty, options.drain_on_exit, false)?;
        let sender = io.channel();
        io.spawn();
        Ok((Self { term, sender, size: Mutex::new(size) }, receiver))
    }

    pub fn with_grid<R>(&self, read: impl FnOnce(&mut Grid) -> R) -> R {
        read(&mut self.term.lock())
    }

    /// Typed input. Like xterm, typing brings the view back to the prompt.
    pub fn write(&self, bytes: impl Into<Vec<u8>>) {
        self.with_grid(|grid| {
            grid.scroll_display(Scroll::Bottom);
            grid.selection = None;
        });
        self.reply(bytes);
    }

    /// Bytes for the program that the user didn't type: answers to its
    /// queries, wheel arrows. The view stays where it is.
    pub fn reply(&self, bytes: impl Into<Vec<u8>>) {
        let bytes = bytes.into();
        // The io thread stalls on an empty write.
        if !bytes.is_empty() {
            let _ = self.sender.send(Msg::Input(Cow::Owned(bytes)));
        }
    }

    pub fn size(&self) -> GridSize {
        *self.size.lock().unwrap()
    }

    /// Fits the grid and the pty to a new size; a no-op when unchanged.
    pub fn resize(&self, size: GridSize) {
        let mut current = self.size.lock().unwrap();
        if *current == size {
            return;
        }
        *current = size;
        self.with_grid(|grid| grid.resize(size));
        let _ = self.sender.send(Msg::Resize(size.window_size()));
    }
}

impl Drop for Session {
    /// Ends the io thread, which drops the pty and hangs up the shell.
    fn drop(&mut self) {
        let _ = self.sender.send(Msg::Shutdown);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use futures::StreamExt;

    use super::*;

    const SIZE: GridSize = GridSize { columns: 40, lines: 5, cell_width: 7, cell_height: 14 };

    fn screen(session: &Session) -> String {
        session.with_grid(|grid| {
            let palette = crate::terminal::colors::Palette::zed(gpui::black());
            let frame = crate::terminal::frame::snapshot(grid, &palette);
            let line = |row: &crate::terminal::frame::Row| {
                let mut line = String::new();
                for span in &row.spans {
                    line.extend(std::iter::repeat_n(' ', span.column.saturating_sub(line.chars().count())));
                    line.push_str(&span.text);
                }
                line
            };
            frame.rows.iter().map(line).collect::<Vec<_>>().join("\n")
        })
    }

    fn wait_for(session: &Session, text: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let screen = screen(session);
            if screen.contains(text) || Instant::now() > deadline {
                return screen;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_shell_echoes_what_is_typed_and_exits() {
        let script = "printf ready; read line; printf \"got:$line\"";
        let shell = tty::Shell::new("/bin/sh".into(), vec!["-c".into(), script.into()]);
        let (session, mut events) = Session::start(Some(shell), "/tmp", SIZE).unwrap();
        assert!(wait_for(&session, "ready").contains("ready"));
        session.write(b"hello\r".to_vec());
        assert!(wait_for(&session, "got:hello").contains("got:hello"));
        let exited = futures::executor::block_on(async {
            while let Some(event) = events.next().await {
                if matches!(event, Event::ChildExit(_)) {
                    return true;
                }
            }
            false
        });
        assert!(exited);
    }

    #[test]
    fn resizing_reaches_the_program() {
        let shell = tty::Shell::new("/bin/sh".into(), vec!["-c".into(), "sleep 0.3; stty size; sleep 5".into()]);
        let (session, _events) = Session::start(Some(shell), "/tmp", SIZE).unwrap();
        session.resize(GridSize { columns: 33, lines: 4, ..SIZE });
        assert!(wait_for(&session, "4 33").contains("4 33"));
    }
}
