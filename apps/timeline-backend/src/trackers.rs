//! Background polling loops that turn Windows observations into persisted segments.

use crate::config::DailyTimeWindow;
use crate::state::{
    AgentState, OpenBrowserSegment, OpenFocusSegment, OpenPresenceSegment, RuntimeConfigSnapshot,
};
use crate::system;
use crate::windows::{ForegroundWindowSnapshot, capture_foreground_window, detect_presence};
use anyhow::Result;
use common::{AppInfo, PresenceState};
use serde::Serialize;
use std::time::Duration;
use time::{OffsetDateTime, Time};
use tokio::time::sleep;
use tracing::{error, warn};

const TRACKER_RESTART_MAX_BACKOFF: Duration = Duration::from_secs(30);

pub fn spawn_trackers(state: AgentState) {
    let focus_state = state.clone();
    tokio::spawn(async move {
        supervise_focus_tracker(focus_state).await;
    });

    tokio::spawn(async move {
        supervise_presence_tracker(state).await;
    });
}

async fn supervise_focus_tracker(state: AgentState) {
    let mut backoff = Duration::from_secs(1);
    while !state.shutdown_requested() {
        match run_focus_tracker(state.clone()).await {
            Ok(()) => return,
            Err(error) => {
                state.mark_focus_failed(&error.to_string()).await;
                error!(?error, ?backoff, "focus tracker failed; scheduling restart");
                if wait_for_shutdown(&state, backoff).await {
                    return;
                }
                state.mark_focus_restarted().await;
                backoff = std::cmp::min(backoff.saturating_mul(2), TRACKER_RESTART_MAX_BACKOFF);
            }
        }
    }
}

async fn supervise_presence_tracker(state: AgentState) {
    let mut backoff = Duration::from_secs(1);
    while !state.shutdown_requested() {
        match run_presence_tracker(state.clone()).await {
            Ok(()) => return,
            Err(error) => {
                state.mark_presence_failed(&error.to_string()).await;
                error!(
                    ?error,
                    ?backoff,
                    "presence tracker failed; scheduling restart"
                );
                if wait_for_shutdown(&state, backoff).await {
                    return;
                }
                state.mark_presence_restarted().await;
                backoff = std::cmp::min(backoff.saturating_mul(2), TRACKER_RESTART_MAX_BACKOFF);
            }
        }
    }
}

async fn run_focus_tracker(state: AgentState) -> Result<()> {
    let mut observation_backoff = Duration::from_secs(1);
    loop {
        if state.shutdown_requested() {
            return Ok(());
        }
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        let (paused, _, pause_until) = state.tracking_pause_state().await;
        if paused {
            if pause_until.is_some_and(|until| until <= observed_at) {
                resume_tracking(&state).await?;
            } else {
                if wait_for_shutdown(
                    &state,
                    Duration::from_millis(runtime_config.poll_interval_millis),
                )
                .await
                {
                    return Ok(());
                }
                continue;
            }
        }

        match capture_foreground_window(runtime_config.record_window_titles) {
            Ok(snapshot) => {
                sync_focus_snapshot(&state, snapshot, observed_at, &runtime_config).await?;
                state.mark_focus_online(observed_at).await;
                observation_backoff = Duration::from_secs(1);
            }
            Err(error) => {
                state.mark_focus_failed(&error.to_string()).await;
                warn!(
                    ?error,
                    ?observation_backoff,
                    "failed to read foreground window"
                );
                if wait_for_shutdown(&state, observation_backoff).await {
                    return Ok(());
                }
                observation_backoff = std::cmp::min(
                    observation_backoff.saturating_mul(2),
                    TRACKER_RESTART_MAX_BACKOFF,
                );
                continue;
            }
        }

        if wait_for_shutdown(
            &state,
            Duration::from_millis(runtime_config.poll_interval_millis),
        )
        .await
        {
            return Ok(());
        }
    }
}

