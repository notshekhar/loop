mod actions;
mod agents;
mod assets;
mod catalog;
mod editors;
mod git;
mod host;
mod insights;
mod markdown;
mod prefs;
mod rpc;
mod session;
mod settings;
mod terminal;
mod theme;
mod threads;
mod transcript;
mod tree;
mod ui;

use gpui::{App, AppContext, Bounds, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};

use crate::actions::Quit;
use crate::host::LoopHost;
use crate::theme::Theme;
use crate::ui::workspace::Workspace;

fn main() {
    gpui_platform::application().with_assets(assets::Assets).run(|cx: &mut App| {
        if let Err(error) = assets::load_fonts(cx) {
            eprintln!("loop-gpui: couldn't load the bundled fonts, using the system font: {error:#}");
        }
        cx.set_global(Theme::loop_dark());
        actions::bind_keys(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        // `loop-gpui <thread id>` opens on that thread.
        let args: Vec<String> = std::env::args().skip(1).collect();
        let terminal = args.iter().any(|arg| arg == "--terminal");
        open_main_window(args.into_iter().find(|arg| !arg.starts_with("--")), terminal, cx);
        cx.activate(true);
    });
}

/// `loop-gpui [thread-id] [--terminal]`: open on a thread, with its
/// terminal drawer open.
fn open_main_window(thread: Option<String>, terminal: bool, cx: &mut App) {
    let host = cx.new(|cx| LoopHost::new(rpc::spawn_loop_host(), cx));
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1280.), px(820.)), cx))),
        titlebar: Some(TitlebarOptions {
            title: Some("loop".into()),
            appears_transparent: true,
            // Centred in loop's 52px top bar.
            traffic_light_position: Some(point(px(18.), px(18.))),
        }),
        ..Default::default()
    };
    cx.open_window(options, |window, cx| {
        cx.new(|cx| {
            let mut workspace = Workspace::new(host, window, cx);
            if let Some(id) = thread {
                workspace.open_thread(id.into(), window, cx);
                if terminal {
                    workspace.toggle_terminal(window, cx);
                }
            }
            workspace
        })
    })
    .expect("opening the main window");
}
