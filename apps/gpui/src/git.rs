//! The git the header needs: is this folder a repository, and `git init`.
//! loop runs these through its workspace host; this app has a shell.

use std::process::Command;

fn git(folder: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git").arg("-C").arg(folder).args(args).output()
}

pub fn is_repo(folder: &str) -> bool {
    git(folder, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"true"))
}

pub fn init(folder: &str) -> anyhow::Result<()> {
    let output = git(folder, &["init"])?;
    anyhow::ensure!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr).trim());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_becomes_a_repo_after_init() {
        let dir = std::env::temp_dir().join(format!("loop-gpui-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let folder = dir.to_str().unwrap();
        assert!(!is_repo(folder));
        init(folder).unwrap();
        assert!(is_repo(folder));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