async fn run_presence_tracker(state: AgentState) -> Result<()> {
    let mut observation_backoff = Duration::from_secs(1);
    loop {
        if state.shutdown_requested() {
            return Ok(());
        }
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        let (paused, _, pause_until) = state.tracking_pause_state().await;
        if paused {
            if pause_until.is_some_and(|until| until <= observed_at) {
                resume_tracking(&state).await?;
            } else {
                sync_presence_state(&state, PresenceState::Paused, observed_at).await?;
                state.mark_presence_online(observed_at).await;
                if wait_for_shutdown(
                    &state,
                    Duration::from_millis(runtime_config.poll_interval_millis),
                )
                .await
                {
                    return Ok(());
                }
                continue;
            }
        }
        let presence =
            match detect_presence(Duration::from_secs(runtime_config.idle_threshold_secs)) {
                Ok(value) => value,
                Err(error) => {
                    state.mark_presence_failed(&error.to_string()).await;
                    warn!(
                        ?error,
                        ?observation_backoff,
                        "failed to read presence state"
                    );
                    if wait_for_shutdown(&state, observation_backoff).await {
                        return Ok(());
                    }
                    observation_backoff = std::cmp::min(
                        observation_backoff.saturating_mul(2),
                        TRACKER_RESTART_MAX_BACKOFF,
                    );
                    continue;
                }
            };

        sync_presence_state(&state, presence.clone(), observed_at).await?;
        maybe_emit_health_reminder(&state, &runtime_config, &presence, observed_at).await?;
        state.mark_presence_online(observed_at).await;
        observation_backoff = Duration::from_secs(1);
        if wait_for_shutdown(
            &state,
            Duration::from_millis(runtime_config.poll_interval_millis),
        )
        .await
        {
            return Ok(());
        }
    }
}

async fn wait_for_shutdown(state: &AgentState, duration: Duration) -> bool {
    let mut shutdown_rx = state.subscribe_shutdown();
    tokio::select! {
        _ = sleep(duration) => state.shutdown_requested(),
        _ = shutdown_rx.changed() => true,
    }
}

