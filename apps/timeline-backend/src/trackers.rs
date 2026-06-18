//! Background polling loops that turn Windows observations into persisted segments.

use crate::state::{
    AgentState, OpenBrowserSegment, OpenFocusSegment, OpenPresenceSegment,
    OpenVisibleWindowSegment, RuntimeConfigSnapshot,
};
use crate::system;
use crate::windows::{
    ForegroundWindowSnapshot, VISIBLE_WINDOW_MIN_RATIO, VisibleWindowSnapshot,
    capture_foreground_window, capture_visible_windows, detect_presence,
};
use anyhow::Result;
use common::{AppInfo, PresenceState};
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;
use time::OffsetDateTime;
use tokio::time::sleep;
use tracing::{error, warn};

pub fn spawn_trackers(state: AgentState) {
    let focus_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = run_focus_tracker(focus_state).await {
            error!(?error, "focus tracker stopped");
        }
    });

    let visible_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = run_visible_window_tracker(visible_state).await {
            error!(?error, "visible window tracker stopped");
        }
    });

    tokio::spawn(async move {
        if let Err(error) = run_presence_tracker(state).await {
            error!(?error, "presence tracker stopped");
        }
    });
}

async fn run_focus_tracker(state: AgentState) -> Result<()> {
    loop {
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_focus_online(observed_at).await;

        match capture_foreground_window(runtime_config.record_window_titles) {
            Ok(snapshot) => {
                sync_focus_snapshot(&state, snapshot, observed_at, &runtime_config).await?
            }
            Err(error) => warn!(?error, "failed to read foreground window"),
        }

        sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
    }
}

async fn run_visible_window_tracker(state: AgentState) -> Result<()> {
    loop {
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_visible_windows_online(observed_at).await;

        match capture_visible_windows(runtime_config.record_window_titles) {
            Ok(snapshots) => {
                sync_visible_windows(&state, snapshots, observed_at, &runtime_config).await?
            }
            Err(error) => warn!(?error, "failed to read visible windows"),
        }

        sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
    }
}

async fn run_presence_tracker(state: AgentState) -> Result<()> {
    loop {
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_presence_online(observed_at).await;
        let presence =
            match detect_presence(Duration::from_secs(runtime_config.idle_threshold_secs)) {
                Ok(value) => value,
                Err(error) => {
                    warn!(?error, "failed to read presence state");
                    sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
                    continue;
                }
            };

        sync_presence_state(&state, presence.clone(), observed_at).await?;
        maybe_emit_health_reminder(&state, &runtime_config, &presence, observed_at).await?;
        sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
    }
}

/// Reconciles in-memory focus state with the latest foreground window snapshot.
///
/// State machine transitions:
///   1. Same app (fingerprint unchanged) → touch the existing segment's `last_seen_at`.
///   2. Different app or no window → close the previous focus segment.
///      - If the new app is NOT a browser (or there's no window), also close the
///        active browser segment, since browser domains are only meaningful while
///        a browser is in the foreground.
///   3. Open a new focus segment for the incoming app (unless it's ignored).
async fn sync_focus_snapshot(
    state: &AgentState,
    snapshot: Option<ForegroundWindowSnapshot>,
    observed_at: OffsetDateTime,
    runtime_config: &RuntimeConfigSnapshot,
) -> Result<()> {
    let next_fingerprint = snapshot.as_ref().map(ForegroundWindowSnapshot::fingerprint);
    let leaving_browser = snapshot
        .as_ref()
        .map(|value| !value.is_browser)
        .unwrap_or(true);
    let (touch_current_id, previous_focus) = {
        let mut runtime = state.runtime().await;
        let same_as_current = runtime
            .current_focus
            .as_ref()
            .and_then(|current| {
                next_fingerprint
                    .as_ref()
                    .map(|next| current.fingerprint == *next)
            })
            .unwrap_or(false);

        if same_as_current {
            (
                runtime.current_focus.as_ref().map(|current| current.id),
                None,
            )
        } else {
            (None, runtime.current_focus.take())
        }
    };

    if let Some(current_id) = touch_current_id {
        state
            .store()
            .touch_focus_segment(current_id, observed_at)
            .await?;
        return Ok(());
    }

    if let Some(previous_focus) = previous_focus {
        state
            .store()
            .end_focus_segment(previous_focus.id, observed_at)
            .await?;
    }

    // If the new foreground app is NOT a browser (or no window is focused),
    // close the active browser segment — domain tracking is only valid while
    // a browser is in the foreground.
    if leaving_browser {
        let _browser_transition = state.browser_transition().await;
        let previous_browser = {
            let mut runtime = state.runtime().await;
            runtime.current_browser.take()
        };
        if let Some(previous_browser) = previous_browser {
            state
                .store()
                .end_browser_segment(previous_browser.id, observed_at)
                .await?;
        }
    }

    if let Some(snapshot) = snapshot {
        if is_ignored_app(runtime_config, &snapshot.process_name) {
            return Ok(());
        }

        let display_name = display_name_for_process(&snapshot.process_name);
        let app = AppInfo {
            process_name: snapshot.process_name.clone(),
            display_name: display_name.clone(),
            exe_path: Some(snapshot.exe_path.clone()),
            window_title: if runtime_config.record_window_titles {
                snapshot.window_title.clone()
            } else {
                None
            },
            is_browser: snapshot.is_browser,
        };

        state
            .store()
            .upsert_app_registry(&app.process_name, &app.display_name, observed_at)
            .await?;
        let id = state.store().start_focus_segment(&app, observed_at).await?;
        state
            .store()
            .append_raw_event("focus_changed", &snapshot, observed_at)
            .await?;

        let mut runtime = state.runtime().await;
        runtime.current_focus = Some(OpenFocusSegment {
            id,
            fingerprint: snapshot.fingerprint(),
            is_browser: snapshot.is_browser,
        });
    }

    Ok(())
}

