//! Shared runtime state for open segments and global application dependencies.

use crate::{
    config::{AppConfig, DailyTimeWindow},
    db::AgentStore,
};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Default)]
pub struct RuntimeState {
    pub current_focus: Option<OpenFocusSegment>,
    pub current_presence: Option<OpenPresenceSegment>,
    pub current_browser: Option<OpenBrowserSegment>,
    pub health_reminder: HealthReminderRuntime,
    pub tracking_paused: bool,
    pub paused_since: Option<OffsetDateTime>,
    pub pause_until: Option<OffsetDateTime>,
}

#[derive(Debug, Default, Clone)]
pub struct MonitorTelemetry {
    pub focus: MonitorProbe,
    pub presence: MonitorProbe,
    pub browser: MonitorProbe,
    pub tray: MonitorProbe,
}

#[derive(Debug, Default, Clone)]
pub struct MonitorProbe {
    pub last_seen: Option<OffsetDateTime>,
    pub last_error: Option<String>,
    pub consecutive_failures: u32,
    pub restart_count: u64,
    pub recovering: bool,
}

impl MonitorProbe {
    fn mark_success(&mut self, seen_at: OffsetDateTime) {
        self.last_seen = Some(seen_at);
        self.last_error = None;
        self.consecutive_failures = 0;
        self.recovering = false;
    }

    fn mark_failure(&mut self, error: &str) {
        self.last_error = Some(error.to_string());
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.recovering = false;
    }

    fn mark_restart(&mut self) {
        self.restart_count = self.restart_count.saturating_add(1);
        self.recovering = true;
    }
}

#[derive(Debug, Clone)]
pub struct OpenFocusSegment {
    pub id: i64,
    pub fingerprint: String,
    pub process_name: String,
    pub is_browser: bool,
    pub last_observed_at: OffsetDateTime,
    pub last_persisted_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct OpenPresenceSegment {
    pub id: i64,
    pub state: common::PresenceState,
    pub last_observed_at: OffsetDateTime,
    pub last_persisted_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct OpenBrowserSegment {
    pub id: i64,
    pub domain: String,
    pub browser_window_id: i64,
    pub tab_id: i64,
    pub last_observed_at: OffsetDateTime,
    pub last_persisted_at: OffsetDateTime,
}

#[derive(Debug, Default, Clone)]
pub struct HealthReminderRuntime {
    pub active_streak_started_at: Option<OffsetDateTime>,
    pub reminded_for_current_streak: bool,
    pub rest_started_at: Option<OffsetDateTime>,
    pub snoozed_until: Option<OffsetDateTime>,
    pub dismissed_local_date: Option<Date>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthReminderAction {
    SnoozeTenMinutes,
    Rested,
    DismissToday,
}

impl HealthReminderAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SnoozeTenMinutes => "snooze_10_minutes",
            Self::Rested => "rested",
            Self::DismissToday => "dismiss_today",
        }
    }
}

