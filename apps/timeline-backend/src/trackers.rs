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
use tokio::sync::watch::Receiver;
use tokio::time::sleep;
use tracing::{error, info, warn};

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

/// Checks if shutdown has been requested via the watch channel. Returns `true`
/// when the channel has received `true` (or the sender dropped). The receiver
/// is borrowed mutably so that `changed()` can drain the pending update.
async fn is_shutting_down(shutdown_rx: &mut Receiver<bool>) -> bool {
    match shutdown_rx.has_changed() {
        Ok(true) => *shutdown_rx.borrow(),
        _ => false,
    }
}

async fn run_focus_tracker(state: AgentState) -> Result<()> {
    let mut shutdown_rx = state.shutdown_rx();
    loop {
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_focus_online(observed_at).await;

        match capture_foreground_window(runtime_config.record_window_titles) {
            Ok(snapshot) => {
                if let Err(error) =
                    sync_focus_snapshot(&state, snapshot, observed_at, &runtime_config).await
                {
                    warn!(?error, "failed to sync focus snapshot");
                }
            }
            Err(error) => warn!(?error, "failed to read foreground window"),
        }

        if is_shutting_down(&mut shutdown_rx).await {
            info!("focus tracker shutting down, closing open segment");
            close_open_focus_and_browser_segments(&state).await;
            break;
        }

        sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
    }

    Ok(())
}

async fn run_visible_window_tracker(state: AgentState) -> Result<()> {
    let mut shutdown_rx = state.shutdown_rx();
    let mut was_idle_or_locked = false;
    loop {
        let runtime_config = state.runtime_config_snapshot().await;
        let observed_at = OffsetDateTime::now_utc();
        state.mark_visible_windows_online(observed_at).await;

        // Check presence state. When the user goes idle or locks the
        // workstation, we close all open visible-window segments so their
        // timing stops. This keeps "visible window total" ≤ "active total"
        // and avoids counting time the user wasn't actually present.
        let presence =
            match detect_presence(Duration::from_secs(runtime_config.idle_threshold_secs)) {
                Ok(value) => value,
                Err(error) => {
                    warn!(?error, "failed to read presence in visible window tracker");
                    sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
                    continue;
                }
            };

        let is_idle_or_locked = matches!(presence, PresenceState::Idle | PresenceState::Locked);

        if is_idle_or_locked {
            // Close all open visible-window segments once per idle/locked
            // transition; subsequent polls while still idle/locked find no
            // open segments and do nothing.
            if !was_idle_or_locked
                && let Err(error) = close_all_open_visible_windows(&state, observed_at).await
            {
                warn!(?error, "failed to close visible windows on idle");
            }
            was_idle_or_locked = true;

            if is_shutting_down(&mut shutdown_rx).await {
                break;
            }
            sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
            continue;
        }

        // Active again — resume normal tracking.
        was_idle_or_locked = false;

        // Visible-window stats are app-level. Reading titles for every visible
        // top-level window can block on a non-responsive window, so leave titles
        // to the focus tracker where only the foreground window is queried.
        match capture_visible_windows(false) {
            Ok(snapshots) => {
                if let Err(error) =
                    sync_visible_windows(&state, snapshots, observed_at, &runtime_config).await
                {
                    warn!(?error, "failed to sync visible windows");
                }
            }
            Err(error) => warn!(?error, "failed to read visible windows"),
        }

        if is_shutting_down(&mut shutdown_rx).await {
            info!("visible window tracker shutting down, closing open segments");
            close_open_visible_window_segments(&state).await;
            break;
        }

        sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
    }

    Ok(())
}

async fn run_presence_tracker(state: AgentState) -> Result<()> {
    let mut shutdown_rx = state.shutdown_rx();
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

        if let Err(error) = sync_presence_state(&state, presence.clone(), observed_at).await {
            warn!(?error, "failed to sync presence state");
        }
        if let Err(error) =
            maybe_emit_health_reminder(&state, &runtime_config, &presence, observed_at).await
        {
            warn!(?error, "failed to emit health reminder");
        }

        if is_shutting_down(&mut shutdown_rx).await {
            info!("presence tracker shutting down, closing open segment");
            close_open_presence_segment(&state).await;
            break;
        }

        sleep(Duration::from_millis(runtime_config.poll_interval_millis)).await;
    }

    Ok(())
}