async fn sync_visible_windows(
    state: &AgentState,
    snapshots: Vec<VisibleWindowSnapshot>,
    observed_at: OffsetDateTime,
    runtime_config: &RuntimeConfigSnapshot,
) -> Result<()> {
    let next_windows = trackable_visible_windows(snapshots, runtime_config);
    let (to_close, to_touch, to_open) = {
        let runtime = state.runtime().await;
        let to_close = runtime
            .current_visible_windows
            .iter()
            .filter_map(|(key, current)| {
                if next_windows.contains_key(key) {
                    None
                } else {
                    Some((key.clone(), current.id))
                }
            })
            .collect::<Vec<_>>();
        let to_touch = next_windows
            .iter()
            .filter_map(|(key, snapshot)| {
                runtime
                    .current_visible_windows
                    .get(key)
                    .map(|current| (key.clone(), current.id, snapshot.visible_area_ratio))
            })
            .collect::<Vec<_>>();
        let to_open = next_windows
            .iter()
            .filter_map(|(key, snapshot)| {
                if runtime.current_visible_windows.contains_key(key) {
                    None
                } else {
                    Some((key.clone(), snapshot.clone()))
                }
            })
            .collect::<Vec<_>>();

        (to_close, to_touch, to_open)
    };

    for (_, id) in &to_close {
        state
            .store()
            .end_visible_window_segment(*id, observed_at)
            .await?;
    }

    for (_, id, visible_area_ratio) in &to_touch {
        state
            .store()
            .touch_visible_window_segment(*id, observed_at, *visible_area_ratio)
            .await?;
    }

    let mut opened = Vec::new();
    for (key, snapshot) in to_open {
        let display_name = display_name_for_process(&snapshot.process_name);
        let window = crate::db::VisibleWindowSegmentInput {
            process_name: snapshot.process_name.clone(),
            display_name: display_name.clone(),
            exe_path: Some(snapshot.exe_path.clone()),
            window_title: if runtime_config.record_window_titles {
                snapshot.window_title.clone()
            } else {
                None
            },
            hwnd: snapshot.hwnd as i64,
            process_id: snapshot.process_id,
            visible_area_ratio: snapshot.visible_area_ratio,
        };

        state
            .store()
            .upsert_app_registry(&window.process_name, &window.display_name, observed_at)
            .await?;
        let id = state
            .store()
            .start_visible_window_segment(&window, observed_at)
            .await?;
        opened.push((key, OpenVisibleWindowSegment { id }));
    }

    let mut runtime = state.runtime().await;
    for (key, _) in to_close {
        runtime.current_visible_windows.remove(&key);
    }
    for (key, current) in opened {
        runtime.current_visible_windows.insert(key, current);
    }

    Ok(())
}

fn trackable_visible_windows(
    snapshots: Vec<VisibleWindowSnapshot>,
    runtime_config: &RuntimeConfigSnapshot,
) -> BTreeMap<String, VisibleWindowSnapshot> {
    snapshots
        .into_iter()
        .filter(|snapshot| snapshot.visible_area_ratio > VISIBLE_WINDOW_MIN_RATIO)
        .filter(|snapshot| !is_ignored_app(runtime_config, &snapshot.process_name))
        .map(|snapshot| (snapshot.key(), snapshot))
        .collect()
}

