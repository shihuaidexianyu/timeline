//! Axum routes for health checks, timelines, stats, browser event ingestion, and settings.

use crate::{state::AgentState, system, trackers::sync_browser_event};
use anyhow::Result;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use common::{
    AgentMonitorStatus, AgentSettingsResponse, ApiResponse, BrowserEventPayload, HealthResponse,
    UpdateAutostartRequest, UpdateAutostartResponse,
};
use serde::Deserialize;
use time::format_description::parse;
use time::{Date, Duration, OffsetDateTime};
use tower_http::cors::{Any, CorsLayer};

pub fn build_router(state: AgentState) -> Router {
    Router::new()
        .route("/health", get(get_health))
        .route("/api/timeline/day", get(get_timeline_day))
        .route("/api/stats/apps", get(get_app_stats))
        .route("/api/stats/domains", get(get_domain_stats))
        .route("/api/stats/focus", get(get_focus_stats))
        .route("/api/settings", get(get_settings))
        .route("/api/settings/autostart", post(post_autostart))
        .route("/api/debug/recent-events", get(get_recent_events))
        .route("/api/events/browser", post(post_browser_event))
        .layer(build_cors_layer())
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct DayQuery {
    date: Option<String>,
}

async fn get_health(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<HealthResponse>>, AppError> {
    Ok(Json(ApiResponse::ok(HealthResponse {
        service: "timeline-agent".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        status: "ok".to_string(),
        started_at: state.started_at(),
        database_path: state.config().database_path.display().to_string(),
        listen_addr: state.config().listen_addr.clone(),
        timezone: state.timezone().to_string(),
    })))
}

async fn get_timeline_day(
    State(state): State<AgentState>,
    Query(query): Query<DayQuery>,
) -> Result<Json<ApiResponse<common::TimelineDayResponse>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let timeline = state
        .store()
        .read_day_timeline(date, state.timezone())
        .await?;
    Ok(Json(ApiResponse::ok(timeline)))
}

async fn get_app_stats(
    State(state): State<AgentState>,
    Query(query): Query<DayQuery>,
) -> Result<Json<ApiResponse<Vec<common::DurationStat>>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let stats = state.store().read_app_stats(date, state.timezone()).await?;
    Ok(Json(ApiResponse::ok(stats)))
}

async fn get_domain_stats(
    State(state): State<AgentState>,
    Query(query): Query<DayQuery>,
) -> Result<Json<ApiResponse<Vec<common::DurationStat>>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let stats = state
        .store()
        .read_domain_stats(date, state.timezone())
        .await?;
    Ok(Json(ApiResponse::ok(stats)))
}

async fn get_focus_stats(
    State(state): State<AgentState>,
    Query(query): Query<DayQuery>,
) -> Result<Json<ApiResponse<common::FocusStats>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let stats = state
        .store()
        .read_focus_stats(date, state.timezone())
        .await?;
    Ok(Json(ApiResponse::ok(stats)))
}

async fn get_recent_events(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<Vec<common::DebugEvent>>>, AppError> {
    let events = state.store().read_recent_events(30).await?;
    Ok(Json(ApiResponse::ok(events)))
}

async fn get_settings(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<AgentSettingsResponse>>, AppError> {
    let autostart_enabled = system::autostart_enabled()?;
    let monitors = build_monitor_statuses(&state).await;

    Ok(Json(ApiResponse::ok(AgentSettingsResponse {
        autostart_enabled,
        tray_enabled: state.config().tray_enabled,
        web_ui_url: state.config().web_ui_url.clone(),
        launch_command: state.launch_command(),
        monitors,
    })))
}

async fn post_autostart(
    State(state): State<AgentState>,
    Json(payload): Json<UpdateAutostartRequest>,
) -> Result<Json<ApiResponse<UpdateAutostartResponse>>, AppError> {
    let autostart_enabled = system::set_autostart_enabled(&state, payload.enabled)?;

    Ok(Json(ApiResponse::ok(UpdateAutostartResponse {
        autostart_enabled,
    })))
}

async fn post_browser_event(
    State(state): State<AgentState>,
    Json(payload): Json<BrowserEventPayload>,
) -> Result<Json<ApiResponse<common::BrowserEventAck>>, AppError> {
    let observed_at = payload.observed_at.unwrap_or_else(OffsetDateTime::now_utc);
    let ack = sync_browser_event(&state, payload, observed_at).await?;
    Ok(Json(ApiResponse::ok(ack)))
}

fn parse_or_today(value: Option<&str>, timezone: time::UtcOffset) -> Result<Date, AppError> {
    if let Some(value) = value {
        let format = parse("[year]-[month]-[day]")
            .map_err(|error| AppError::internal(anyhow::anyhow!(error)))?;
        return Date::parse(value, &format)
            .map_err(|_| AppError::bad_request("invalid_date", "date must use YYYY-MM-DD"));
    }

    Ok(OffsetDateTime::now_utc().to_offset(timezone).date())
}

fn build_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
}

async fn build_monitor_statuses(state: &AgentState) -> Vec<AgentMonitorStatus> {
    let now = OffsetDateTime::now_utc();
    let telemetry = state.monitor_snapshot().await;
    let poll_window = Duration::milliseconds((state.config().poll_interval_millis * 4) as i64);
    let browser_window = Duration::minutes(15);

    vec![
        monitor_status(
            "focus_tracker",
            "前台窗口监视器",
            telemetry.focus_last_seen,
            poll_window,
            now,
            "轮询前台应用和窗口标题",
        ),
        monitor_status(
            "presence_tracker",
            "Presence 监视器",
            telemetry.presence_last_seen,
            poll_window,
            now,
            "轮询 active / idle / locked 状态",
        ),
        monitor_status(
            "browser_bridge",
            "浏览器桥接",
            telemetry.browser_last_seen,
            browser_window,
            now,
            "接收浏览器扩展上报的活动标签页",
        ),
        AgentMonitorStatus {
            key: "tray".to_string(),
            label: "系统托盘".to_string(),
            status: if state.config().tray_enabled {
                "online".to_string()
            } else {
                "disabled".to_string()
            },
            detail: if state.config().tray_enabled {
                "左键打开前端，右键弹出菜单".to_string()
            } else {
                "托盘已在配置中关闭".to_string()
            },
            last_seen: telemetry.tray_last_seen,
        },
    ]
}

fn monitor_status(
    key: &str,
    label: &str,
    last_seen: Option<OffsetDateTime>,
    freshness: Duration,
    now: OffsetDateTime,
    detail: &str,
) -> AgentMonitorStatus {
    let status = match last_seen {
        Some(seen_at) if now - seen_at <= freshness => "online",
        Some(_) => "stale",
        None => "waiting",
    };

    AgentMonitorStatus {
        key: key.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail: detail.to_string(),
        last_seen,
    }
}

struct AppError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl AppError {
    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: error.to_string(),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        Self::internal(value)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiResponse::<()> {
                ok: false,
                data: None,
                error: Some(common::ApiErrorBody {
                    code: self.code.to_string(),
                    message: self.message,
                }),
            }),
        )
            .into_response()
    }
}
