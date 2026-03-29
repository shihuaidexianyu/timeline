//! Axum routes for health checks, timelines, stats, browser event ingestion, and settings.

use crate::{state::AgentState, system, trackers::sync_browser_event, updater};
use anyhow::Result;
use axum::extract::{Query, Request, State};
use axum::http::header::{CONTENT_TYPE, ORIGIN};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use common::{
    AgentMonitorStatus, AgentSettingsResponse, ApiResponse, AppUpdateInfo, BrowserEventPayload,
    HealthResponse, InstallUpdateResponse, MonthCalendarResponse, PeriodSummaryResponse,
    UpdateAgentConfigRequest, UpdateAgentConfigResponse, UpdateAutostartRequest,
    UpdateAutostartResponse,
};
use serde::Deserialize;
use time::format_description::parse;
use time::{Date, Duration, OffsetDateTime};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

const EXTENSION_HEADER: &str = "x-timeline-extension";
const EXTENSION_HEADER_VALUE: &str = "browser-bridge";
/// How many raw events to return in the debug endpoint.
const DEBUG_RECENT_EVENTS_LIMIT: i64 = 30;

pub fn build_router(state: AgentState) -> Router {
    let router = Router::new()
        .route("/health", get(get_health))
        .route("/api/timeline/day", get(get_timeline_day))
        .route("/api/stats/apps", get(get_app_stats))
        .route("/api/stats/domains", get(get_domain_stats))
        .route("/api/stats/focus", get(get_focus_stats))
        .route("/api/settings", get(get_settings))
        .route("/api/settings/autostart", post(post_autostart))
        .route("/api/settings/config", post(post_update_agent_config))
        .route("/api/update/check", get(get_update_info))
        .route("/api/update/install", post(post_install_update))
        .route("/api/debug/recent-events", get(get_recent_events))
        .route("/api/events/browser", post(post_browser_event))
        .route("/api/calendar/month", get(get_month_calendar))
        .route("/api/stats/summary", get(get_period_summary))
        .layer(middleware::from_fn(validate_request_origin))
        .layer(build_cors_layer())
        .with_state(state.clone());

    if let Some(dist_dir) = state.config().web_ui_dist_dir() {
        let index_file = dist_dir.join("index.html");
        router.fallback_service(
            ServeDir::new(dist_dir)
                .append_index_html_on_directories(true)
                .not_found_service(ServeFile::new(index_file)),
        )
    } else {
        router.fallback(get(frontend_not_built))
    }
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
    let events = state
        .store()
        .read_recent_events(DEBUG_RECENT_EVENTS_LIMIT)
        .await?;
    Ok(Json(ApiResponse::ok(events)))
}

