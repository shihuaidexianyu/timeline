//! Shared runtime state for open segments and global application dependencies.

use crate::{config::AppConfig, db::AgentStore};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use time::{OffsetDateTime, UtcOffset};
use tokio::sync::Mutex;

#[derive(Debug, Default)]
pub struct RuntimeState {
    pub current_focus: Option<OpenFocusSegment>,
    pub current_presence: Option<OpenPresenceSegment>,
    pub current_browser: Option<OpenBrowserSegment>,
}

#[derive(Debug, Default, Clone)]
pub struct MonitorTelemetry {
    pub focus_last_seen: Option<OffsetDateTime>,
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

pub struct AgentStateInner {
    pub config: AppConfig,
    pub config_path: Option<PathBuf>,
    pub store: AgentStore,
    pub started_at: OffsetDateTime,
    pub timezone: UtcOffset,
    pub runtime: Mutex<RuntimeState>,
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
        Self {
            inner: Arc::new(AgentStateInner {
                config,
                config_path,
                store,
                started_at,
                timezone,
                runtime: Mutex::new(RuntimeState::default()),
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
        self.inner.timezone
    }

    pub async fn runtime(&self) -> tokio::sync::MutexGuard<'_, RuntimeState> {
        self.inner.runtime.lock().await
    }

    pub async fn monitor_snapshot(&self) -> MonitorTelemetry {
        self.inner.monitors.lock().await.clone()
    }

    pub async fn mark_focus_online(&self, seen_at: OffsetDateTime) {
        self.inner.monitors.lock().await.focus_last_seen = Some(seen_at);
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
        let current_exe = std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "timeline-agent".to_string());

        if let Some(config_path) = self.config_path() {
            return format!(r#""{}" --config "{}""#, current_exe, config_path.display());
        }

        format!(r#""{}""#, current_exe)
    }

    pub fn request_shutdown(&self) {
        self.inner.shutdown_requested.store(true, Ordering::SeqCst);
        let _ = self.inner.shutdown_tx.send(true);
    }

    pub fn shutdown_requested(&self) -> bool {
        self.inner.shutdown_requested.load(Ordering::SeqCst)
    }
}
