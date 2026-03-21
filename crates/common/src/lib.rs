//! Shared protocol types used by the local agent, web UI, and browser extension.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<ApiErrorBody>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(ApiErrorBody {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    Active,
    Idle,
    Locked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub process_name: String,
    pub display_name: String,
    pub exe_path: Option<String>,
    pub window_title: Option<String>,
    pub is_browser: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusSegment {
    pub id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub started_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub ended_at: Option<OffsetDateTime>,
    pub app: AppInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserSegment {
    pub id: i64,
    pub domain: String,
    pub page_title: Option<String>,
    pub browser_window_id: i64,
    pub tab_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub started_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub ended_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceSegment {
    pub id: i64,
    pub state: PresenceState,
    #[serde(with = "time::serde::rfc3339")]
    pub started_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub ended_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineDayResponse {
    pub date: String,
    pub timezone: String,
    pub focus_segments: Vec<FocusSegment>,
    pub browser_segments: Vec<BrowserSegment>,
    pub presence_segments: Vec<PresenceSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DurationStat {
    pub key: String,
    pub label: String,
    pub seconds: i64,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusStats {
    pub total_focus_seconds: i64,
    pub total_active_seconds: i64,
    pub switch_count: i64,
    pub longest_focus_block_seconds: i64,
    pub average_focus_block_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub service: String,
    pub version: String,
    pub status: String,
    #[serde(with = "time::serde::rfc3339")]
    pub started_at: OffsetDateTime,
    pub database_path: String,
    pub listen_addr: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMonitorStatus {
    pub key: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_seen: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSettingsResponse {
    pub autostart_enabled: bool,
    pub tray_enabled: bool,
    pub web_ui_url: String,
    pub launch_command: String,
    pub monitors: Vec<AgentMonitorStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAutostartRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAutostartResponse {
    pub autostart_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugEvent {
    pub id: i64,
    pub kind: String,
    pub payload_json: String,
    #[serde(with = "time::serde::rfc3339")]
    pub observed_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserEventPayload {
    pub domain: String,
    pub page_title: Option<String>,
    pub browser_window_id: i64,
    pub tab_id: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub observed_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserEventAck {
    pub accepted: bool,
    pub reason: Option<String>,
}
