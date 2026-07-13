//! Axum routes for health checks, timelines, stats, browser event ingestion, and settings.

use crate::{
    config::validate_optional_time_window,
    state::{AgentState, MonitorProbe},
    system,
    trackers::{pause_tracking, reconcile_runtime_config, resume_tracking, sync_browser_event},
};
use anyhow::Result;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, HeaderName, ORIGIN};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{any, get, post},
};
use common::{
    AgentMonitorStatus, AgentSettingsResponse, ApiResponse, AppUsageTrendResponse,
    BrowserEventPayload, DeleteDataRequest, HealthResponse, MonthCalendarResponse,
    PauseTrackingRequest, PeriodSummaryResponse, TrackingStateResponse, TrendPeriod,
    UpdateAgentConfigRequest, UpdateAgentConfigResponse, UpdateAutostartRequest,
    UpdateAutostartResponse, UpdateRetentionRequest,
};
use serde::Deserialize;
use std::net::IpAddr;
use time::format_description::parse;
use time::{Date, Duration, OffsetDateTime};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing::warn;

const EXTENSION_HEADER: &str = "x-timeline-extension";
const EXTENSION_HEADER_VALUE: &str = "browser-bridge";
/// How many raw events to return in the debug endpoint.
const DEBUG_RECENT_EVENTS_LIMIT: i64 = 30;
const MAX_BROWSER_DOMAIN_LENGTH: usize = 253;
const MAX_BROWSER_TITLE_LENGTH: usize = 512;
const MAX_IGNORED_ITEMS: usize = 256;
const MAX_IGNORED_ITEM_LENGTH: usize = 253;
const BROWSER_EVENT_MAX_PAST_SKEW: Duration = Duration::minutes(2);
const BROWSER_EVENT_MAX_FUTURE_SKEW: Duration = Duration::seconds(10);

