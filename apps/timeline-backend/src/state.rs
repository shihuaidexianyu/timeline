//! Shared runtime state for open segments and global application dependencies.

use crate::{config::AppConfig, db::AgentStore};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    Arc, RwLock,
    atomic::{AtomicBool, Ordering},
};
use time::{OffsetDateTime, UtcOffset};
use tokio::sync::{Mutex, RwLock as TokioRwLock};

#[derive(Debug, Default)]
pub struct RuntimeState {
    pub current_focus: Option<OpenFocusSegment>,
    pub current_presence: Option<OpenPresenceSegment>,
    pub current_browser: Option<OpenBrowserSegment>,
    pub current_visible_windows: BTreeMap<String, OpenVisibleWindowSegment>,
    pub health_reminder: HealthReminderRuntime,
}

#[derive(Debug, Default, Clone)]
pub struct MonitorTelemetry {
    pub focus_last_seen: Option<OffsetDateTime>,
    pub visible_windows_last_seen: Option<OffsetDateTime>,
    pub presence_last_seen: Option<OffsetDateTime>,
    pub browser_last_seen: Option<OffsetDateTime>,
    pub tray_last_seen: Option<OffsetDateTime>,
}

#[derive(Debug, Clone)]
pub struct OpenFocusSegment {
    pub id: i64,
    pub fingerprint: String,
    pub is_browser: bool,
}

#[derive(Debug, Clone)]
pub struct OpenPresenceSegment {
    pub id: i64,
    pub state: common::PresenceState,
}

#[derive(Debug, Clone)]
pub struct OpenBrowserSegment {
    pub id: i64,
    pub domain: String,
    pub browser_window_id: i64,
    pub tab_id: i64,
}

#[derive(Debug, Clone)]
pub struct OpenVisibleWindowSegment {
    pub id: i64,
}

#[derive(Debug, Default, Clone)]
pub struct HealthReminderRuntime {
    pub active_streak_started_at: Option<OffsetDateTime>,
    /// The next streak duration (in seconds) at which a reminder should fire.
    /// Increases by 1.5x after each reminder to avoid nagging while still
    /// re-alerting during very long active sessions.
    pub next_reminder_threshold_secs: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfigSnapshot {
    pub idle_threshold_secs: u64,
    pub poll_interval_millis: u64,
    pub health_reminder_enabled: bool,
    pub health_reminder_threshold_secs: u64,
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
    /// Local timezone offset, wrapped in a RwLock so it can be refreshed
    /// periodically (DST changes, travel across timezones) without restarting.
    /// Reads are non-blocking via `std::sync::RwLock` since the critical
    /// section is just copying an `i32`-sized value.
    pub timezone: RwLock<UtcOffset>,
    pub runtime_config: TokioRwLock<RuntimeConfigSnapshot>,
    pub runtime: Mutex<RuntimeState>,
    pub browser_transition: Mutex<()>,
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
                timezone: RwLock::new(timezone),
                runtime_config: TokioRwLock::new(runtime_config),
                runtime: Mutex::new(RuntimeState::default()),
                browser_transition: Mutex::new(()),
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
        *self.inner.timezone.read().expect("timezone lock poisoned")
    }

    /// Re-reads the system local offset and updates the stored timezone if it
    /// has changed (e.g. DST transition or travel across zones). Returns the
    /// new offset and logs the change.
    pub fn refresh_timezone(&self) -> UtcOffset {
        let new_offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
        let old_offset = {
            let mut tz = self.inner.timezone.write().expect("timezone lock poisoned");
            let old = *tz;
            *tz = new_offset;
            old
        };
        if old_offset != new_offset {
            tracing::info!(old = %old_offset, new = %new_offset, "timezone offset changed");
        }
        new_offset
    }

    pub async fn runtime(&self) -> tokio::sync::MutexGuard<'_, RuntimeState> {
        self.inner.runtime.lock().await
    }

    pub async fn browser_transition(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.browser_transition.lock().await
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
        self.inner.monitors.lock().await.focus_last_seen = Some(seen_at);
    }

    pub async fn mark_visible_windows_online(&self, seen_at: OffsetDateTime) {
        self.inner.monitors.lock().await.visible_windows_last_seen = Some(seen_at);
    }

    pub async fn mark_presence_online(&self, seen_at: OffsetDateTime) {
        self.inner.monitors.lock().await.presence_last_seen = Some(seen_at);
    }

    pub async fn mark_browser_online(&self, seen_at: OffsetDateTime) {
        self.inner.monitors.lock().await.browser_last_seen = Some(seen_at);
    }

    pub fn mark_tray_online_sync(&self, seen_at: OffsetDateTime) {
        self.inner.monitors.blocking_lock().tray_last_seen = Some(seen_at);
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

    /// Returns a new `watch::Receiver` that fires when shutdown is requested.
    /// Trackers use this to `select!` against their sleep loop and exit promptly.
    pub fn shutdown_rx(&self) -> tokio::sync::watch::Receiver<bool> {
        self.inner.shutdown_tx.subscribe()
    }
}
