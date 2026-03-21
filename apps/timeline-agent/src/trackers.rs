//! Background polling loops that turn Windows observations into persisted segments.

use crate::state::{AgentState, OpenBrowserSegment, OpenFocusSegment, OpenPresenceSegment};
use crate::windows::{ForegroundWindowSnapshot, capture_foreground_window, detect_presence};
use anyhow::Result;
use common::{AppInfo, PresenceState};
use std::time::Duration;
use time::OffsetDateTime;
use tokio::time::{MissedTickBehavior, interval};
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
    let mut ticker = interval(Duration::from_millis(state.config().poll_interval_millis));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_focus_online(observed_at).await;

        match capture_foreground_window() {
            Ok(snapshot) => sync_focus_snapshot(&state, snapshot, observed_at).await?,
            Err(error) => warn!(?error, "failed to read foreground window"),
        }
    }
}

async fn run_presence_tracker(state: AgentState) -> Result<()> {
    let mut ticker = interval(Duration::from_millis(state.config().poll_interval_millis));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_presence_online(observed_at).await;
        let presence =
            match detect_presence(Duration::from_secs(state.config().idle_threshold_secs)) {
                Ok(value) => value,
                Err(error) => {
                    warn!(?error, "failed to read presence state");
                    continue;
                }
            };

        sync_presence_state(&state, presence, observed_at).await?;
    }
}

async fn sync_focus_snapshot(
    state: &AgentState,
    snapshot: Option<ForegroundWindowSnapshot>,
    observed_at: OffsetDateTime,
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
        return Ok(());
    }

    if let Some(previous_focus) = runtime.current_focus.take() {
        state
            .store()
            .end_focus_segment(previous_focus.id, observed_at)
            .await?;
    }

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
        if is_ignored_app(state, &snapshot.process_name) {
            return Ok(());
        }

        let display_name = display_name_for_process(&snapshot.process_name);
        let app = AppInfo {
            process_name: snapshot.process_name.clone(),
            display_name: display_name.clone(),
            exe_path: Some(snapshot.exe_path.clone()),
            window_title: if state.config().record_window_titles {
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

pub async fn sync_browser_event(
    state: &AgentState,
    payload: common::BrowserEventPayload,
    observed_at: OffsetDateTime,
) -> Result<common::BrowserEventAck> {
    let mut runtime = state.runtime().await;
    state.mark_browser_online(observed_at).await;
    state
        .store()
        .append_raw_event("browser_event", &payload, observed_at)
        .await?;

    if is_ignored_domain(state, &payload.domain) {
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
        page_title: if state.config().record_page_titles {
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

fn is_ignored_app(state: &AgentState, process_name: &str) -> bool {
    state
        .config()
        .ignored_apps
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(process_name))
}

fn is_ignored_domain(state: &AgentState, domain: &str) -> bool {
    state
        .config()
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
