//! Background polling loops that turn Windows observations into persisted segments.

use crate::state::{
    AgentState, OpenBrowserSegment, OpenFocusSegment, OpenPresenceSegment, RuntimeConfigSnapshot,
};
use crate::system;
use crate::windows::{ForegroundWindowSnapshot, capture_foreground_window, detect_presence};
use anyhow::Result;
use common::{AppInfo, PresenceState};
use serde::Serialize;
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

        match capture_foreground_window() {
            Ok(snapshot) => {
                sync_focus_snapshot(&state, snapshot, observed_at, &runtime_config).await?
            }
            Err(error) => warn!(?error, "failed to read foreground window"),
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
        if let Some(current) = runtime.current_focus.as_ref() {
            state
                .store()
                .touch_focus_segment(current.id, observed_at)
                .await?;
        }
        return Ok(());
    }

    if let Some(previous_focus) = runtime.current_focus.take() {
        state
            .store()
            .end_focus_segment(previous_focus.id, observed_at)
            .await?;
    }

    // If the new foreground app is NOT a browser (or no window is focused),
    // close the active browser segment — domain tracking is only valid while
    // a browser is in the foreground.
    let leaving_browser = snapshot
        .as_ref()
        .map(|value| !value.is_browser)
        .unwrap_or(true);
    if leaving_browser {
        if let Some(previous_browser) = runtime.current_browser.take() {
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

        runtime.current_focus = Some(OpenFocusSegment {
            id,
            fingerprint: snapshot.fingerprint(),
            is_browser: snapshot.is_browser,
        });
    }

    Ok(())
}

async fn sync_presence_state(
    state: &AgentState,
    presence: PresenceState,
    observed_at: OffsetDateTime,
) -> Result<()> {
    let mut runtime = state.runtime().await;

    let same_as_current = runtime
        .current_presence
        .as_ref()
        .map(|current| current.state == presence)
        .unwrap_or(false);
    if same_as_current {
        if let Some(current) = runtime.current_presence.as_ref() {
            state
                .store()
                .touch_presence_segment(current.id, observed_at)
                .await?;
        }
        return Ok(());
    }

    if let Some(previous_presence) = runtime.current_presence.take() {
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
    let mut runtime = state.runtime().await;
    state.mark_browser_online(observed_at).await;
    state
        .store()
        .append_raw_event("browser_event", &payload, observed_at)
        .await?;

    if is_ignored_domain(&runtime_config, &payload.domain) {
        if let Some(current) = runtime.current_browser.take() {
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

    let browser_is_foreground = runtime
        .current_focus
        .as_ref()
        .map(|focus| focus.is_browser)
        .unwrap_or(false)
        || capture_foreground_window()
            .ok()
            .flatten()
            .map(|snapshot| snapshot.is_browser)
            .unwrap_or(false);
    if !browser_is_foreground {
        if let Some(current) = runtime.current_browser.take() {
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

    let same_segment = runtime.current_browser.as_ref().map(|current| {
        current.domain == payload.domain
            && current.browser_window_id == payload.browser_window_id
            && current.tab_id == payload.tab_id
    });
    if same_segment.unwrap_or(false) {
        if let Some(current) = runtime.current_browser.as_ref() {
            state
                .store()
                .touch_browser_segment(current.id, observed_at)
                .await?;
        }
        return Ok(common::BrowserEventAck {
            accepted: true,
            reason: None,
        });
    }

    if let Some(current) = runtime.current_browser.take() {
        state
            .store()
            .end_browser_segment(current.id, observed_at)
            .await?;
    }

    let payload = common::BrowserEventPayload {
        page_title: if runtime_config.record_page_titles {
            payload.page_title
        } else {
            None
        },
        ..payload
    };

    let id = state
        .store()
        .start_browser_segment(&payload, observed_at)
        .await?;
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