pub async fn shutdown_open_segments(state: &AgentState) -> Result<()> {
    let _collector_transition = state.collector_transition().await;
    let observed_at = OffsetDateTime::now_utc();
    let (focus, browser, presence) = {
        let mut runtime = state.runtime().await;
        (
            runtime.current_focus.take(),
            runtime.current_browser.take(),
            runtime.current_presence.take(),
        )
    };

    let mut first_error = None;
    if let Some(browser) = browser
        && let Err(error) = state
            .store()
            .end_browser_segment(browser.id, observed_at)
            .await
    {
        first_error = Some(error);
    }
    if let Some(focus) = focus
        && let Err(error) = state.store().end_focus_segment(focus.id, observed_at).await
        && first_error.is_none()
    {
        first_error = Some(error);
    }
    if let Some(presence) = presence
        && let Err(error) = state
            .store()
            .end_presence_segment(presence.id, observed_at)
            .await
        && first_error.is_none()
    {
        first_error = Some(error);
    }

    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub async fn restore_tracking_pause(state: &AgentState) -> Result<()> {
    let paused_since = state
        .store()
        .runtime_setting("paused_since")
        .await?
        .map(|value| OffsetDateTime::parse(&value, &time::format_description::well_known::Rfc3339))
        .transpose()?;
    let pause_until = state
        .store()
        .runtime_setting("pause_until")
        .await?
        .map(|value| OffsetDateTime::parse(&value, &time::format_description::well_known::Rfc3339))
        .transpose()?;
    if paused_since.is_some() && pause_until.is_none_or(|until| until > OffsetDateTime::now_utc()) {
        state
            .set_tracking_pause_state(true, paused_since, pause_until)
            .await;
    } else {
        state
            .store()
            .set_runtime_setting("paused_since", None)
            .await?;
        state
            .store()
            .set_runtime_setting("pause_until", None)
            .await?;
    }
    Ok(())
}

pub async fn pause_tracking(
    state: &AgentState,
    pause_until: Option<OffsetDateTime>,
) -> Result<common::TrackingStateResponse> {
    let _collector_transition = state.collector_transition().await;
    let observed_at = OffsetDateTime::now_utc();
    let (focus, browser, presence) = {
        let mut runtime = state.runtime().await;
        (
            runtime.current_focus.take(),
            runtime.current_browser.take(),
            runtime.current_presence.take(),
        )
    };
    if let Some(browser) = browser {
        state
            .store()
            .end_browser_segment(browser.id, observed_at)
            .await?;
    }
    if let Some(focus) = focus {
        state
            .store()
            .end_focus_segment(focus.id, observed_at)
            .await?;
    }
    if let Some(presence) = presence {
        state
            .store()
            .end_presence_segment(presence.id, observed_at)
            .await?;
    }
    let presence_id = state
        .store()
        .start_presence_segment(PresenceState::Paused, observed_at)
        .await?;
    {
        let mut runtime = state.runtime().await;
        runtime.current_presence = Some(OpenPresenceSegment {
            id: presence_id,
            state: PresenceState::Paused,
            last_observed_at: observed_at,
            last_persisted_at: observed_at,
        });
    }
    state
        .set_tracking_pause_state(true, Some(observed_at), pause_until)
        .await;
    state
        .store()
        .set_runtime_setting(
            "paused_since",
            Some(&observed_at.format(&time::format_description::well_known::Rfc3339)?),
        )
        .await?;
    let pause_until_text = pause_until
        .map(|value| value.format(&time::format_description::well_known::Rfc3339))
        .transpose()?;
    state
        .store()
        .set_runtime_setting("pause_until", pause_until_text.as_deref())
        .await?;
    Ok(common::TrackingStateResponse {
        tracking_paused: true,
        paused_since: Some(observed_at),
        pause_until,
    })
}

pub async fn resume_tracking(state: &AgentState) -> Result<common::TrackingStateResponse> {
    let _collector_transition = state.collector_transition().await;
    let observed_at = OffsetDateTime::now_utc();
    let presence = {
        let mut runtime = state.runtime().await;
        runtime.current_presence.take()
    };
    if let Some(presence) = presence {
        state
            .store()
            .end_presence_segment(presence.id, observed_at)
            .await?;
    }
    state.set_tracking_pause_state(false, None, None).await;
    state
        .store()
        .set_runtime_setting("paused_since", None)
        .await?;
    state
        .store()
        .set_runtime_setting("pause_until", None)
        .await?;
    Ok(common::TrackingStateResponse {
        tracking_paused: false,
        paused_since: None,
        pause_until: None,
    })
}

pub async fn reconcile_runtime_config(state: &AgentState) -> Result<()> {
    let runtime_config = state.runtime_config_snapshot().await;
    let _collector_transition = state.collector_transition().await;
    let observed_at = OffsetDateTime::now_utc();
    let (focus_to_close, browser_to_close) = {
        let mut runtime = state.runtime().await;
        let focus_is_ignored = runtime
            .current_focus
            .as_ref()
            .is_some_and(|focus| is_ignored_app(&runtime_config, &focus.process_name));
        let browser_is_ignored = runtime
            .current_browser
            .as_ref()
            .is_some_and(|browser| is_ignored_domain(&runtime_config, &browser.domain));
        let focus = focus_is_ignored
            .then(|| runtime.current_focus.take())
            .flatten();
        let browser = (focus_is_ignored || browser_is_ignored)
            .then(|| runtime.current_browser.take())
            .flatten();
        (focus, browser)
    };

    if let Some(browser) = browser_to_close {
        state
            .store()
            .end_browser_segment(browser.id, observed_at)
            .await?;
    }
    if let Some(focus) = focus_to_close {
        state
            .store()
            .end_focus_segment(focus.id, observed_at)
            .await?;
    }
    Ok(())
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
    let _collector_transition = state.collector_transition().await;
    let ignored_snapshot = snapshot
        .as_ref()
        .is_some_and(|value| is_ignored_app(runtime_config, &value.process_name));
    let next_fingerprint = snapshot
        .as_ref()
        .filter(|_| !ignored_snapshot)
        .map(ForegroundWindowSnapshot::fingerprint);
    let leaving_browser = ignored_snapshot
        || snapshot
            .as_ref()
            .map(|value| !value.is_browser)
            .unwrap_or(true);
    let (touch_current, previous_focus) = {
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
            let current = runtime
                .current_focus
                .as_mut()
                .expect("current focus exists");
            current.last_observed_at = std::cmp::max(current.last_observed_at, observed_at);
            let persist_at =
                heartbeat_flush_due(current.last_persisted_at, current.last_observed_at)
                    .then_some(current.last_observed_at);
            (Some((current.id, persist_at)), None)
        } else {
            (None, runtime.current_focus.take())
        }
    };

    if let Some((current_id, persist_at)) = touch_current {
        if let Some(persist_at) = persist_at {
            state
                .store()
                .touch_focus_segment(current_id, persist_at)
                .await?;
            let mut runtime = state.runtime().await;
            if let Some(current) = runtime.current_focus.as_mut()
                && current.id == current_id
            {
                current.last_persisted_at = persist_at;
            }
        }
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
            process_name: snapshot.process_name,
            is_browser: snapshot.is_browser,
            last_observed_at: observed_at,
            last_persisted_at: observed_at,
        });
    }

    Ok(())
}