/// Closes the current focus segment and, if it was a browser, the current
/// browser segment. Called on graceful shutdown so the segments have proper
/// `ended_at` timestamps instead of relying on `restore_unclosed_segments`
/// at next startup.
async fn close_open_focus_and_browser_segments(state: &AgentState) {
    let observed_at = OffsetDateTime::now_utc();
    let previous_focus = {
        let mut runtime = state.runtime().await;
        runtime.current_focus.take()
    };
    if let Some(previous) = previous_focus
        && let Err(error) = state
            .store()
            .end_focus_segment(previous.id, observed_at)
            .await
    {
        warn!(?error, "failed to close focus segment on shutdown");
    }

    let previous_browser = {
        let mut runtime = state.runtime().await;
        runtime.current_browser.take()
    };
    if let Some(previous) = previous_browser
        && let Err(error) = state
            .store()
            .end_browser_segment(previous.id, observed_at)
            .await
    {
        warn!(?error, "failed to close browser segment on shutdown");
    }
}

async fn close_open_visible_window_segments(state: &AgentState) {
    if let Err(error) = close_all_open_visible_windows(state, OffsetDateTime::now_utc()).await {
        warn!(
            ?error,
            "failed to close visible window segments on shutdown"
        );
    }
}

/// Closes every currently-open visible-window segment. Used both on graceful
/// shutdown and when the user goes idle/locked — visible-window timing should
/// not accumulate while the user is away.
async fn close_all_open_visible_windows(
    state: &AgentState,
    observed_at: OffsetDateTime,
) -> Result<()> {
    let open_windows: Vec<OpenVisibleWindowSegment> = {
        let runtime = state.runtime().await;
        runtime.current_visible_windows.values().cloned().collect()
    };
    for window in &open_windows {
        state
            .store()
            .end_visible_window_segment(window.id, observed_at)
            .await?;
    }
    let mut runtime = state.runtime().await;
    runtime.current_visible_windows.clear();
    Ok(())
}