pub fn build_router(state: AgentState) -> Router {
    let router = Router::new()
        .route("/health", get(get_health))
        .route("/api/timeline/day", get(get_timeline_day))
        .route("/api/stats/apps", get(get_app_stats))
        .route("/api/stats/apps/trend", get(get_app_usage_trend))
        .route("/api/stats/domains", get(get_domain_stats))
        .route("/api/stats/focus", get(get_focus_stats))
        .route("/api/settings", get(get_settings))
        .route("/api/settings/autostart", post(post_autostart))
        .route("/api/settings/config", post(post_update_agent_config))
        .route("/api/debug/recent-events", get(get_recent_events))
        .route("/api/events/browser", post(post_browser_event))
        .route("/api/tracking/pause", post(post_pause_tracking))
        .route("/api/tracking/resume", post(post_resume_tracking))
        .route("/api/data/retention", post(post_retention))
        .route("/api/data/export", get(get_data_export))
        .route("/api/data/backup", get(get_data_backup))
        .route("/api/data/delete", post(post_data_delete))
        .route("/api/calendar/month", get(get_month_calendar))
        .route("/api/stats/summary", get(get_period_summary))
        .route("/api/{*path}", any(api_not_found))
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

#[derive(Debug, Deserialize)]
struct AppTrendQuery {
    date: Option<String>,
    period: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: Option<String>,
    from: String,
    to: String,
}

async fn get_health(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<HealthResponse>>, AppError> {
    Ok(Json(ApiResponse::ok(HealthResponse {
        service: "timeline".to_string(),
        status: "ok".to_string(),
        started_at: state.started_at(),
        database_path: state.config().database_path.display().to_string(),
        listen_addr: state.config().listen_addr.clone(),
        timezone: state.store().timezone_id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: state.store().schema_version().await?,
        rollup_algorithm_version: crate::db::ACTIVE_ROLLUP_ALGORITHM_VERSION.to_string(),
    })))
}

async fn get_timeline_day(
    State(state): State<AgentState>,
    Query(query): Query<DayQuery>,
) -> Result<Json<ApiResponse<common::TimelineDayResponse>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let runtime_config = state.runtime_config_snapshot().await;
    let open_segment_grace =
        Duration::milliseconds((runtime_config.poll_interval_millis * 4) as i64);
    let mut timeline = state
        .store()
        .read_day_timeline(date, state.timezone(), open_segment_grace)
        .await?;
    let now = OffsetDateTime::now_utc();
    if date == now.to_offset(state.timezone()).date() {
        let (focus, browser, presence) = {
            let runtime = state.runtime().await;
            (
                runtime
                    .current_focus
                    .as_ref()
                    .map(|segment| (segment.id, segment.last_observed_at)),
                runtime
                    .current_browser
                    .as_ref()
                    .map(|segment| (segment.id, segment.last_observed_at)),
                runtime
                    .current_presence
                    .as_ref()
                    .map(|segment| (segment.id, segment.last_observed_at)),
            )
        };
        if let Some((id, last_observed_at)) = focus
            && let Some(segment) = timeline
                .focus_segments
                .iter_mut()
                .find(|segment| segment.id == id)
        {
            segment.ended_at = Some(std::cmp::min(now, last_observed_at + open_segment_grace));
        }
        if let Some((id, last_observed_at)) = browser
            && let Some(segment) = timeline
                .browser_segments
                .iter_mut()
                .find(|segment| segment.id == id)
        {
            segment.ended_at = Some(std::cmp::min(now, last_observed_at + open_segment_grace));
        }
        if let Some((id, last_observed_at)) = presence
            && let Some(segment) = timeline
                .presence_segments
                .iter_mut()
                .find(|segment| segment.id == id)
        {
            segment.ended_at = Some(std::cmp::min(now, last_observed_at + open_segment_grace));
        }
    }
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

async fn get_app_usage_trend(
    State(state): State<AgentState>,
    Query(query): Query<AppTrendQuery>,
) -> Result<Json<ApiResponse<AppUsageTrendResponse>>, AppError> {
    let date = parse_or_today(query.date.as_deref(), state.timezone())?;
    let period = parse_trend_period(query.period.as_deref())?;
    let trend = state
        .store()
        .read_app_usage_trend(date, period, query.limit.unwrap_or(6))
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
    let runtime_config = state.runtime_config_snapshot().await;
    let open_segment_grace =
        Duration::milliseconds((runtime_config.poll_interval_millis * 4) as i64);
    let stats = state
        .store()
        .read_focus_stats(date, state.timezone(), open_segment_grace)
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
    let autostart_enabled = system::autostart_enabled(&state)?;
    let runtime_config = state.runtime_config_snapshot().await;
    let monitors = build_monitor_statuses(&state).await;
    let (tracking_paused, paused_since, pause_until) = state.tracking_pause_state().await;
    let retention_days = state
        .store()
        .runtime_setting("retention_days")
        .await?
        .and_then(|value| value.parse().ok());

    Ok(Json(ApiResponse::ok(AgentSettingsResponse {
        autostart_enabled,
        tray_enabled: state.config().tray_enabled,
        web_ui_url: state.config().effective_web_ui_url(),
        launch_command: state.launch_command(),
        idle_threshold_secs: runtime_config.idle_threshold_secs,
        poll_interval_millis: runtime_config.poll_interval_millis,
        health_reminder_enabled: runtime_config.health_reminder_enabled,
        health_reminder_threshold_secs: runtime_config.health_reminder_threshold_secs,
        health_reminder_work_start: runtime_config.health_reminder_work_start,
        health_reminder_work_end: runtime_config.health_reminder_work_end,
        health_reminder_quiet_start: runtime_config.health_reminder_quiet_start,
        health_reminder_quiet_end: runtime_config.health_reminder_quiet_end,
        record_window_titles: runtime_config.record_window_titles,
        record_page_titles: runtime_config.record_page_titles,
        ignored_apps: runtime_config.ignored_apps,
        ignored_domains: runtime_config.ignored_domains,
        recent_apps: state.store().recent_apps(20).await?,
        recent_domains: state.store().recent_domains(20).await?,
        monitors,
        tracking_paused,
        paused_since,
        pause_until,
        retention_days,
        database_size_bytes: state.store().database_size_bytes().await?,
        earliest_recorded_date: state.store().earliest_recorded_date().await?,
        last_backup_at: state.store().last_backup_at().await?,
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: state.store().schema_version().await?,
        active_rollup_status: state.store().active_rollup_status().await?,
    })))
}

async fn post_pause_tracking(
    State(state): State<AgentState>,
    Json(payload): Json<PauseTrackingRequest>,
) -> Result<Json<ApiResponse<TrackingStateResponse>>, AppError> {
    if payload.duration_secs.is_some() && payload.until.is_some() {
        return Err(AppError::bad_request(
            "conflicting_pause_deadline",
            "duration_secs and until cannot be provided together",
        ));
    }
    if payload.duration_secs == Some(0) {
        return Err(AppError::bad_request(
            "invalid_pause_duration",
            "duration_secs must be greater than zero",
        ));
    }
    let now = OffsetDateTime::now_utc();
    let pause_until = match (payload.duration_secs, payload.until) {
        (Some(seconds), None) => Some(
            now.checked_add(Duration::seconds(seconds.min(86_400 * 30) as i64))
                .ok_or_else(|| {
                    AppError::bad_request(
                        "invalid_pause_duration",
                        "pause deadline is out of range",
                    )
                })?,
        ),
        (None, Some(until)) if until <= now => {
            return Err(AppError::bad_request(
                "invalid_pause_deadline",
                "until must be in the future",
            ));
        }
        (None, until) => until,
        _ => None,
    };
    Ok(Json(ApiResponse::ok(
        pause_tracking(&state, pause_until).await?,
    )))
}

async fn post_resume_tracking(
    State(state): State<AgentState>,
) -> Result<Json<ApiResponse<TrackingStateResponse>>, AppError> {
    Ok(Json(ApiResponse::ok(resume_tracking(&state).await?)))
}

async fn post_retention(
    State(state): State<AgentState>,
    Json(payload): Json<UpdateRetentionRequest>,
) -> Result<Json<ApiResponse<UpdateRetentionRequest>>, AppError> {
    if payload
        .retention_days
        .is_some_and(|days| !(30..=3650).contains(&days))
    {
        return Err(AppError::bad_request(
            "invalid_retention_days",
            "retention_days must be null or between 30 and 3650",
        ));
    }
    let value = payload.retention_days.map(|days| days.to_string());
    state
        .store()
        .set_runtime_setting("retention_days", value.as_deref())
        .await?;
    Ok(Json(ApiResponse::ok(payload)))
}

async fn get_data_export(
    State(state): State<AgentState>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, AppError> {
    let from = parse_date(&query.from)?;
    let to = parse_date(&query.to)?;
    if to < from || (to - from).whole_days() > 3650 {
        return Err(AppError::bad_request(
            "invalid_export_range",
            "export date range must be ordered and no longer than 3650 days",
        ));
    }
    let (bytes, content_type, extension) = match query.format.as_deref().unwrap_or("json") {
        "json" => (
            state.store().export_json(from, to).await?,
            "application/json; charset=utf-8",
            "json",
        ),
        "csv" => (
            state.store().export_csv_archive(from, to).await?,
            "application/zip",
            "zip",
        ),
        _ => {
            return Err(AppError::bad_request(
                "invalid_export_format",
                "format must be json or csv",
            ));
        }
    };
    Response::builder()
        .header(CONTENT_TYPE, content_type)
        .header(
            CONTENT_DISPOSITION,
            format!(
                "attachment; filename=timeline-{}-{}.{}",
                query.from, query.to, extension
            ),
        )
        .body(Body::from(bytes))
        .map_err(|error| AppError::internal(anyhow::anyhow!(error)))
}

async fn get_data_backup(State(state): State<AgentState>) -> Result<Response, AppError> {
    let path = state.store().create_online_backup().await?;
    let result = std::fs::read(&path);
    let _ = std::fs::remove_file(&path);
    let bytes = result.map_err(|error| AppError::internal(error.into()))?;
    Response::builder()
        .header(CONTENT_TYPE, "application/vnd.sqlite3")
        .header(
            CONTENT_DISPOSITION,
            "attachment; filename=timeline-backup.sqlite",
        )
        .body(Body::from(bytes))
        .map_err(|error| AppError::internal(anyhow::anyhow!(error)))
}

async fn post_data_delete(
    State(state): State<AgentState>,
    Json(payload): Json<DeleteDataRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    if payload.all && (payload.from.is_some() || payload.to.is_some()) {
        return Err(AppError::bad_request(
            "conflicting_delete_range",
            "from/to must be omitted when all is true",
        ));
    }
    let from = payload.from.as_deref().map(parse_date).transpose()?;
    let to = payload.to.as_deref().map(parse_date).transpose()?;
    if !payload.all && (from.is_none() || to.is_none()) {
        return Err(AppError::bad_request(
            "missing_delete_range",
            "from and to are required unless all is true",
        ));
    }
    let pause_state = state.tracking_pause_state().await;
    crate::trackers::shutdown_open_segments(&state).await?;
    state.store().delete_data(from, to, payload.all).await?;
    if pause_state.0 {
        pause_tracking(&state, pause_state.2).await?;
    }
    Ok(Json(ApiResponse::ok(serde_json::json!({"deleted": true}))))
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
    if payload.health_reminder_work_start.is_some() || payload.health_reminder_work_end.is_some() {
        next.health_reminder_work_start =
            normalize_optional_config_time(payload.health_reminder_work_start.as_deref());
        next.health_reminder_work_end =
            normalize_optional_config_time(payload.health_reminder_work_end.as_deref());
    }
    if payload.health_reminder_quiet_start.is_some() || payload.health_reminder_quiet_end.is_some()
    {
        next.health_reminder_quiet_start =
            normalize_optional_config_time(payload.health_reminder_quiet_start.as_deref());
        next.health_reminder_quiet_end =
            normalize_optional_config_time(payload.health_reminder_quiet_end.as_deref());
    }
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
    reconcile_runtime_config(&state).await?;

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

    let mut payload = payload;
    payload.domain = payload
        .domain
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    payload.page_title = payload.page_title.map(|value| value.trim().to_string());
    validate_browser_event_payload(&payload)?;

    let received_at = OffsetDateTime::now_utc();
    let observed_at = normalize_browser_observed_at(payload.observed_at, received_at);
    if payload
        .observed_at
        .is_some_and(|value| value != observed_at)
    {
        warn!(
            reported_at = ?payload.observed_at,
            normalized_at = ?observed_at,
            "browser event timestamp exceeded the accepted clock-skew window"
        );
    }
    payload.observed_at = Some(observed_at);
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
        return parse_date(value);
    }

    Ok(OffsetDateTime::now_utc().to_offset(timezone).date())
}

fn parse_date(value: &str) -> Result<Date, AppError> {
    let format = parse("[year]-[month]-[day]")
        .map_err(|error| AppError::internal(anyhow::anyhow!(error)))?;
    Date::parse(value, &format)
        .map_err(|_| AppError::bad_request("invalid_date", "date must use YYYY-MM-DD"))
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
        .allow_headers([CONTENT_TYPE, HeaderName::from_static(EXTENSION_HEADER)])
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
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>timeline</title></head><body><h1>前端尚未构建</h1><p>请在项目根目录先运行 <code>cd apps/web-ui &amp;&amp; npm run build</code>，然后重启 timeline。</p></body></html>",
        ),
    )
}