impl HealthReminderRuntime {
    fn apply_action(
        &mut self,
        action: HealthReminderAction,
        observed_at: OffsetDateTime,
        local_date: Date,
    ) {
        match action {
            HealthReminderAction::SnoozeTenMinutes => {
                self.snoozed_until = Some(observed_at + Duration::minutes(10));
                self.reminded_for_current_streak = false;
            }
            HealthReminderAction::Rested => {
                self.active_streak_started_at = None;
                self.reminded_for_current_streak = false;
                self.rest_started_at = None;
                self.snoozed_until = None;
            }
            HealthReminderAction::DismissToday => {
                self.dismissed_local_date = Some(local_date);
                self.snoozed_until = None;
                self.reminded_for_current_streak = true;
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeConfigSnapshot {
    pub idle_threshold_secs: u64,
    pub poll_interval_millis: u64,
    pub health_reminder_enabled: bool,
    pub health_reminder_threshold_secs: u64,
    pub health_reminder_work_start: Option<String>,
    pub health_reminder_work_end: Option<String>,
    pub health_reminder_quiet_start: Option<String>,
    pub health_reminder_quiet_end: Option<String>,
    pub health_reminder_work_hours: Option<DailyTimeWindow>,
    pub health_reminder_quiet_hours: Option<DailyTimeWindow>,
    pub record_window_titles: bool,
    pub record_page_titles: bool,
    pub ignored_apps: Vec<String>,
    pub ignored_domains: Vec<String>,
}

impl RuntimeConfigSnapshot {
    fn from_config(config: &AppConfig) -> Self {
        Self {
            idle_threshold_secs: config.idle_threshold_secs,
            poll_interval_millis: config.poll_interval_millis,
            health_reminder_enabled: config.health_reminder_enabled,
            health_reminder_threshold_secs: config.health_reminder_threshold_secs,
            health_reminder_work_start: config.health_reminder_work_start.clone(),
            health_reminder_work_end: config.health_reminder_work_end.clone(),
            health_reminder_quiet_start: config.health_reminder_quiet_start.clone(),
            health_reminder_quiet_end: config.health_reminder_quiet_end.clone(),
            health_reminder_work_hours: DailyTimeWindow::from_optional_strings(
                "health reminder work hours",
                config.health_reminder_work_start.as_deref(),
                config.health_reminder_work_end.as_deref(),
            )
            .expect("validated health reminder work hours"),
            health_reminder_quiet_hours: DailyTimeWindow::from_optional_strings(
                "health reminder quiet hours",
                config.health_reminder_quiet_start.as_deref(),
                config.health_reminder_quiet_end.as_deref(),
            )
            .expect("validated health reminder quiet hours"),
            record_window_titles: config.record_window_titles,
            record_page_titles: config.record_page_titles,
            ignored_apps: config.ignored_apps.clone(),
            ignored_domains: config.ignored_domains.clone(),
        }
    }
}

pub struct AgentStateInner {
    pub config: AppConfig,
    pub config_path: Option<PathBuf>,
    pub store: AgentStore,
    pub started_at: OffsetDateTime,
    pub timezone: UtcOffset,
    pub runtime_config: RwLock<RuntimeConfigSnapshot>,
    pub runtime: Mutex<RuntimeState>,
    pub collector_transition: Mutex<()>,
    pub monitors: Mutex<MonitorTelemetry>,
    pub shutdown_requested: AtomicBool,
    pub shutdown_tx: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone)]
pub struct AgentState {
    inner: Arc<AgentStateInner>,
}

impl AgentState {
    pub fn new(
        config: AppConfig,
        config_path: Option<PathBuf>,
        store: AgentStore,
        started_at: OffsetDateTime,
        timezone: UtcOffset,
        shutdown_tx: tokio::sync::watch::Sender<bool>,
    ) -> Self {
        let runtime_config = RuntimeConfigSnapshot::from_config(&config);
        Self {
            inner: Arc::new(AgentStateInner {
                config,
                config_path,
                store,
                started_at,
                timezone,
                runtime_config: RwLock::new(runtime_config),
                runtime: Mutex::new(RuntimeState::default()),
                collector_transition: Mutex::new(()),
                monitors: Mutex::new(MonitorTelemetry::default()),
                shutdown_requested: AtomicBool::new(false),
                shutdown_tx,
            }),
        }
    }

    pub fn config(&self) -> &AppConfig {
        &self.inner.config
    }

    pub fn store(&self) -> &AgentStore {
        &self.inner.store
    }

    pub fn config_path(&self) -> Option<&PathBuf> {
        self.inner.config_path.as_ref()
    }

    pub fn started_at(&self) -> OffsetDateTime {
        self.inner.started_at
    }

    pub fn timezone(&self) -> UtcOffset {
        self.inner
            .store
            .local_offset_at(OffsetDateTime::now_utc())
            .unwrap_or(self.inner.timezone)
    }

    pub async fn runtime(&self) -> tokio::sync::MutexGuard<'_, RuntimeState> {
        self.inner.runtime.lock().await
    }

    pub async fn tracking_pause_state(
        &self,
    ) -> (bool, Option<OffsetDateTime>, Option<OffsetDateTime>) {
        let runtime = self.inner.runtime.lock().await;
        (
            runtime.tracking_paused,
            runtime.paused_since,
            runtime.pause_until,
        )
    }

    pub fn tracking_pause_state_blocking(
        &self,
    ) -> (bool, Option<OffsetDateTime>, Option<OffsetDateTime>) {
        let runtime = self.inner.runtime.blocking_lock();
        (
            runtime.tracking_paused,
            runtime.paused_since,
            runtime.pause_until,
        )
    }

    pub async fn set_tracking_pause_state(
        &self,
        paused: bool,
        paused_since: Option<OffsetDateTime>,
        pause_until: Option<OffsetDateTime>,
    ) {
        let mut runtime = self.inner.runtime.lock().await;
        runtime.tracking_paused = paused;
        runtime.paused_since = paused_since;
        runtime.pause_until = pause_until;
    }

    pub async fn apply_health_reminder_action(
        &self,
        action: HealthReminderAction,
        observed_at: OffsetDateTime,
    ) {
        let local_date = observed_at
            .to_offset(
                self.inner
                    .store
                    .local_offset_at(observed_at)
                    .unwrap_or(self.inner.timezone),
            )
            .date();
        let mut runtime = self.inner.runtime.lock().await;
        runtime
            .health_reminder
            .apply_action(action, observed_at, local_date);
    }

    pub async fn collector_transition(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.collector_transition.lock().await
    }

    pub async fn runtime_config_snapshot(&self) -> RuntimeConfigSnapshot {
        self.inner.runtime_config.read().await.clone()
    }

    pub async fn replace_runtime_config(&self, next: &AppConfig) {
        *self.inner.runtime_config.write().await = RuntimeConfigSnapshot::from_config(next);
    }

    pub async fn monitor_snapshot(&self) -> MonitorTelemetry {
        self.inner.monitors.lock().await.clone()
    }

    pub async fn mark_focus_online(&self, seen_at: OffsetDateTime) {
        self.inner.monitors.lock().await.focus.mark_success(seen_at);
    }

    pub async fn mark_presence_online(&self, seen_at: OffsetDateTime) {
        self.inner
            .monitors
            .lock()
            .await
            .presence
            .mark_success(seen_at);
    }

    pub async fn mark_browser_online(&self, seen_at: OffsetDateTime) {
        self.inner
            .monitors
            .lock()
            .await
            .browser
            .mark_success(seen_at);
    }

    pub async fn mark_focus_failed(&self, error: &str) {
        self.inner.monitors.lock().await.focus.mark_failure(error);
    }

    pub async fn mark_presence_failed(&self, error: &str) {
        self.inner
            .monitors
            .lock()
            .await
            .presence
            .mark_failure(error);
    }

    pub async fn mark_focus_restarted(&self) {
        self.inner.monitors.lock().await.focus.mark_restart();
    }

    pub async fn mark_presence_restarted(&self) {
        self.inner.monitors.lock().await.presence.mark_restart();
    }

    pub fn mark_tray_online_sync(&self, seen_at: OffsetDateTime) {
        self.inner
            .monitors
            .blocking_lock()
            .tray
            .mark_success(seen_at);
    }

    pub fn launch_command(&self) -> String {
        let launch_exe = self.launch_executable_path();
        let launch_exe = launch_exe.display().to_string();

        if let Some(config_path) = self.config_path() {
            return format!(r#""{}" --config "{}""#, launch_exe, config_path.display());
        }

        format!(r#""{}""#, launch_exe)
    }

    pub fn launch_executable_path(&self) -> PathBuf {
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("timeline.exe"))
    }

    pub fn request_shutdown(&self) {
        self.inner.shutdown_requested.store(true, Ordering::SeqCst);
        let _ = self.inner.shutdown_tx.send(true);
    }

    pub fn shutdown_requested(&self) -> bool {
        self.inner.shutdown_requested.load(Ordering::SeqCst)
    }

    pub fn subscribe_shutdown(&self) -> tokio::sync::watch::Receiver<bool> {
        self.inner.shutdown_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::{HealthReminderAction, HealthReminderRuntime};
    use time::{Duration, OffsetDateTime, macros::date};

    #[test]
    fn health_reminder_actions_update_runtime_state() {
        let observed_at = OffsetDateTime::UNIX_EPOCH;
        let local_date = date!(2026 - 07 - 13);
        let mut reminder = HealthReminderRuntime {
            active_streak_started_at: Some(observed_at - Duration::hours(1)),
            reminded_for_current_streak: true,
            ..HealthReminderRuntime::default()
        };

        reminder.apply_action(
            HealthReminderAction::SnoozeTenMinutes,
            observed_at,
            local_date,
        );
        assert_eq!(
            reminder.snoozed_until,
            Some(observed_at + Duration::minutes(10))
        );
        assert!(!reminder.reminded_for_current_streak);

        reminder.apply_action(HealthReminderAction::Rested, observed_at, local_date);
        assert_eq!(reminder.active_streak_started_at, None);
        assert_eq!(reminder.snoozed_until, None);

        reminder.apply_action(HealthReminderAction::DismissToday, observed_at, local_date);
        assert_eq!(reminder.dismissed_local_date, Some(local_date));
        assert!(reminder.reminded_for_current_streak);
    }
}
