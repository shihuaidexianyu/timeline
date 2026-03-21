//! Axum routes for health checks, timelines, stats, and browser event ingestion.

use crate::{state::AgentState, trackers::sync_browser_event};
use anyhow::Result;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use common::{ApiResponse, BrowserEventPayload, HealthResponse};
use serde::Deserialize;
use time::format_description::parse;
use time::{Date, OffsetDateTime};

pub fn build_router(state: AgentState) -> Router {
    Router::new()
        .route("/health", get(get_health))
        .route("/api/timeline/day", get(get_timeline_day))
        .route("/api/stats/apps", get(get_app_stats))
        .route("/api/stats/domains", get(get_domain_stats))
        .route("/api/stats/focus", get(get_focus_stats))
        .route("/api/debug/recent-events", get(get_recent_events))
        .route("/api/events/browser", post(post_browser_event))
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
        service: "desktop-agent".to_string(),
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