async fn get_settings(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<AgentSettingsResponse>>, AppError> {
    let autostart_enabled = system::autostart_enabled()?;
    let runtime_config = state.runtime_config_snapshot().await;
    let monitors = build_monitor_statuses(&state).await;

    Ok(Json(ApiResponse::ok(AgentSettingsResponse {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        autostart_enabled,
        tray_enabled: state.config().tray_enabled,
        web_ui_url: state.config().effective_web_ui_url(),
        launch_command: state.launch_command(),
        idle_threshold_secs: runtime_config.idle_threshold_secs,
        poll_interval_millis: runtime_config.poll_interval_millis,
        health_reminder_enabled: runtime_config.health_reminder_enabled,
        health_reminder_threshold_secs: runtime_config.health_reminder_threshold_secs,
        record_window_titles: runtime_config.record_window_titles,
        record_page_titles: runtime_config.record_page_titles,
        ignored_apps: runtime_config.ignored_apps,
        ignored_domains: runtime_config.ignored_domains,
        monitors,
    })))
}

async fn get_update_info() -> Result<Json<ApiResponse<AppUpdateInfo>>, AppError> {
    Ok(Json(ApiResponse::ok(
        updater::check_for_updates()
            .await
            .map_err(AppError::internal)?,
    )))
}

async fn post_install_update(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<InstallUpdateResponse>>, AppError> {
    let response = updater::install_latest_update(&state)
        .await
        .map_err(AppError::internal)?;
    let state_for_shutdown = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        state_for_shutdown.request_shutdown();
    });

    Ok(Json(ApiResponse::ok(response)))
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

async fn post_update_agent_config(
    State(state): State<AgentState>,
    Json(payload): Json<UpdateAgentConfigRequest>,
) -> Result<Json<ApiResponse<UpdateAgentConfigResponse>>, AppError> {
    validate_agent_config_payload(&payload)?;

    let mut next = state.config().clone();
    next.idle_threshold_secs = payload.idle_threshold_secs;
    next.poll_interval_millis = payload.poll_interval_millis;
    next.health_reminder_enabled = payload.health_reminder_enabled;
    next.health_reminder_threshold_secs = payload.health_reminder_threshold_secs;
    next.record_window_titles = payload.record_window_titles;
    next.record_page_titles = payload.record_page_titles;
    next.ignored_apps = sanitize_list(payload.ignored_apps);
    next.ignored_domains = sanitize_list(payload.ignored_domains);

    let Some(config_path) = state.config_path() else {
        return Err(AppError::bad_request(
            "config_path_unavailable",
            "current agent config path is unavailable",
        ));
    };

    next.save_to_path(config_path).map_err(AppError::internal)?;
    state.replace_runtime_config(&next).await;

    Ok(Json(ApiResponse::ok(UpdateAgentConfigResponse {
        saved: true,
        requires_restart: false,
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

#[derive(Debug, Deserialize)]
struct MonthQuery {
    month: Option<String>,
}

async fn get_month_calendar(
    State(state): State<AgentState>,
    Query(query): Query<MonthQuery>,
) -> Result<Json<ApiResponse<MonthCalendarResponse>>, AppError> {
    let (year, month) = parse_or_current_month(query.month.as_deref(), state.timezone())?;
    let calendar = state
        .store()
        .read_month_calendar(year, month, state.timezone())
        .await?;
    Ok(Json(ApiResponse::ok(calendar)))
}

async fn get_period_summary(
    State(state): State<AgentState>,
    Query(query): Query<DayQuery>,
) -> Result<Json<ApiResponse<PeriodSummaryResponse>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let summary = state
        .store()
        .read_period_summary(date, state.timezone())
        .await?;
    Ok(Json(ApiResponse::ok(summary)))
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

/// Parses a "YYYY-MM" string into (year, Month), defaulting to the current month.
fn parse_or_current_month(
    value: Option<&str>,
    timezone: time::UtcOffset,
) -> Result<(i32, time::Month), AppError> {
    if let Some(value) = value {
        let parts: Vec<&str> = value.split('-').collect();
        if parts.len() != 2 {
            return Err(AppError::bad_request(
                "invalid_month",
                "month must use YYYY-MM",
            ));
        }

        let year: i32 = parts[0]
            .parse()
            .map_err(|_| AppError::bad_request("invalid_month", "invalid year in YYYY-MM"))?;
        let month_num: u8 = parts[1]
            .parse()
            .map_err(|_| AppError::bad_request("invalid_month", "invalid month in YYYY-MM"))?;
        let month = time::Month::try_from(month_num)
            .map_err(|_| AppError::bad_request("invalid_month", "month must be 01-12"))?;

        return Ok((year, month));
    }

    let now = OffsetDateTime::now_utc().to_offset(timezone);
    Ok((now.year(), now.month()))
}

fn build_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _request_parts| {
            is_allowed_loopback_origin(origin)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE])
}

async fn validate_request_origin(request: Request, next: Next) -> Response {
    if let Some(origin) = request.headers().get(ORIGIN)
        && !is_allowed_browser_origin(origin, request.headers())
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiResponse::<()>::err(
                "forbidden_origin",
                "browser requests must come from a local loopback origin",
            )),
        )
            .into_response();
    }

    next.run(request).await
}

fn is_allowed_browser_origin(origin: &HeaderValue, headers: &axum::http::HeaderMap) -> bool {
    if is_allowed_loopback_origin(origin) {
        return true;
    }

    if origin
        .to_str()
        .ok()
        .is_some_and(|value| value.starts_with("chrome-extension://"))
    {
        return headers
            .get(EXTENSION_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some(EXTENSION_HEADER_VALUE);
    }

    false
}

fn is_allowed_loopback_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };

    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };

    if scheme != "http" && scheme != "https" {
        return false;
    }

    let authority = rest.split('/').next().unwrap_or(rest);
    let host = extract_host(authority);

    matches!(host, Some("127.0.0.1" | "localhost" | "::1"))
}

