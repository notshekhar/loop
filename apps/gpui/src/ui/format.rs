use std::time::{SystemTime, UNIX_EPOCH};

const MINUTE: u64 = 60_000;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

/// How long ago `then` was, the way loop's sidebar says it
/// (apps/web timestampFormat.ts formatRelativeTime): "now", "5m", "3h",
/// then days with no larger unit — "20d", "400d".
pub fn age(now: u64, then: u64) -> String {
    let elapsed = now.saturating_sub(then);
    match elapsed {
        elapsed if elapsed < MINUTE => "now".into(),
        elapsed if elapsed < HOUR => format!("{}m", elapsed / MINUTE),
        elapsed if elapsed < DAY => format!("{}h", elapsed / HOUR),
        elapsed => format!("{}d", elapsed / DAY),
    }
}

/// A thought's length as loop prints it: "0.7s" under ten seconds, "14s"
/// above.
/// `HH:MM` in local time, for an epoch-milliseconds timestamp.
pub fn clock(ms: u64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms as i64).single().map(|time| time.format("%H:%M").to_string()).unwrap_or_default()
}

pub fn seconds(ms: u64) -> String {
    // Branch on the rounded value, as loop does: branching on the raw one
    // printed "60s" for 119.7s.
    let tenths = (ms as f64 / 100.).round() / 10.;
    if tenths < 10. {
        return format!("{tenths:.1}s");
    }
    let rounded = (ms as f64 / 1000.).round() as u64;
    if rounded < 60 { format!("{rounded}s") } else { format!("{}m{:02}s", rounded / 60, rounded % 60) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ages_match_loop() {
        let now = 1_000 * DAY;
        assert_eq!(age(now, now - 30_000), "now");
        assert_eq!(age(now, now - 5 * MINUTE), "5m");
        assert_eq!(age(now, now - 3 * HOUR - MINUTE), "3h");
        assert_eq!(age(now, now - 20 * DAY), "20d");
        assert_eq!(age(now, now - 400 * DAY), "400d");
        assert_eq!(age(now, now + HOUR), "now");
    }

    #[test]
    fn thought_durations_match_loop() {
        assert_eq!(seconds(700), "0.7s");
        assert_eq!(seconds(1840), "1.8s");
        assert_eq!(seconds(14_426), "14s");
        assert_eq!(seconds(9_960), "10s");
        assert_eq!(seconds(83_000), "1m23s");
        assert_eq!(seconds(119_700), "2m00s");
    }
}
