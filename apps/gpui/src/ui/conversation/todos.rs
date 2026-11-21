use gpui::{App, IntoElement, ParentElement, Styled, div, prelude::FluentBuilder, px};

use crate::assets::Icon;
use crate::theme::ActiveTheme;
use crate::transcript::Todo;
use crate::ui::icon::icon;

/// loop's checklist marks: ○ to do, ◌ in progress, ✓ done.
fn mark(status: &str) -> Icon {
    match status {
        "in_progress" => Icon::CircleDashed,
        "completed" => Icon::CircleCheck,
        _ => Icon::Circle,
    }
}

/// The agent's checklist as it stands, above the composer.
pub fn render_todos(todos: &[Todo], cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let done = todos.iter().filter(|todo| todo.status == "completed").count();
    div()
        .flex()
        .flex_col()
        .gap_1()
        .px_3()
        .py_2()
        .rounded(px(12.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.card)
        .text_sm()
        .child(div().text_xs().text_color(theme.muted).child(format!("Todos · {done}/{}", todos.len())))
        .children(todos.iter().map(|todo| {
            let active = todo.status == "in_progress";
            let finished = todo.status == "completed";
            let text = if active { todo.active_form.clone().unwrap_or_else(|| todo.content.clone()) } else { todo.content.clone() };
            div()
                .flex()
                .items_center()
                .gap_2()
                .text_color(if active { theme.text } else { theme.prose })
                .when(finished, |row| row.text_color(theme.muted).line_through())
                .child(icon(mark(&todo.status), if active { theme.primary } else { theme.muted }).size(px(14.)))
                .child(div().min_w_0().child(text))
        }))
}