/// Extracts the host portion from an authority string, stripping the port
/// and IPv6 brackets (e.g. `[::1]:5173` → `::1`, `127.0.0.1:46215` → `127.0.0.1`).
fn extract_host(authority: &str) -> Option<&str> {
    if let Some(remainder) = authority.strip_prefix('[') {
        return remainder.split_once(']').map(|(host, _)| host);
    }

    Some(authority.split(':').next().unwrap_or(authority))
}

async fn frontend_not_built() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Html(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>timeline-agent</title></head><body><h1>前端尚未构建</h1><p>请在项目根目录先运行 <code>cd apps/web-ui &amp;&amp; npm run build</code>，然后重启 timeline-agent。</p></body></html>",
        ),
    )
}

async fn build_monitor_statuses(state: &AgentState) -> Vec<AgentMonitorStatus> {
    let now = OffsetDateTime::now_utc();
    let runtime_config = state.runtime_config_snapshot().await;
    let telemetry = state.monitor_snapshot().await;
    // Focus/presence trackers are stale if no heartbeat arrives within 4 poll intervals.
    let poll_window = Duration::milliseconds((runtime_config.poll_interval_millis * 4) as i64);
    // Browser extension events are sporadic; allow up to 15 minutes before marking stale.
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

fn validate_agent_config_payload(payload: &UpdateAgentConfigRequest) -> Result<(), AppError> {
    if !(15..=1800).contains(&payload.idle_threshold_secs) {
        return Err(AppError::bad_request(
            "invalid_idle_threshold",
            "idle_threshold_secs must be between 15 and 1800 seconds",
        ));
    }

    if !(250..=5000).contains(&payload.poll_interval_millis) {
        return Err(AppError::bad_request(
            "invalid_poll_interval",
            "poll_interval_millis must be between 250 and 5000 milliseconds",
        ));
    }

    if !(300..=21600).contains(&payload.health_reminder_threshold_secs) {
        return Err(AppError::bad_request(
            "invalid_health_reminder_threshold",
            "health_reminder_threshold_secs must be between 300 and 21600 seconds",
        ));
    }

    Ok(())
}

fn sanitize_list(items: Vec<String>) -> Vec<String> {
    let mut values: Vec<String> = items
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();

    values.sort_by_key(|value| value.to_ascii_lowercase());
    values.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    values
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

#[cfg(test)]
mod tests {
    use super::is_allowed_loopback_origin;
    use axum::http::HeaderValue;

    #[test]
    fn allows_loopback_http_origins() {
        assert!(is_allowed_loopback_origin(&HeaderValue::from_static(
            "http://127.0.0.1:4173"
        )));
        assert!(is_allowed_loopback_origin(&HeaderValue::from_static(
            "http://localhost:46215"
        )));
        assert!(is_allowed_loopback_origin(&HeaderValue::from_static(
            "http://[::1]:5173"
        )));
    }

    #[test]
    fn rejects_non_loopback_origins() {
        assert!(!is_allowed_loopback_origin(&HeaderValue::from_static(
            "https://example.com"
        )));
        assert!(!is_allowed_loopback_origin(&HeaderValue::from_static(
            "chrome-extension://abc123"
        )));
    }
}