async fn sync_presence_state(
    state: &AgentState,
    presence: PresenceState,
    observed_at: OffsetDateTime,
) -> Result<()> {
    let (touch_current_id, previous_presence) = {
        let mut runtime = state.runtime().await;
        let same_as_current = runtime
            .current_presence
            .as_ref()
            .map(|current| current.state == presence)
            .unwrap_or(false);

        if same_as_current {
            (
                runtime.current_presence.as_ref().map(|current| current.id),
                None,
            )
        } else {
            (None, runtime.current_presence.take())
        }
    };

    if let Some(current_id) = touch_current_id {
        state
            .store()
            .touch_presence_segment(current_id, observed_at)
            .await?;
        return Ok(());
    }

    if let Some(previous_presence) = previous_presence {
        state
            .store()
            .end_presence_segment(previous_presence.id, observed_at)
            .await?;
    }

    let id = state
        .store()
        .start_presence_segment(presence.clone(), observed_at)
        .await?;
    state
        .store()
        .append_raw_event("presence_changed", &presence, observed_at)
        .await?;

    let mut runtime = state.runtime().await;
    runtime.current_presence = Some(OpenPresenceSegment {
        id,
        state: presence,
    });

    Ok(())
}

#[derive(Debug, Serialize)]
struct HealthReminderEvent {
    threshold_secs: u64,
    streak_secs: i64,
}

async fn maybe_emit_health_reminder(
    state: &AgentState,
    runtime_config: &RuntimeConfigSnapshot,
    presence: &PresenceState,
    observed_at: OffsetDateTime,
) -> Result<()> {
    let mut should_notify = false;
    let mut streak_secs = 0i64;
    let threshold_secs = runtime_config.health_reminder_threshold_secs.max(1);

    {
        let mut runtime = state.runtime().await;
        let reminder = &mut runtime.health_reminder;

        if !runtime_config.health_reminder_enabled {
            reminder.active_streak_started_at = None;
            reminder.reminded_for_current_streak = false;
            return Ok(());
        }

        match presence {
            PresenceState::Active => {
                let started_at = reminder.active_streak_started_at.get_or_insert(observed_at);
                let elapsed = (observed_at - *started_at).whole_seconds().max(0);
                if elapsed >= threshold_secs as i64 && !reminder.reminded_for_current_streak {
                    reminder.reminded_for_current_streak = true;
                    should_notify = true;
                    streak_secs = elapsed;
                }
            }
            PresenceState::Idle | PresenceState::Locked => {
                reminder.active_streak_started_at = None;
                reminder.reminded_for_current_streak = false;
            }
        }
    }

    if should_notify {
        state
            .store()
            .append_raw_event(
                "health_break_reminder",
                &HealthReminderEvent {
                    threshold_secs,
                    streak_secs,
                },
                observed_at,
            )
            .await?;
        system::show_break_reminder(streak_secs);
    }

    Ok(())
}

/// Processes an incoming browser extension event.
///
/// Decision tree:
///   1. Domain is in `ignored_domains` → close current browser segment, reject.
///   2. No browser is the foreground app → close current browser segment, reject.
///   3. Same domain + window + tab as current → touch `last_seen_at`, accept.
///   4. Different domain/tab → close previous browser segment, open new one, accept.
pub async fn sync_browser_event(
    state: &AgentState,
    payload: common::BrowserEventPayload,
    observed_at: OffsetDateTime,
) -> Result<common::BrowserEventAck> {
    let runtime_config = state.runtime_config_snapshot().await;
    let payload = browser_payload_for_storage(payload, runtime_config.record_page_titles);
    state.mark_browser_online(observed_at).await;
    state
        .store()
        .append_raw_event("browser_event", &payload, observed_at)
        .await?;

    let _browser_transition = state.browser_transition().await;

    if is_ignored_domain(&runtime_config, &payload.domain) {
        let current = {
            let mut runtime = state.runtime().await;
            runtime.current_browser.take()
        };
        if let Some(current) = current {
            state
                .store()
                .end_browser_segment(current.id, observed_at)
                .await?;
        }

        return Ok(common::BrowserEventAck {
            accepted: false,
            reason: Some("domain is ignored by local config".to_string()),
        });
    }

    let browser_is_foreground = {
        let runtime = state.runtime().await;
        runtime
            .current_focus
            .as_ref()
            .map(|focus| focus.is_browser)
            .unwrap_or(false)
    } || capture_foreground_window(false)
        .ok()
        .flatten()
        .map(|snapshot| snapshot.is_browser)
        .unwrap_or(false);
    if !browser_is_foreground {
        let current = {
            let mut runtime = state.runtime().await;
            runtime.current_browser.take()
        };
        if let Some(current) = current {
            state
                .store()
                .end_browser_segment(current.id, observed_at)
                .await?;
        }

        return Ok(common::BrowserEventAck {
            accepted: false,
            reason: Some("browser is not the foreground app".to_string()),
        });
    }

    let browser_transition = {
        let mut runtime = state.runtime().await;
        match runtime.current_browser.as_ref() {
            Some(current)
                if current.domain == payload.domain
                    && current.browser_window_id == payload.browser_window_id
                    && current.tab_id == payload.tab_id =>
            {
                BrowserTransition::Touch(current.id)
            }
            _ => BrowserTransition::Replace(runtime.current_browser.take()),
        }
    };

    match browser_transition {
        BrowserTransition::Touch(current_id) => {
            state
                .store()
                .touch_browser_segment(current_id, observed_at)
                .await?;
            return Ok(common::BrowserEventAck {
                accepted: true,
                reason: None,
            });
        }
        BrowserTransition::Replace(current) => {
            if let Some(current) = current {
                state
                    .store()
                    .end_browser_segment(current.id, observed_at)
                    .await?;
            }
        }
    }

    let id = state
        .store()
        .start_browser_segment(&payload, observed_at)
        .await?;
    let mut runtime = state.runtime().await;
    runtime.current_browser = Some(OpenBrowserSegment {
        id,
        domain: payload.domain.clone(),
        browser_window_id: payload.browser_window_id,
        tab_id: payload.tab_id,
    });

    Ok(common::BrowserEventAck {
        accepted: true,
        reason: None,
    })
}