async fn sync_presence_state(
    state: &AgentState,
    presence: PresenceState,
    observed_at: OffsetDateTime,
) -> Result<()> {
    let _collector_transition = state.collector_transition().await;
    let (touch_current, previous_presence) = {
        let mut runtime = state.runtime().await;
        let same_as_current = runtime
            .current_presence
            .as_ref()
            .map(|current| current.state == presence)
            .unwrap_or(false);

        if same_as_current {
            let current = runtime
                .current_presence
                .as_mut()
                .expect("current presence exists");
            current.last_observed_at = std::cmp::max(current.last_observed_at, observed_at);
            let persist_at =
                heartbeat_flush_due(current.last_persisted_at, current.last_observed_at)
                    .then_some(current.last_observed_at);
            (Some((current.id, persist_at)), None)
        } else {
            (None, runtime.current_presence.take())
        }
    };

    if let Some((current_id, persist_at)) = touch_current {
        if let Some(persist_at) = persist_at {
            state
                .store()
                .touch_presence_segment(current_id, persist_at)
                .await?;
            let mut runtime = state.runtime().await;
            if let Some(current) = runtime.current_presence.as_mut()
                && current.id == current_id
            {
                current.last_persisted_at = persist_at;
            }
        }
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
        last_observed_at: observed_at,
        last_persisted_at: observed_at,
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
    let local_observed_at = observed_at.to_offset(
        state
            .store()
            .local_offset_at(observed_at)
            .unwrap_or_else(|_| state.timezone()),
    );
    let local_time = local_observed_at.time();
    let local_date = local_observed_at.date();
    let reminder_allowed = health_reminder_allowed(
        runtime_config.health_reminder_work_hours,
        runtime_config.health_reminder_quiet_hours,
        local_time,
    );

    {
        let mut runtime = state.runtime().await;
        let reminder = &mut runtime.health_reminder;

        if !runtime_config.health_reminder_enabled {
            reminder.active_streak_started_at = None;
            reminder.reminded_for_current_streak = false;
            reminder.rest_started_at = None;
            reminder.snoozed_until = None;
            reminder.dismissed_local_date = None;
            return Ok(());
        }

        if reminder
            .dismissed_local_date
            .is_some_and(|dismissed_date| dismissed_date != local_date)
        {
            reminder.dismissed_local_date = None;
            reminder.reminded_for_current_streak = false;
        }
        if reminder
            .snoozed_until
            .is_some_and(|snoozed_until| observed_at >= snoozed_until)
        {
            reminder.snoozed_until = None;
        }
        let temporarily_suppressed = reminder
            .snoozed_until
            .is_some_and(|snoozed_until| observed_at < snoozed_until)
            || reminder.dismissed_local_date == Some(local_date);

        match presence {
            PresenceState::Active => {
                if let Some(rest_started_at) = reminder.rest_started_at.take()
                    && (observed_at - rest_started_at).whole_seconds() >= 180
                {
                    reminder.active_streak_started_at = None;
                    reminder.reminded_for_current_streak = false;
                    reminder.snoozed_until = None;
                }
                let started_at = reminder.active_streak_started_at.get_or_insert(observed_at);
                let elapsed = (observed_at - *started_at).whole_seconds().max(0);
                if elapsed >= threshold_secs as i64
                    && !reminder.reminded_for_current_streak
                    && reminder_allowed
                    && !temporarily_suppressed
                {
                    reminder.reminded_for_current_streak = true;
                    should_notify = true;
                    streak_secs = elapsed;
                }
            }
            PresenceState::Idle | PresenceState::Locked | PresenceState::Paused => {
                let rest_started_at = reminder.rest_started_at.get_or_insert(observed_at);
                if (observed_at - *rest_started_at).whole_seconds() >= 180 {
                    reminder.active_streak_started_at = None;
                    reminder.reminded_for_current_streak = false;
                    reminder.snoozed_until = None;
                }
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
        system::show_break_reminder(state.clone(), streak_secs);
    }

    Ok(())
}

fn health_reminder_allowed(
    work_hours: Option<DailyTimeWindow>,
    quiet_hours: Option<DailyTimeWindow>,
    local_time: Time,
) -> bool {
    work_hours.is_none_or(|window| window.contains(local_time))
        && quiet_hours.is_none_or(|window| !window.contains(local_time))
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
    let _collector_transition = state.collector_transition().await;
    state
        .store()
        .append_raw_event("browser_event", &payload, observed_at)
        .await?;

    if state.tracking_pause_state().await.0 {
        state.mark_browser_online(observed_at).await;
        return Ok(common::BrowserEventAck {
            accepted: false,
            reason: Some("tracking is paused".to_string()),
        });
    }

    let latest_browser_observation = {
        let runtime = state.runtime().await;
        runtime
            .current_browser
            .as_ref()
            .map(|current| current.last_observed_at)
    };
    if latest_browser_observation.is_some_and(|latest| observed_at < latest) {
        state.mark_browser_online(observed_at).await;
        return Ok(common::BrowserEventAck {
            accepted: false,
            reason: Some("stale browser observation".to_string()),
        });
    }

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

        state.mark_browser_online(observed_at).await;
        return Ok(common::BrowserEventAck {
            accepted: false,
            reason: Some("domain is ignored by local config".to_string()),
        });
    }

    let browser_is_foreground_in_runtime = {
        let runtime = state.runtime().await;
        runtime
            .current_focus
            .as_ref()
            .map(|focus| focus.is_browser)
            .unwrap_or(false)
    };
    let browser_is_foreground_in_snapshot = capture_foreground_window(false)
        .ok()
        .flatten()
        .map(|snapshot| {
            snapshot.is_browser && !is_ignored_app(&runtime_config, &snapshot.process_name)
        })
        .unwrap_or(false);
    let browser_is_foreground =
        browser_is_foreground_in_runtime || browser_is_foreground_in_snapshot;
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

        state.mark_browser_online(observed_at).await;
        return Ok(common::BrowserEventAck {
            accepted: false,
            reason: Some("browser is not the foreground app".to_string()),
        });
    }

    let browser_transition = {
        let mut runtime = state.runtime().await;
        let same_as_current = runtime.current_browser.as_ref().is_some_and(|current| {
            current.domain == payload.domain
                && current.browser_window_id == payload.browser_window_id
                && current.tab_id == payload.tab_id
        });
        if same_as_current {
            let current = runtime
                .current_browser
                .as_mut()
                .expect("current browser exists");
            current.last_observed_at = std::cmp::max(current.last_observed_at, observed_at);
            let persist_at =
                heartbeat_flush_due(current.last_persisted_at, current.last_observed_at)
                    .then_some(current.last_observed_at);
            BrowserTransition::Touch {
                id: current.id,
                persist_at,
            }
        } else {
            BrowserTransition::Replace(runtime.current_browser.take())
        }
    };

    match browser_transition {
        BrowserTransition::Touch {
            id: current_id,
            persist_at,
        } => {
            if let Some(persist_at) = persist_at {
                state
                    .store()
                    .touch_browser_segment(current_id, persist_at)
                    .await?;
                let mut runtime = state.runtime().await;
                if let Some(current) = runtime.current_browser.as_mut()
                    && current.id == current_id
                {
                    current.last_persisted_at = persist_at;
                }
            }
            state.mark_browser_online(observed_at).await;
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
        last_observed_at: observed_at,
        last_persisted_at: observed_at,
    });

    state.mark_browser_online(observed_at).await;
    Ok(common::BrowserEventAck {
        accepted: true,
        reason: None,
    })
}

enum BrowserTransition {
    Touch {
        id: i64,
        persist_at: Option<OffsetDateTime>,
    },
    Replace(Option<OpenBrowserSegment>),
}

fn heartbeat_flush_due(last_persisted_at: OffsetDateTime, observed_at: OffsetDateTime) -> bool {
    (observed_at - last_persisted_at).whole_seconds() >= 10
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
    use super::{browser_payload_for_storage, health_reminder_allowed, heartbeat_flush_due};
    use crate::config::DailyTimeWindow;
    use time::{Duration, OffsetDateTime, Time};

    fn browser_payload(page_title: Option<&str>) -> common::BrowserEventPayload {
        common::BrowserEventPayload {
            domain: "example.com".to_string(),
            page_title: page_title.map(str::to_string),
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
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
    fn batches_segment_heartbeats_at_ten_seconds() {
        let started_at = OffsetDateTime::UNIX_EPOCH;
        assert!(!heartbeat_flush_due(
            started_at,
            started_at + Duration::seconds(9)
        ));
        assert!(heartbeat_flush_due(
            started_at,
            started_at + Duration::seconds(10)
        ));
        assert!(!heartbeat_flush_due(
            started_at,
            started_at - Duration::seconds(1)
        ));
    }

    #[test]
    fn health_reminders_respect_work_and_overnight_quiet_hours() {
        let work = DailyTimeWindow::from_optional_strings("work", Some("09:00"), Some("18:00"))
            .expect("valid work hours");
        let quiet = DailyTimeWindow::from_optional_strings("quiet", Some("22:00"), Some("08:00"))
            .expect("valid quiet hours");

        assert!(health_reminder_allowed(
            work,
            quiet,
            Time::from_hms(10, 0, 0).expect("time")
        ));
        assert!(!health_reminder_allowed(
            work,
            quiet,
            Time::from_hms(20, 0, 0).expect("time")
        ));
        assert!(!health_reminder_allowed(
            None,
            quiet,
            Time::from_hms(23, 0, 0).expect("time")
        ));
        assert!(!health_reminder_allowed(
            None,
            quiet,
            Time::from_hms(7, 30, 0).expect("time")
        ));
        assert!(health_reminder_allowed(
            None,
            quiet,
            Time::from_hms(8, 0, 0).expect("time")
        ));
    }
}
