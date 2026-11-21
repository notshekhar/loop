//! Everything the app draws from files, compiled into the binary: loop's
//! lucide icons, the provider logos, DM Sans (loop desktop's font) and
//! Lilex (Zed's terminal font).

use std::borrow::Cow;

use gpui::{App, AssetSource, SharedString};

macro_rules! icons {
    ($($variant:ident => $file:literal),* $(,)?) => {
        /// A lucide icon (ISC, assets/icons/LICENSE-lucide.txt), as loop's
        /// web app uses them.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Icon { $($variant),* }

        impl Icon {
            pub fn path(self) -> &'static str {
                match self { $(Icon::$variant => concat!("icons/", $file, ".svg")),* }
            }
        }

        const ICON_FILES: &[(&str, &[u8])] = &[
            $((concat!("icons/", $file, ".svg"), include_bytes!(concat!("../assets/icons/", $file, ".svg")))),*
        ];
    };
}

icons! {
    Archive => "archive",
    Bot => "bot",
    Box => "box",
    Brain => "brain",
    ChartColumn => "chart-no-axes-column",
    Check => "check",
    ChevronDown => "chevron-down",
    ChevronRight => "chevron-right",
    ChevronsUpDown => "chevrons-up-down",
    Circle => "circle",
    CircleAlert => "circle-alert",
    CircleCheck => "circle-check",
    CircleDashed => "circle-dashed",
    Copy => "copy",
    CornerDownLeft => "corner-down-left",
    CornerUpLeft => "corner-up-left",
    Database => "database",
    Eye => "eye",
    Folder => "folder",
    FolderClosed => "folder-closed",
    FolderPlus => "folder-plus",
    Gauge => "gauge",
    GitBranch => "git-branch",
    GitBranchPlus => "git-branch-plus",
    GitPullRequest => "git-pull-request",
    Globe => "globe",
    House => "house",
    Infinity => "infinity",
    Layers => "layers",
    Loader => "loader-circle",
    MessageSquare => "message-square",
    PanelBottom => "panel-bottom",
    PanelLeft => "panel-left",
    PanelLeftClose => "panel-left-close",
    PanelRight => "panel-right",
    Plus => "plus",
    Scissors => "scissors",
    Search => "search",
    Settings => "settings",
    Sparkles => "sparkles",
    SquarePen => "square-pen",
    SquareSplitHorizontal => "square-split-horizontal",
    SquareSplitVertical => "square-split-vertical",
    Terminal => "terminal",
    Trash => "trash-2",
    User => "user",
    Wrench => "wrench",
    X => "x",
}

macro_rules! providers {
    ($($id:literal),* $(,)?) => {
        const PROVIDER_FILES: &[(&str, &[u8])] = &[
            $((concat!("providers/", $id, ".svg"), include_bytes!(concat!("../assets/providers/", $id, ".svg")))),*
        ];
    };
}

// loop's provider logos (apps/web/src/components/LoopProviderIcons.tsx).
providers!(
    "anthropic", "bedrock", "cerebras", "deepseek", "github-copilot", "google", "groq", "kimi",
    "mistral", "ollama", "openai", "openrouter", "vercel", "xai", "zai", "zenmux",
);

/// The logo for a provider id, when loop has one. Variants of a provider
/// (`openai-chatgpt`, `custom:…`) fall back to their family's logo.
pub fn provider_logo(provider: &str) -> Option<&'static str> {
    let family = match provider {
        "openai-chatgpt" | "openai-codex" => "openai",
        "claude-code" => "anthropic",
        "glm" => "zai",
        other => other,
    };
    PROVIDER_FILES.iter().map(|(path, _)| *path).find(|path| path.trim_start_matches("providers/").trim_end_matches(".svg") == family)
}

const FONTS: [&[u8]; 7] = [
    include_bytes!("../assets/fonts/DMSans-Regular.ttf"),
    include_bytes!("../assets/fonts/DMSans-Medium.ttf"),
    include_bytes!("../assets/fonts/DMSans-SemiBold.ttf"),
    // Zed's terminal and editor font.
    include_bytes!("../assets/fonts/Lilex-Regular.ttf"),
    include_bytes!("../assets/fonts/Lilex-Bold.ttf"),
    include_bytes!("../assets/fonts/Lilex-Italic.ttf"),
    include_bytes!("../assets/fonts/Lilex-BoldItalic.ttf"),
];

pub fn load_fonts(cx: &App) -> anyhow::Result<()> {
    cx.text_system().add_fonts(FONTS.iter().map(|font| Cow::Borrowed(*font)).collect())
}

/// Serves the compiled-in files to gpui's `svg()` element.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(ICON_FILES.iter().chain(PROVIDER_FILES).find(|(known, _)| *known == path).map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(ICON_FILES.iter().chain(PROVIDER_FILES).filter(|(known, _)| known.starts_with(path)).map(|(known, _)| SharedString::from(*known)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_and_logo_is_served() {
        assert!(Assets.load(Icon::Brain.path()).unwrap().is_some());
        assert_eq!(provider_logo("openai-chatgpt"), Some("providers/openai.svg"));
        assert!(Assets.load(provider_logo("xai").unwrap()).unwrap().is_some());
        assert_eq!(provider_logo("custom:pronto"), None);
    }
}