enum BrowserTransition {
    Touch(i64),
    Replace(Option<OpenBrowserSegment>),
}

fn is_ignored_app(runtime_config: &RuntimeConfigSnapshot, process_name: &str) -> bool {
    runtime_config
        .ignored_apps
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(process_name))
}

fn is_ignored_domain(runtime_config: &RuntimeConfigSnapshot, domain: &str) -> bool {
    runtime_config
        .ignored_domains
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(domain))
}

fn browser_payload_for_storage(
    payload: common::BrowserEventPayload,
    record_page_titles: bool,
) -> common::BrowserEventPayload {
    common::BrowserEventPayload {
        page_title: if record_page_titles {
            payload.page_title
        } else {
            None
        },
        ..payload
    }
}

fn display_name_for_process(process_name: &str) -> String {
    match process_name.to_ascii_lowercase().as_str() {
        "msedge.exe" => "Microsoft Edge".to_string(),
        "chrome.exe" => "Google Chrome".to_string(),
        "firefox.exe" => "Mozilla Firefox".to_string(),
        "code.exe" => "Visual Studio Code".to_string(),
        "explorer.exe" => "Windows Explorer".to_string(),
        "wezterm-gui.exe" => "WezTerm".to_string(),
        other => other
            .trim_end_matches(".exe")
            .split(['-', '_'])
            .filter(|part| !part.is_empty())
            .map(title_case_word)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn title_case_word(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => {
            let mut result = String::new();
            result.extend(first.to_uppercase());
            result.push_str(&characters.as_str().to_ascii_lowercase());
            result
        }
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{browser_payload_for_storage, trackable_visible_windows};
    use crate::state::RuntimeConfigSnapshot;
    use crate::windows::VisibleWindowSnapshot;

    fn browser_payload(page_title: Option<&str>) -> common::BrowserEventPayload {
        common::BrowserEventPayload {
            domain: "example.com".to_string(),
            page_title: page_title.map(str::to_string),
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
        }
    }

    fn runtime_config() -> RuntimeConfigSnapshot {
        RuntimeConfigSnapshot {
            idle_threshold_secs: 300,
            poll_interval_millis: 1000,
            health_reminder_enabled: true,
            health_reminder_threshold_secs: 3000,
            record_window_titles: true,
            record_page_titles: true,
            ignored_apps: vec!["ignored.exe".to_string()],
            ignored_domains: Vec::new(),
        }
    }

    fn visible_snapshot(process_name: &str, ratio: f64) -> VisibleWindowSnapshot {
        VisibleWindowSnapshot {
            hwnd: 100,
            process_id: 200,
            session_id: 1,
            process_name: process_name.to_string(),
            exe_path: format!(r"C:\Apps\{process_name}"),
            window_title: Some("Window".to_string()),
            visible_area_ratio: ratio,
        }
    }

    #[test]
    fn strips_page_title_when_recording_is_disabled() {
        let payload = browser_payload_for_storage(browser_payload(Some("Private page")), false);

        assert_eq!(payload.page_title, None);
    }

    #[test]
    fn keeps_page_title_when_recording_is_enabled() {
        let payload = browser_payload_for_storage(browser_payload(Some("Useful page")), true);

        assert_eq!(payload.page_title.as_deref(), Some("Useful page"));
    }

    #[test]
    fn trackable_visible_windows_filter_ignored_and_tiny_windows() {
        let windows = vec![
            visible_snapshot("code.exe", 0.5),
            visible_snapshot("ignored.exe", 0.9),
            visible_snapshot("tiny.exe", 0.05),
        ];

        let result = trackable_visible_windows(windows, &runtime_config());

        assert_eq!(result.len(), 1);
        assert!(
            result
                .values()
                .any(|window| window.process_name == "code.exe")
        );
    }
}