async fn api_not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(ApiResponse::<()>::err(
            "not_found",
            "the requested API endpoint does not exist",
        )),
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
            &telemetry.focus,
            poll_window,
            now,
            "轮询前台应用和窗口标题",
        ),
        monitor_status(
            "presence_tracker",
            "使用状态监视器",
            &telemetry.presence,
            poll_window,
            now,
            "轮询活跃、空闲、锁定和暂停状态",
        ),
        monitor_status(
            "browser_bridge",
            "浏览器桥接",
            &telemetry.browser,
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
            last_seen: telemetry.tray.last_seen,
            last_error: telemetry.tray.last_error,
            consecutive_failures: telemetry.tray.consecutive_failures,
            restart_count: telemetry.tray.restart_count,
        },
    ]
}

fn monitor_status(
    key: &str,
    label: &str,
    probe: &MonitorProbe,
    freshness: Duration,
    now: OffsetDateTime,
    detail: &str,
) -> AgentMonitorStatus {
    let status = match (
        probe.recovering,
        probe.consecutive_failures,
        probe.last_seen,
    ) {
        (true, _, _) => "recovering",
        (_, failures, _) if failures >= 3 => "offline",
        (_, failures, _) if failures > 0 => "degraded",
        (_, _, Some(seen_at)) if now - seen_at <= freshness => "online",
        (_, _, Some(_)) => "offline",
        (_, _, None) => "recovering",
    };

    AgentMonitorStatus {
        key: key.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail: detail.to_string(),
        last_seen: probe.last_seen,
        last_error: probe.last_error.clone(),
        consecutive_failures: probe.consecutive_failures,
        restart_count: probe.restart_count,
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

    validate_health_reminder_time_window(
        "health_reminder_work_hours",
        payload.health_reminder_work_start.as_deref(),
        payload.health_reminder_work_end.as_deref(),
    )?;
    validate_health_reminder_time_window(
        "health_reminder_quiet_hours",
        payload.health_reminder_quiet_start.as_deref(),
        payload.health_reminder_quiet_end.as_deref(),
    )?;

    validate_ignored_list("ignored_apps", &payload.ignored_apps)?;
    validate_ignored_list("ignored_domains", &payload.ignored_domains)?;

    Ok(())
}

fn validate_health_reminder_time_window(
    field: &'static str,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<(), AppError> {
    validate_optional_time_window(field, start, end).map_err(|error| {
        AppError::bad_request("invalid_health_reminder_time_window", error.to_string())
    })?;
    Ok(())
}

fn normalize_optional_config_time(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_ignored_list(field: &'static str, items: &[String]) -> Result<(), AppError> {
    if items.len() > MAX_IGNORED_ITEMS {
        return Err(AppError::bad_request(
            "too_many_ignored_items",
            format!("{field} must contain at most {MAX_IGNORED_ITEMS} items"),
        ));
    }
    if items
        .iter()
        .any(|item| item.trim().chars().count() > MAX_IGNORED_ITEM_LENGTH)
    {
        return Err(AppError::bad_request(
            "ignored_item_too_long",
            format!("{field} items must be at most {MAX_IGNORED_ITEM_LENGTH} characters"),
        ));
    }
    Ok(())
}

fn validate_browser_event_payload(payload: &BrowserEventPayload) -> Result<(), AppError> {
    if payload.domain.is_empty()
        || payload.domain.len() > MAX_BROWSER_DOMAIN_LENGTH
        || !is_valid_hostname(&payload.domain)
    {
        return Err(AppError::bad_request(
            "invalid_browser_domain",
            "domain must be a valid hostname with at most 253 characters",
        ));
    }
    if payload
        .page_title
        .as_ref()
        .is_some_and(|title| title.chars().count() > MAX_BROWSER_TITLE_LENGTH)
    {
        return Err(AppError::bad_request(
            "browser_title_too_long",
            "page_title must be at most 512 characters",
        ));
    }
    if payload.browser_window_id <= 0 || payload.tab_id <= 0 {
        return Err(AppError::bad_request(
            "invalid_browser_tab",
            "browser_window_id and tab_id must be positive",
        ));
    }
    Ok(())
}

fn is_valid_hostname(value: &str) -> bool {
    if value.parse::<IpAddr>().is_ok() {
        return true;
    }
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn normalize_browser_observed_at(
    observed_at: Option<OffsetDateTime>,
    received_at: OffsetDateTime,
) -> OffsetDateTime {
    match observed_at {
        Some(value)
            if value >= received_at - BROWSER_EVENT_MAX_PAST_SKEW
                && value <= received_at + BROWSER_EVENT_MAX_FUTURE_SKEW =>
        {
            value
        }
        _ => received_at,
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

    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
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
    use super::{
        EXTENSION_HEADER, EXTENSION_HEADER_VALUE, has_extension_header, is_allowed_browser_origin,
        is_allowed_loopback_origin, is_valid_hostname, monitor_status,
        normalize_browser_observed_at, validate_browser_event_payload,
    };
    use crate::state::MonitorProbe;
    use axum::http::{HeaderMap, HeaderValue};
    use common::BrowserEventPayload;
    use time::{Duration, OffsetDateTime};

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

    #[test]
    fn allows_chrome_extension_origin_with_extension_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            EXTENSION_HEADER,
            HeaderValue::from_static(EXTENSION_HEADER_VALUE),
        );

        assert!(is_allowed_browser_origin(
            &HeaderValue::from_static("chrome-extension://abc123"),
            &headers,
        ));
    }

    #[test]
    fn rejects_chrome_extension_origin_without_extension_header() {
        assert!(!is_allowed_browser_origin(
            &HeaderValue::from_static("chrome-extension://abc123"),
            &HeaderMap::new(),
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
    fn validates_browser_hostnames_and_payload_bounds() {
        assert!(is_valid_hostname("docs.rs"));
        assert!(is_valid_hostname("127.0.0.1"));
        assert!(!is_valid_hostname("bad host.example"));
        assert!(!is_valid_hostname("-bad.example"));

        let payload = BrowserEventPayload {
            domain: "docs.rs".to_string(),
            page_title: Some("SQLx".to_string()),
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
        };
        assert!(validate_browser_event_payload(&payload).is_ok());

        let invalid = BrowserEventPayload {
            tab_id: 0,
            ..payload
        };
        assert!(validate_browser_event_payload(&invalid).is_err());
    }

    #[test]
    fn clamps_browser_timestamps_outside_clock_skew_window() {
        let received_at = OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("time");
        assert_eq!(
            normalize_browser_observed_at(Some(received_at - Duration::minutes(3)), received_at,),
            received_at
        );
        assert_eq!(
            normalize_browser_observed_at(Some(received_at - Duration::seconds(30)), received_at),
            received_at - Duration::seconds(30)
        );
    }

    #[test]
    fn monitor_status_distinguishes_degraded_recovering_and_offline() {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("time");
        let freshness = Duration::seconds(4);
        let mut probe = MonitorProbe {
            last_seen: Some(now),
            consecutive_failures: 1,
            ..MonitorProbe::default()
        };
        assert_eq!(
            monitor_status("focus", "前台", &probe, freshness, now, "detail").status,
            "degraded"
        );

        probe.recovering = true;
        assert_eq!(
            monitor_status("focus", "前台", &probe, freshness, now, "detail").status,
            "recovering"
        );

        probe.recovering = false;
        probe.consecutive_failures = 3;
        assert_eq!(
            monitor_status("focus", "前台", &probe, freshness, now, "detail").status,
            "offline"
        );
    }
}
