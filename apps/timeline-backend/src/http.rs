//! Axum routes for health checks, timelines, stats, browser event ingestion, and settings.

use crate::{state::AgentState, system, trackers::sync_browser_event};
use anyhow::Result;
use axum::extract::{Query, Request, State};
use axum::http::header::{CONTENT_TYPE, HeaderName, ORIGIN};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use common::{
    AgentMonitorStatus, AgentSettingsResponse, ApiResponse, AppUsageTrendResponse,
    BrowserEventPayload, HealthResponse, MonthCalendarResponse, PeriodSummaryResponse, TrendPeriod,
    UpdateAgentConfigRequest, UpdateAgentConfigResponse, UpdateAutostartRequest,
    UpdateAutostartResponse, UsageMetric,
};
use serde::Deserialize;
use time::format_description::parse;
use time::{Date, Duration, OffsetDateTime};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

const EXTENSION_HEADER: &str = "x-timeline-extension";
const EXTENSION_HEADER_VALUE: &str = "browser-bridge";
/// How many raw events to return in the debug endpoint.
const DEBUG_RECENT_EVENTS_LIMIT: i64 = 30;

pub fn build_router(state: AgentState) -> Router {
    let allowed_origins = state.config().allowed_cors_origins();

    // All routes must be registered before `with_state` so that the state type
    // inference works correctly. The debug endpoint is conditionally included
    // based on `debug_events_enabled` (defaults to off — it exposes window titles
    // and other sensitive raw data).
    let mut routes = Router::new()
        .route("/health", get(get_health))
        .route("/api/timeline/day", get(get_timeline_day))
        .route("/api/stats/apps", get(get_app_stats))
        .route("/api/stats/apps/trend", get(get_app_usage_trend))
        .route("/api/stats/domains", get(get_domain_stats))
        .route("/api/stats/domains/trend", get(get_domain_usage_trend))
        .route("/api/stats/focus", get(get_focus_stats))
        .route("/api/settings", get(get_settings))
        .route("/api/settings/autostart", post(post_autostart))
        .route("/api/settings/config", post(post_update_agent_config))
        .route("/api/events/browser", post(post_browser_event))
        .route("/api/calendar/month", get(get_month_calendar))
        .route("/api/stats/summary", get(get_period_summary))
        .route("/api/export", get(get_export));

    if state.config().debug_events_enabled {
        routes = routes.route("/api/debug/recent-events", get(get_recent_events));
    }

    let router = routes
        .layer(middleware::from_fn_with_state(
            allowed_origins,
            validate_request_origin,
        ))
        .layer(build_cors_layer(&state.config().allowed_cors_origins()))
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
    metric: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppTrendQuery {
    date: Option<String>,
    period: Option<String>,
    limit: Option<usize>,
    metric: Option<String>,
}

async fn get_health(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<HealthResponse>>, AppError> {
    // Only expose the database file name (not the full path) to avoid leaking
    // the user's directory structure to any local web page that can reach /health.
    let database_file_name = state
        .config()
        .database_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("timeline.sqlite")
        .to_string();

    Ok(Json(ApiResponse::ok(HealthResponse {
        service: "timeline".to_string(),
        status: "ok".to_string(),
        started_at: state.started_at(),
        database_path: database_file_name,
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
    let metric = parse_usage_metric(query.metric.as_deref())?;
    let stats = state
        .store()
        .read_app_stats(date, state.timezone(), metric)
        .await?;
    Ok(Json(ApiResponse::ok(stats)))
}

async fn get_app_usage_trend(
    State(state): State<AgentState>,
    Query(query): Query<AppTrendQuery>,
) -> Result<Json<ApiResponse<AppUsageTrendResponse>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let period = parse_trend_period(query.period.as_deref())?;
    let metric = parse_usage_metric(query.metric.as_deref())?;
    let trend = state
        .store()
        .read_app_usage_trend(date, period, query.limit.unwrap_or(6), metric)
        .await?;
    Ok(Json(ApiResponse::ok(trend)))
}

async fn get_domain_usage_trend(
    State(state): State<AgentState>,
    Query(query): Query<AppTrendQuery>,
) -> Result<Json<ApiResponse<AppUsageTrendResponse>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let period = parse_trend_period(query.period.as_deref())?;
    let trend = state
        .store()
        .read_domain_usage_trend(date, period, query.limit.unwrap_or(6))
        .await?;
    Ok(Json(ApiResponse::ok(trend)))
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
        domain_groups: runtime_config.domain_groups,
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

async fn post_update_agent_config(
    State(state): State<AgentState>,
    Json(payload): Json<UpdateAgentConfigRequest>,
) -> Result<Json<ApiResponse<UpdateAgentConfigResponse>>, AppError> {
    let mut next = state.config().clone();
    next.idle_threshold_secs = payload.idle_threshold_secs;
    next.poll_interval_millis = payload.poll_interval_millis;
    next.health_reminder_enabled = payload.health_reminder_enabled;
    next.health_reminder_threshold_secs = payload.health_reminder_threshold_secs;
    next.record_window_titles = payload.record_window_titles;
    next.record_page_titles = payload.record_page_titles;
    next.ignored_apps = sanitize_list(payload.ignored_apps);
    next.ignored_domains = sanitize_list(payload.ignored_domains);
    next.domain_groups = sanitize_list(payload.domain_groups);

    next.validate()
        .map_err(|(code, message)| AppError::bad_request(code, message))?;

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
    headers: HeaderMap,
    Json(payload): Json<BrowserEventPayload>,
) -> Result<Json<ApiResponse<common::BrowserEventAck>>, AppError> {
    if !has_extension_header(&headers) {
        return Err(AppError::forbidden(
            "missing_extension_header",
            "browser events must be sent by the timeline browser extension",
        ));
    }

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

#[derive(Debug, Deserialize)]
struct ExportQuery {
    date: Option<String>,
    format: Option<String>,
}

/// Exports a single day's segments as CSV or JSON. CSV includes one row per
/// segment across all four segment types (focus / browser / presence /
/// visible_window), with a `type` column to distinguish them. JSON returns
/// the same structure as `/api/timeline/day`.
async fn get_export(
    State(state): State<AgentState>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let format = query.format.as_deref().unwrap_or("csv");
    let timeline = state
        .store()
        .read_day_timeline(date, state.timezone())
        .await?;

    match format {
        "json" => {
            let body = serde_json::to_string(&timeline)
                .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
            Ok((
                [
                    (CONTENT_TYPE, "application/json; charset=utf-8".to_string()),
                    (
                        HeaderName::from_static("content-disposition"),
                        format!("attachment; filename=\"timeline-{}.json\"", date),
                    ),
                ],
                body,
            )
                .into_response())
        }
        "csv" => {
            let body = build_csv_export(&timeline);
            Ok((
                [
                    (CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
                    (
                        HeaderName::from_static("content-disposition"),
                        format!("attachment; filename=\"timeline-{}.csv\"", date),
                    ),
                ],
                body,
            )
                .into_response())
        }
        _ => Err(AppError::bad_request(
            "invalid_format",
            "format must be csv or json",
        )),
    }
}

/// Builds a CSV string from a day's timeline. Columns:
/// `type,started_at,ended_at,process_name,display_name,domain,state,hwnd,process_id,window_title`
fn build_csv_export(timeline: &common::TimelineDayResponse) -> String {
    let mut rows: Vec<String> = Vec::new();
    rows.push("type,started_at,ended_at,process_name,display_name,domain,state,hwnd,process_id,window_title".to_string());

    for seg in &timeline.focus_segments {
        rows.push(format!(
            "focus,{},{},{},{},,,,{},,{}",
            format_rfc3339(seg.started_at),
            format_rfc3339_opt(seg.ended_at),
            csv_escape(&seg.app.process_name),
            csv_escape(&seg.app.display_name),
            "", // hwnd not in focus segment
            csv_escape_opt(&seg.app.window_title),
        ));
    }

    for seg in &timeline.browser_segments {
        rows.push(format!(
            "browser,{},{},,,{},{},,,",
            format_rfc3339(seg.started_at),
            format_rfc3339_opt(seg.ended_at),
            csv_escape(&seg.domain),
            csv_escape_opt(&seg.page_title),
        ));
    }

    for seg in &timeline.presence_segments {
        rows.push(format!(
            "presence,{},{},,,,{},{},,",
            format_rfc3339(seg.started_at),
            format_rfc3339_opt(seg.ended_at),
            presence_state_csv(&seg.state),
            "",
        ));
    }

    for seg in &timeline.visible_window_segments {
        rows.push(format!(
            "visible_window,{},{},{},{},,,{},{},{}",
            format_rfc3339(seg.started_at),
            format_rfc3339_opt(seg.ended_at),
            csv_escape(&seg.app.process_name),
            csv_escape(&seg.app.display_name),
            seg.hwnd,
            seg.process_id,
            csv_escape_opt(&seg.app.window_title),
        ));
    }

    rows.join("\n")
}

fn format_rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn format_rfc3339_opt(t: Option<OffsetDateTime>) -> String {
    t.map(format_rfc3339).unwrap_or_default()
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn csv_escape_opt(value: &Option<String>) -> String {
    value.as_deref().map(csv_escape).unwrap_or_default()
}

fn presence_state_csv(state: &common::PresenceState) -> String {
    match state {
        common::PresenceState::Active => "active",
        common::PresenceState::Idle => "idle",
        common::PresenceState::Locked => "locked",
    }
    .to_string()
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

fn parse_trend_period(value: Option<&str>) -> Result<TrendPeriod, AppError> {
    match value.unwrap_or("week") {
        "week" => Ok(TrendPeriod::Week),
        "month" => Ok(TrendPeriod::Month),
        _ => Err(AppError::bad_request(
            "invalid_period",
            "period must be week or month",
        )),
    }
}

fn parse_usage_metric(value: Option<&str>) -> Result<UsageMetric, AppError> {
    match value.unwrap_or("focus") {
        "focus" => Ok(UsageMetric::Focus),
        "visible_window" => Ok(UsageMetric::VisibleWindow),
        _ => Err(AppError::bad_request(
            "invalid_metric",
            "metric must be focus or visible_window",
        )),
    }
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

fn build_cors_layer(allowed_origins: &[String]) -> CorsLayer {
    let origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE, HeaderName::from_static(EXTENSION_HEADER)])
}

async fn validate_request_origin(
    State(allowed_origins): State<Vec<String>>,
    request: Request,
    next: Next,
) -> Response {
    if let Some(origin) = request.headers().get(ORIGIN)
        && !is_allowed_browser_origin(origin, request.headers(), &allowed_origins)
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

fn is_allowed_browser_origin(
    origin: &HeaderValue,
    headers: &axum::http::HeaderMap,
    allowed_origins: &[String],
) -> bool {
    if is_in_allowed_origins(origin, allowed_origins) {
        return true;
    }

    if origin
        .to_str()
        .ok()
        .is_some_and(|value| value.starts_with("chrome-extension://"))
    {
        return has_extension_header(headers);
    }

    false
}

fn has_extension_header(headers: &HeaderMap) -> bool {
    headers
        .get(EXTENSION_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(EXTENSION_HEADER_VALUE)
}

/// Checks if the request origin matches one of the explicitly allowed origins.
/// This replaces the previous "any loopback origin" predicate with a strict
/// allowlist to prevent other local web applications from reading the API.
fn is_in_allowed_origins(origin: &HeaderValue, allowed_origins: &[String]) -> bool {
    let Ok(origin_str) = origin.to_str() else {
        return false;
    };
    allowed_origins.iter().any(|allowed| allowed == origin_str)
}

async fn frontend_not_built() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Html(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>timeline</title></head><body><h1>前端尚未构建</h1><p>请在项目根目录先运行 <code>cd apps/web-ui &amp;&amp; npm run build</code>，然后重启 timeline。</p></body></html>",
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
            "visible_window_tracker",
            "可见窗口监视器",
            telemetry.visible_windows_last_seen,
            poll_window,
            now,
            "枚举当前桌面实际露出的窗口",
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

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    code: String,
    message: String,
}

impl AppError {
    fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: code.into(),
            message: message.into(),
        }
    }

    fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: code.into(),
            message: message.into(),
        }
    }

    fn internal(error: anyhow::Error) -> Self {
        // Log the full error chain for diagnostics, but return a generic
        // message to the client so we don't leak SQL fragments, file paths,
        // or OS error details to any local web page that can reach the API.
        tracing::error!(?error, "internal API error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error".to_string(),
            message: "内部错误，请查看日志获取详情".to_string(),
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
                    code: self.code,
                    message: self.message,
                }),
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        EXTENSION_HEADER, EXTENSION_HEADER_VALUE, has_extension_header, is_allowed_browser_origin,
        is_in_allowed_origins, parse_usage_metric,
    };
    use axum::http::{HeaderMap, HeaderValue};
    use common::UsageMetric;

    fn default_allowed_origins() -> Vec<String> {
        vec![
            "http://127.0.0.1:46215".to_string(),
            "http://localhost:46215".to_string(),
            "http://127.0.0.1:4173".to_string(),
            "http://localhost:4173".to_string(),
            "http://[::1]:4173".to_string(),
            "http://127.0.0.1:5173".to_string(),
            "http://localhost:5173".to_string(),
            "http://[::1]:5173".to_string(),
        ]
    }

    #[test]
    fn allows_same_origin_and_dev_ports() {
        let allowed = default_allowed_origins();
        assert!(is_in_allowed_origins(
            &HeaderValue::from_static("http://127.0.0.1:46215"),
            &allowed,
        ));
        assert!(is_in_allowed_origins(
            &HeaderValue::from_static("http://localhost:4173"),
            &allowed,
        ));
        assert!(is_in_allowed_origins(
            &HeaderValue::from_static("http://[::1]:5173"),
            &allowed,
        ));
    }

    #[test]
    fn rejects_unlisted_loopback_origins() {
        let allowed = default_allowed_origins();
        // A random loopback port that is not in the allowlist.
        assert!(!is_in_allowed_origins(
            &HeaderValue::from_static("http://127.0.0.1:8888"),
            &allowed,
        ));
        // Non-loopback origins are never allowed.
        assert!(!is_in_allowed_origins(
            &HeaderValue::from_static("https://example.com"),
            &allowed,
        ));
    }

    #[test]
    fn allows_chrome_extension_origin_with_extension_header() {
        let allowed = default_allowed_origins();
        let mut headers = HeaderMap::new();
        headers.insert(
            EXTENSION_HEADER,
            HeaderValue::from_static(EXTENSION_HEADER_VALUE),
        );

        assert!(is_allowed_browser_origin(
            &HeaderValue::from_static("chrome-extension://abc123"),
            &headers,
            &allowed,
        ));
    }

    #[test]
    fn rejects_chrome_extension_origin_without_extension_header() {
        let allowed = default_allowed_origins();
        assert!(!is_allowed_browser_origin(
            &HeaderValue::from_static("chrome-extension://abc123"),
            &HeaderMap::new(),
            &allowed,
        ));
    }

    #[test]
    fn recognizes_required_extension_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            EXTENSION_HEADER,
            HeaderValue::from_static(EXTENSION_HEADER_VALUE),
        );

        assert!(has_extension_header(&headers));

        headers.insert(EXTENSION_HEADER, HeaderValue::from_static("wrong"));

        assert!(!has_extension_header(&headers));
    }

    #[test]
    fn usage_metric_defaults_to_focus_for_compatibility() {
        assert_eq!(parse_usage_metric(None).unwrap(), UsageMetric::Focus);
    }

    #[test]
    fn usage_metric_accepts_visible_window() {
        assert_eq!(
            parse_usage_metric(Some("visible_window")).unwrap(),
            UsageMetric::VisibleWindow
        );
    }

    #[test]
    fn usage_metric_rejects_unknown_values() {
        assert!(parse_usage_metric(Some("active")).is_err());
    }
}
