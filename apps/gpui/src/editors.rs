//! "Open in…": loop's editor table (apps/web contracts/editor.ts), which of
//! them are installed, and launching one on a folder the way loop's
//! `shell.openInEditor` does.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

pub struct Editor {
    pub id: &'static str,
    pub label: &'static str,
    /// Commands to try, first found wins; `None` is the OS file manager.
    commands: Option<&'static [&'static str]>,
    base_args: &'static [&'static str],
}

const fn editor(id: &'static str, label: &'static str, commands: &'static [&'static str]) -> Editor {
    Editor { id, label, commands: Some(commands), base_args: &[] }
}

/// In loop's order, which is also the fallback order for the preferred one.
pub const EDITORS: [Editor; 21] = [
    editor("cursor", "Cursor", &["cursor"]),
    editor("trae", "Trae", &["trae"]),
    Editor { base_args: &["ide"], ..editor("kiro", "Kiro", &["kiro"]) },
    editor("vscode", "VS Code", &["code"]),
    editor("vscode-insiders", "VS Code Insiders", &["code-insiders"]),
    editor("vscodium", "VSCodium", &["codium"]),
    editor("zed", "Zed", &["zed", "zeditor"]),
    editor("antigravity", "Antigravity", &["agy"]),
    editor("idea", "IntelliJ IDEA", &["idea"]),
    editor("aqua", "Aqua", &["aqua"]),
    editor("clion", "CLion", &["clion"]),
    editor("datagrip", "DataGrip", &["datagrip"]),
    editor("dataspell", "DataSpell", &["dataspell"]),
    editor("goland", "GoLand", &["goland"]),
    editor("phpstorm", "PhpStorm", &["phpstorm"]),
    editor("pycharm", "PyCharm", &["pycharm"]),
    editor("rider", "Rider", &["rider"]),
    editor("rubymine", "RubyMine", &["rubymine"]),
    editor("rustrover", "RustRover", &["rustrover"]),
    editor("webstorm", "WebStorm", &["webstorm"]),
    Editor { id: "file-manager", label: "Finder", commands: None, base_args: &[] },
];

/// The installed editors, each with the program that launches it.
#[derive(Default, Clone)]
pub struct Installed(Vec<(&'static Editor, PathBuf)>);

impl Installed {
    pub fn editors(&self) -> impl Iterator<Item = &'static Editor> + '_ {
        self.0.iter().map(|(editor, _)| *editor)
    }

    /// The remembered editor if it is still installed, else the first one.
    pub fn preferred(&self, remembered: Option<&str>) -> Option<&'static Editor> {
        self.editors().find(|editor| Some(editor.id) == remembered).or_else(|| self.editors().next())
    }

    /// `open -a`-free launch: the editor's own command on the folder, as
    /// loop does; the file manager through `open`.
    pub fn launch(&self, editor: &Editor, folder: &str) -> std::io::Result<()> {
        let program = self.0.iter().find(|(known, _)| known.id == editor.id).map(|(_, program)| program.clone()).unwrap_or_else(|| PathBuf::from("open"));
        let mut child = Command::new(program).args(editor.base_args).arg(folder).current_dir(folder).spawn()?;
        // Reap it so it never lingers as a zombie; editors' CLIs return
        // once they have handed the folder to the app.
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

/// Every editor command on the login shell's PATH. A GUI-launched app
/// inherits launchd's bare PATH, so asking the shell is what finds
/// `cursor` or `zed` in ~/.local/bin or /opt/homebrew/bin.
pub fn detect() -> Installed {
    let commands: Vec<&str> = EDITORS.iter().filter_map(|editor| editor.commands).flatten().copied().collect();
    let script = commands.iter().map(|command| format!("command -v {command}")).collect::<Vec<_>>().join("; ");
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let found = Command::new(shell).args(["-lc", &script]).output().map(|output| String::from_utf8_lossy(&output.stdout).into_owned()).unwrap_or_default();
    installed_from(&found)
}

/// Pairs each editor with the first of its commands the shell found.
fn installed_from(found: &str) -> Installed {
    let paths: HashMap<&str, PathBuf> = found
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/'))
        .filter_map(|line| Some((std::path::Path::new(line).file_name()?.to_str()?, PathBuf::from(line))))
        .collect();
    Installed(
        EDITORS
            .iter()
            .filter_map(|editor| match editor.commands {
                Some(commands) => commands.iter().find_map(|command| paths.get(command).cloned()).map(|program| (editor, program)),
                None => Some((editor, PathBuf::from("open"))),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_editors_keep_loops_order_and_the_file_manager_is_always_there() {
        let installed = installed_from("/opt/homebrew/bin/zed\n/Users/me/.local/bin/cursor\nnot a path\n");
        let ids: Vec<&str> = installed.editors().map(|editor| editor.id).collect();
        assert_eq!(ids, ["cursor", "zed", "file-manager"]);
        assert_eq!(installed.preferred(Some("zed")).map(|editor| editor.id), Some("zed"));
        assert_eq!(installed.preferred(Some("webstorm")).map(|editor| editor.id), Some("cursor"));
    }

    #[test]
    fn zed_falls_back_to_zeditor() {
        let installed = installed_from("/usr/bin/zeditor\n");
        assert_eq!(installed.editors().map(|editor| editor.id).collect::<Vec<_>>(), ["zed", "file-manager"]);
    }
}