async fn close_open_presence_segment(state: &AgentState) {
    let observed_at = OffsetDateTime::now_utc();
    let previous = {
        let mut runtime = state.runtime().await;
        runtime.current_presence.take()
    };
    if let Some(previous) = previous
        && let Err(error) = state
            .store()
            .end_presence_segment(previous.id, observed_at)
            .await
    {
        warn!(?error, "failed to close presence segment on shutdown");
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
            exe_path: snapshot.exe_path.clone(),
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
            exe_path: snapshot.exe_path.clone(),
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
    let threshold_secs = runtime_config.health_reminder_threshold_secs.max(1) as i64;

    {
        let mut runtime = state.runtime().await;
        let reminder = &mut runtime.health_reminder;

        if !runtime_config.health_reminder_enabled {
            reminder.active_streak_started_at = None;
            reminder.next_reminder_threshold_secs = None;
            return Ok(());
        }

        match presence {
            PresenceState::Active => {
                let started_at = reminder.active_streak_started_at.get_or_insert(observed_at);
                let elapsed = (observed_at - *started_at).whole_seconds().max(0);

                let next_threshold = reminder
                    .next_reminder_threshold_secs
                    .unwrap_or(threshold_secs);

                if elapsed >= next_threshold {
                    // Suppress the toast if the foreground window is fullscreen
                    // (presentations, fullscreen media). The streak continues; we
                    // just defer the notification to the next polling cycle that
                    // finds the foreground NOT fullscreen.
                    let fullscreen = crate::windows::is_foreground_fullscreen().unwrap_or(false);
                    if !fullscreen {
                        should_notify = true;
                        streak_secs = elapsed;
                        // Next reminder at 1.5x the base threshold, measured from
                        // NOW (not from the last trigger). This prevents repeated
                        // toasts on every poll cycle: the next trigger is at
                        // elapsed + 1.5*threshold, not at a fixed multiple of the
                        // original threshold (which elapsed would immediately
                        // exceed again). Capped at 4x the base threshold.
                        let gap = (threshold_secs * 3 / 2).min(threshold_secs * 4);
                        let next = elapsed + gap;
                        reminder.next_reminder_threshold_secs = Some(next);
                    } else {
                        // Fullscreen: defer but still advance the threshold so we
                        // don't re-check on every single poll. Re-check after a
                        // short gap (30s) in case the user exits fullscreen soon.
                        reminder.next_reminder_threshold_secs = Some(elapsed + 30);
                    }
                }
            }
            PresenceState::Idle | PresenceState::Locked => {
                reminder.active_streak_started_at = None;
                reminder.next_reminder_threshold_secs = None;
            }
        }
    }

    if should_notify {
        state
            .store()
            .append_raw_event(
                "health_break_reminder",
                &HealthReminderEvent {
                    threshold_secs: threshold_secs as u64,
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
    let payload = apply_domain_group(&payload, &runtime_config.domain_groups);
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
    let lower = process_name.to_ascii_lowercase();
    runtime_config.ignored_apps.iter().any(|candidate| {
        let pattern = candidate.to_ascii_lowercase();
        matches_pattern(&lower, &pattern)
    })
}

fn is_ignored_domain(runtime_config: &RuntimeConfigSnapshot, domain: &str) -> bool {
    let lower = domain.to_ascii_lowercase();
    runtime_config.ignored_domains.iter().any(|candidate| {
        let pattern = candidate.to_ascii_lowercase();
        matches_pattern(&lower, &pattern)
    })
}

/// Maps a domain to its group key based on `domain_groups` config rules.
/// Each rule is `"group_name = [domain1, domain2, *.suffix]"`. If the domain
/// matches any pattern in any rule, it's replaced with the group name.
/// Patterns support `*` wildcard. If no rule matches, the domain is unchanged.
fn apply_domain_group(
    payload: &common::BrowserEventPayload,
    domain_groups: &[String],
) -> common::BrowserEventPayload {
    if domain_groups.is_empty() {
        return payload.clone();
    }

    let rules = parse_domain_groups(domain_groups);
    if rules.is_empty() {
        return payload.clone();
    }

    let lower_domain = payload.domain.to_ascii_lowercase();
    for (group_name, patterns) in &rules {
        for pattern in patterns {
            if matches_pattern(&lower_domain, pattern) {
                return common::BrowserEventPayload {
                    domain: group_name.clone(),
                    ..payload.clone()
                };
            }
        }
    }

    payload.clone()
}

/// Parses `domain_groups` config entries into `(group_name, patterns)` pairs.
/// Each entry is `"group_name = [domain1, domain2, *.suffix]"`.
/// Malformed entries are silently skipped.
fn parse_domain_groups(entries: &[String]) -> Vec<(String, Vec<String>)> {
    let mut rules = Vec::new();
    for entry in entries {
        let Some((name, list)) = entry.split_once('=') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let list = list.trim().trim_start_matches('[').trim_end_matches(']');
        let patterns: Vec<String> = list
            .split(',')
            .map(|p| p.trim().to_ascii_lowercase())
            .filter(|p| !p.is_empty())
            .collect();
        if !patterns.is_empty() {
            rules.push((name, patterns));
        }
    }
    rules
}

/// Matches a value against a pattern that may contain `*` (any sequence) and
/// `?` (single char) wildcards. Falls back to exact match for patterns without
/// wildcards, preserving case-insensitive exact-match behavior for existing
/// configs that don't use wildcards.
fn matches_pattern(value: &str, pattern: &str) -> bool {
    if !pattern.contains('*') && !pattern.contains('?') {
        return value == pattern;
    }

    // Greedy wildcard match via DP. value[i] vs pattern[j].
    let v: Vec<char> = value.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    let mut dp = vec![vec![false; p.len() + 1]; v.len() + 1];
    dp[0][0] = true;

    // Leading `*` in the pattern matches empty string.
    for j in 1..=p.len() {
        if p[j - 1] == '*' {
            dp[0][j] = dp[0][j - 1];
        }
    }

    for i in 1..=v.len() {
        for j in 1..=p.len() {
            if p[j - 1] == '*' {
                dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
            } else if p[j - 1] == '?' || p[j - 1] == v[i - 1] {
                dp[i][j] = dp[i - 1][j - 1];
            }
        }
    }

    dp[v.len()][p.len()]
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
    use super::{
        apply_domain_group, browser_payload_for_storage, is_ignored_app, matches_pattern,
        parse_domain_groups, trackable_visible_windows,
    };
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
            domain_groups: Vec::new(),
        }
    }

    fn visible_snapshot(process_name: &str, ratio: f64) -> VisibleWindowSnapshot {
        VisibleWindowSnapshot {
            hwnd: 100,
            process_id: 200,
            session_id: 1,
            process_name: process_name.to_string(),
            exe_path: Some(format!(r"C:\Apps\{process_name}")),
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

    #[test]
    fn matches_pattern_exact() {
        assert!(matches_pattern("code.exe", "code.exe"));
        assert!(!matches_pattern("code.exe", "msedge.exe"));
    }

    #[test]
    fn matches_pattern_star() {
        assert!(matches_pattern("code.exe", "*.exe"));
        assert!(matches_pattern("cicada-helper.exe", "cicada*"));
        assert!(!matches_pattern("code.exe", "ms*.exe"));
    }

    #[test]
    fn matches_pattern_question() {
        assert!(matches_pattern("code.exe", "cod?.exe"));
        assert!(!matches_pattern("code.exe", "cod??.exe"));
    }

    #[test]
    fn is_ignored_app_supports_wildcards() {
        let config = RuntimeConfigSnapshot {
            idle_threshold_secs: 300,
            poll_interval_millis: 1000,
            health_reminder_enabled: true,
            health_reminder_threshold_secs: 3000,
            record_window_titles: true,
            record_page_titles: true,
            ignored_apps: vec!["*.exe".to_string(), "Cicada*".to_string()],
            ignored_domains: Vec::new(),
            domain_groups: Vec::new(),
        };
        assert!(is_ignored_app(&config, "code.exe"));
        assert!(is_ignored_app(&config, "CicadaHelper.exe"));
        assert!(!is_ignored_app(&config, "unknown.bin"));
    }

    #[test]
    fn parse_domain_groups_parses_valid_entries() {
        let entries = vec![
            "github = [github.com, gist.github.com, *.github.io]".to_string(),
            "google = [mail.google.com, docs.google.com]".to_string(),
        ];
        let rules = parse_domain_groups(&entries);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].0, "github");
        assert_eq!(
            rules[0].1,
            vec!["github.com", "gist.github.com", "*.github.io"]
        );
        assert_eq!(rules[1].0, "google");
    }

    #[test]
    fn parse_domain_groups_skips_malformed() {
        let entries = vec![
            "no_equals_sign".to_string(),
            " = [orphan.com]".to_string(),
            "good = []".to_string(),
            "ok = [ok.com]".to_string(),
        ];
        let rules = parse_domain_groups(&entries);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].0, "ok");
    }

    #[test]
    fn apply_domain_group_maps_matching_domain() {
        let payload = common::BrowserEventPayload {
            domain: "gist.github.com".to_string(),
            page_title: None,
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
        };
        let groups = vec!["github = [github.com, gist.github.com, *.github.io]".to_string()];
        let result = apply_domain_group(&payload, &groups);
        assert_eq!(result.domain, "github");
    }

    #[test]
    fn apply_domain_group_keeps_unmatched_domain() {
        let payload = common::BrowserEventPayload {
            domain: "example.com".to_string(),
            page_title: None,
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
        };
        let groups = vec!["github = [github.com, gist.github.com]".to_string()];
        let result = apply_domain_group(&payload, &groups);
        assert_eq!(result.domain, "example.com");
    }

    #[test]
    fn apply_domain_group_with_empty_config_is_noop() {
        let payload = common::BrowserEventPayload {
            domain: "github.com".to_string(),
            page_title: None,
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
        };
        let result = apply_domain_group(&payload, &[]);
        assert_eq!(result.domain, "github.com");
    }
}
