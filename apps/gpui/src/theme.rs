use gpui::{App, Global, Hsla, Pixels, px, rgba};

/// Colors, fonts and metrics every view reads — loop desktop's dark theme
/// (apps/web/src/index.css custom properties). Small and `Copy`, so a render
/// function holds its own copy instead of a borrow of the app.
#[derive(Clone, Copy)]
pub struct Theme {
    /// `--background`: the window, the frame and the conversation.
    pub background: Hsla,
    /// `--card` / `--sidebar`.
    pub card: Hsla,
    /// `.dropdown-glass`: menus and pickers float on the popover colour at
    /// 84%, with a faint foreground border.
    pub popover: Hsla,
    pub popover_border: Hsla,
    /// A popover row under the pointer: popover mixed 10% toward foreground.
    pub popover_hover: Hsla,
    pub text: Hsla,
    /// Reply prose is the foreground at 80%.
    pub prose: Hsla,
    pub muted: Hsla,
    /// Placeholder text: muted at 35%.
    pub placeholder: Hsla,
    pub border: Hsla,
    pub frame_border: Hsla,
    pub divider: Hsla,
    pub input_border: Hsla,
    pub hover: Hsla,
    pub selected: Hsla,
    /// A picked row in a menu: foreground at 8%.
    pub checked: Hsla,
    pub rail_active: Hsla,
    /// A user's message bubble.
    pub bubble: Hsla,
    pub code_background: Hsla,
    pub code_block: Hsla,
    /// `--info-foreground`: links.
    pub link: Hsla,
    pub success: Hsla,
    pub primary: Hsla,
    pub on_primary: Hsla,
    pub warning: Hsla,
    pub error: Hsla,
    pub selection: Hsla,
    pub ui_font: &'static str,
    pub mono_font: &'static str,
}

/// `--workspace-topbar-height`.
pub const TOP_BAR_HEIGHT: Pixels = px(52.);
/// `--app-rail-width` (3.25rem).
pub const RAIL_WIDTH: Pixels = px(52.);
/// `--app-frame-inset` and `--app-frame-radius`.
pub const FRAME_INSET: Pixels = px(4.);
pub const FRAME_RADIUS: Pixels = px(13.);
/// Room for the macOS traffic lights at the top bar's left edge.
pub const TRAFFIC_LIGHT_PADDING: Pixels = px(80.);
pub const SIDEBAR_WIDTH: Pixels = px(256.);
/// Every sidebar row shares one height so the list can be virtualised.
pub const LIST_ROW_HEIGHT: Pixels = px(28.);
/// loop's prose: 14px text on a 1.625 line (22.75px).
pub const PROSE_LINE_HEIGHT: f32 = 1.625;
/// The reading column of a conversation (max-w-3xl).
pub const CONVERSATION_WIDTH: Pixels = px(768.);

fn color(hex: u32) -> Hsla {
    rgba(hex).into()
}

impl Theme {
    pub fn loop_dark() -> Self {
        Self {
            background: color(0x141414ff),
            card: color(0x1b1b1bff),
            popover: color(0x212121d5),
            popover_border: color(0xd6d6d61a),
            popover_hover: color(0x333333ff),
            text: color(0xd6d6d6ff),
            prose: color(0xd6d6d6cc),
            muted: color(0x7c7c7cff),
            placeholder: color(0x7c7c7c59),
            border: color(0xffffff12),
            frame_border: color(0xffffff14),
            divider: color(0xffffff0f),
            input_border: color(0xffffff1f),
            hover: color(0xffffff12),
            selected: color(0xffffff0d),
            checked: color(0xd6d6d614),
            rail_active: color(0xffffff1a),
            bubble: color(0xffffff12),
            code_background: color(0xffffff0d),
            code_block: color(0xffffff0a),
            link: color(0x6fa3f8ff),
            success: color(0x6cc58aff),
            primary: color(0x4f8ff7ff),
            on_primary: color(0xffffffff),
            warning: color(0xf5a04aff),
            error: color(0xf27474ff),
            selection: color(0x4f8ff759),
            ui_font: "DM Sans",
            mono_font: "SF Mono",
        }
    }
}

impl Global for Theme {}

pub trait ActiveTheme {
    fn theme(&self) -> Theme;
}

impl ActiveTheme for App {
    fn theme(&self) -> Theme {
        *self.global::<Theme>()
    }
}
