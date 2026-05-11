//! SQLite initialization, migrations, writes, and read models for the timeline agent.

use crate::config::AppConfig;
use anyhow::{Context, Result, anyhow};
use common::{
    AppInfo, BrowserEventPayload, BrowserSegment, DaySummary, DebugEvent, DurationStat,
    FocusSegment, FocusStats, KeyedDurationEntry, MonthCalendarResponse, PeriodStat,
    PeriodSummaryResponse, PresenceSegment, PresenceState, TimelineDayResponse,
};
use serde::Serialize;
use sqlx::{Row, SqlitePool, sqlite::SqliteConnectOptions};
use std::collections::BTreeMap;
use std::str::FromStr;
use time::format_description::well_known::Rfc3339;
use time::{Date, Duration, OffsetDateTime, PrimitiveDateTime, UtcOffset};

#[derive(Clone)]
pub struct AgentStore {
    pool: SqlitePool,
}

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "create_core_tables",
        sql: r#"
CREATE TABLE IF NOT EXISTS app_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  icon_hint TEXT,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS focus_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  exe_path TEXT,
  window_title TEXT,
  is_browser INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  page_title TEXT,
  browser_window_id INTEGER NOT NULL,
  tab_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presence_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"#,
    },
    Migration {
        version: 2,
        name: "create_indexes",
        sql: r#"
CREATE INDEX IF NOT EXISTS idx_focus_segments_started_at ON focus_segments(started_at);
CREATE INDEX IF NOT EXISTS idx_focus_segments_process_name ON focus_segments(process_name);
CREATE INDEX IF NOT EXISTS idx_browser_segments_started_at ON browser_segments(started_at);
CREATE INDEX IF NOT EXISTS idx_browser_segments_domain ON browser_segments(domain);
CREATE INDEX IF NOT EXISTS idx_presence_segments_started_at ON presence_segments(started_at);
CREATE INDEX IF NOT EXISTS idx_raw_events_observed_at ON raw_events(observed_at);
"#,
    },
    Migration {
        version: 3,
        name: "add_last_seen_columns",
        sql: r#"
ALTER TABLE focus_segments ADD COLUMN last_seen_at TEXT;
ALTER TABLE browser_segments ADD COLUMN last_seen_at TEXT;
ALTER TABLE presence_segments ADD COLUMN last_seen_at TEXT;

UPDATE focus_segments
SET last_seen_at = COALESCE(ended_at, started_at)
WHERE last_seen_at IS NULL;

UPDATE browser_segments
SET last_seen_at = COALESCE(ended_at, started_at)
WHERE last_seen_at IS NULL;

UPDATE presence_segments
SET last_seen_at = COALESCE(ended_at, started_at)
WHERE last_seen_at IS NULL;
"#,
    },
    Migration {
        version: 4,
        name: "add_performance_indexes",
        sql: r#"
CREATE INDEX IF NOT EXISTS idx_focus_segments_time_range ON focus_segments(started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_browser_segments_time_range ON browser_segments(started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_presence_segments_time_range ON presence_segments(started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_presence_segments_state_time ON presence_segments(state, started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_focus_segments_open ON focus_segments(id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_browser_segments_open ON browser_segments(id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_presence_segments_open ON presence_segments(id) WHERE ended_at IS NULL;
"#,
    },
];

/// Keep recent raw events for local debugging while capping unbounded DB growth.
const RAW_EVENTS_MAX_ROWS: i64 = 50_000;

impl AgentStore {
    pub async fn connect(config: &AppConfig) -> Result<Self> {
        config.ensure_parent_dirs()?;

        let connect_options = SqliteConnectOptions::from_str(
            config
                .database_path
                .to_str()
                .ok_or_else(|| anyhow!("database path is not valid UTF-8"))?,
        )?
        .create_if_missing(true)
        .pragma("journal_mode", "WAL")
        .pragma("synchronous", "NORMAL");

        let pool = SqlitePool::connect_with(connect_options)
            .await
            .context("failed to connect sqlite")?;

        let store = Self { pool };
        store.run_migrations().await?;
        Ok(store)
    }

    /// Closes all segments left open from a previous session by setting `ended_at`
    /// to `last_seen_at` (or `started_at` as fallback). Runs in a transaction so that
    /// all three tables are updated atomically — a partial failure won't leave
    /// inconsistent state across segment types.
    pub async fn restore_unclosed_segments(&self) -> Result<()> {
        let mut tx = self
            .pool
            .begin()
            .await
            .context("failed to begin transaction")?;

        sqlx::query(
            "UPDATE focus_segments SET ended_at = COALESCE(last_seen_at, started_at) WHERE ended_at IS NULL",
        )
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE browser_segments SET ended_at = COALESCE(last_seen_at, started_at) WHERE ended_at IS NULL",
        )
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE presence_segments SET ended_at = COALESCE(last_seen_at, started_at) WHERE ended_at IS NULL",
        )
            .execute(&mut *tx)
            .await?;

        tx.commit()
            .await
            .context("failed to commit restore_unclosed_segments")?;
        Ok(())
    }

    pub async fn upsert_app_registry(
        &self,
        process_name: &str,
        display_name: &str,
        observed_at: OffsetDateTime,
    ) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query(
            r#"
INSERT INTO app_registry (process_name, display_name, created_at, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(process_name) DO UPDATE
SET display_name = excluded.display_name,
    updated_at = excluded.updated_at
"#,
        )
        .bind(process_name)
        .bind(display_name)
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn start_focus_segment(
        &self,
        app: &AppInfo,
        observed_at: OffsetDateTime,
    ) -> Result<i64> {
        let observed_at = format_time(observed_at)?;
        let result = sqlx::query(
            r#"
INSERT INTO focus_segments (
  process_name,
  display_name,
  exe_path,
  window_title,
  is_browser,
  started_at,
  last_seen_at,
  created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"#,
        )
        .bind(&app.process_name)
        .bind(&app.display_name)
        .bind(&app.exe_path)
        .bind(&app.window_title)
        .bind(if app.is_browser { 1 } else { 0 })
        .bind(&observed_at)
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn end_focus_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE focus_segments SET last_seen_at = ?, ended_at = ? WHERE id = ?")
            .bind(&observed_at)
            .bind(&observed_at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn touch_focus_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE focus_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL")
            .bind(observed_at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn start_presence_segment(
        &self,
        state: PresenceState,
        observed_at: OffsetDateTime,
    ) -> Result<i64> {
        let observed_at = format_time(observed_at)?;
        let result = sqlx::query(
            "INSERT INTO presence_segments (state, started_at, last_seen_at, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(presence_label(&state))
        .bind(&observed_at)
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn end_presence_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE presence_segments SET last_seen_at = ?, ended_at = ? WHERE id = ?")
            .bind(&observed_at)
            .bind(&observed_at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn touch_presence_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query(
            "UPDATE presence_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
        )
        .bind(observed_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn start_browser_segment(
        &self,
        payload: &BrowserEventPayload,
        observed_at: OffsetDateTime,
    ) -> Result<i64> {
        let observed_at = format_time(observed_at)?;
        let result = sqlx::query(
            r#"
INSERT INTO browser_segments (
  domain,
  page_title,
  browser_window_id,
  tab_id,
  started_at,
  last_seen_at,
  created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?)
"#,
        )
        .bind(&payload.domain)
        .bind(&payload.page_title)
        .bind(payload.browser_window_id)
        .bind(payload.tab_id)
        .bind(&observed_at)
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn end_browser_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE browser_segments SET last_seen_at = ?, ended_at = ? WHERE id = ?")
            .bind(&observed_at)
            .bind(&observed_at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn touch_browser_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query(
            "UPDATE browser_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
        )
        .bind(observed_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn append_raw_event<T>(
        &self,
        kind: &str,
        payload: &T,
        observed_at: OffsetDateTime,
    ) -> Result<()>
    where
        T: Serialize + ?Sized,
    {
        let observed_at_text = format_time(observed_at)?;
        let payload_json = serde_json::to_string(payload)?;
        sqlx::query(
            "INSERT INTO raw_events (kind, payload_json, observed_at, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(kind)
        .bind(payload_json)
        .bind(&observed_at_text)
        .bind(&observed_at_text)
        .execute(&self.pool)
        .await?;

        sqlx::query("DELETE FROM raw_events WHERE id <= (SELECT MAX(id) - ? FROM raw_events)")
            .bind(RAW_EVENTS_MAX_ROWS)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn read_day_timeline(
        &self,
        date: Date,
        timezone: UtcOffset,
    ) -> Result<TimelineDayResponse> {
        let (day_start_utc, day_end_utc) = day_bounds(date, timezone)?;
        let now_utc = OffsetDateTime::now_utc();
        let day_start_text = format_time(day_start_utc)?;
        let day_end_text = format_time(day_end_utc)?;
        let now_text = format_time(now_utc)?;

        let focus_rows = sqlx::query(
            r#"
SELECT id, process_name, display_name, exe_path, window_title, is_browser, started_at, ended_at
FROM focus_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
ORDER BY started_at ASC
"#,
        )
        .bind(&day_end_text)
        .bind(&now_text)
        .bind(&day_start_text)
        .fetch_all(&self.pool)
        .await?;

        let browser_rows = sqlx::query(
            r#"
SELECT id, domain, page_title, browser_window_id, tab_id, started_at, ended_at
FROM browser_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
ORDER BY started_at ASC
"#,
        )
        .bind(&day_end_text)
        .bind(&now_text)
        .bind(&day_start_text)
        .fetch_all(&self.pool)
        .await?;

        let presence_rows = sqlx::query(
            r#"
SELECT id, state, started_at, ended_at
FROM presence_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
ORDER BY started_at ASC
"#,
        )
        .bind(&day_end_text)
        .bind(&now_text)
        .bind(&day_start_text)
        .fetch_all(&self.pool)
        .await?;

        let mut focus_segments = Vec::new();
        for row in focus_rows {
            let (started_at, ended_at) =
                parse_segment_bounds(&row, now_utc, day_start_utc, day_end_utc)?;

            focus_segments.push(FocusSegment {
                id: row.get("id"),
                started_at,
                ended_at: Some(ended_at),
                app: AppInfo {
                    process_name: row.get("process_name"),
                    display_name: row.get("display_name"),
                    exe_path: row.get("exe_path"),
                    window_title: row.get("window_title"),
                    is_browser: row.get::<i64, _>("is_browser") == 1,
                },
            });
        }

        let mut browser_segments = Vec::new();
        for row in browser_rows {
            let (started_at, ended_at) =
                parse_segment_bounds(&row, now_utc, day_start_utc, day_end_utc)?;

            browser_segments.push(BrowserSegment {
                id: row.get("id"),
                domain: row.get("domain"),
                page_title: row.get("page_title"),
                browser_window_id: row.get("browser_window_id"),
                tab_id: row.get("tab_id"),
                started_at,
                ended_at: Some(ended_at),
            });
        }

        let mut presence_segments = Vec::new();
        for row in presence_rows {
            let (started_at, ended_at) =
                parse_segment_bounds(&row, now_utc, day_start_utc, day_end_utc)?;

            presence_segments.push(PresenceSegment {
                id: row.get("id"),
                state: parse_presence_state(row.get::<String, _>("state").as_str())?,
                started_at,
                ended_at: Some(ended_at),
            });
        }

        Ok(TimelineDayResponse {
            date: date.to_string(),
            timezone: timezone.to_string(),
            focus_segments,
            browser_segments,
            presence_segments,
        })
    }

    /// Parses a raw focus segment without clamping to day boundaries.
    fn parse_focus_segment_row(row: &sqlx::sqlite::SqliteRow) -> Result<FocusSegment> {
        let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
        let ended_at = row
            .get::<Option<String>, _>("ended_at")
            .map(|v| parse_time(&v))
            .transpose()?;
        Ok(FocusSegment {
            id: row.get("id"),
            started_at,
            ended_at,
            app: AppInfo {
                process_name: row.get("process_name"),
                display_name: row.get("display_name"),
                exe_path: row.get("exe_path"),
                window_title: row.get("window_title"),
                is_browser: row.get::<i64, _>("is_browser") == 1,
            },
        })
    }

    /// Parses a raw browser segment without clamping to day boundaries.
    fn parse_browser_segment_row(row: &sqlx::sqlite::SqliteRow) -> Result<BrowserSegment> {
        let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
        let ended_at = row
            .get::<Option<String>, _>("ended_at")
            .map(|v| parse_time(&v))
            .transpose()?;
        Ok(BrowserSegment {
            id: row.get("id"),
            domain: row.get("domain"),
            page_title: row.get("page_title"),
            browser_window_id: row.get("browser_window_id"),
            tab_id: row.get("tab_id"),
            started_at,
            ended_at,
        })
    }

    /// Parses a raw presence segment without clamping to day boundaries.
    fn parse_presence_segment_row(row: &sqlx::sqlite::SqliteRow) -> Result<PresenceSegment> {
        let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
        let ended_at = row
            .get::<Option<String>, _>("ended_at")
            .map(|v| parse_time(&v))
            .transpose()?;
        Ok(PresenceSegment {
            id: row.get("id"),
            state: parse_presence_state(row.get::<String, _>("state").as_str())?,
            started_at,
            ended_at,
        })
    }

    pub async fn read_app_stats(
        &self,
        date: Date,
        timezone: UtcOffset,
    ) -> Result<Vec<DurationStat>> {
        let timeline = self.read_day_timeline(date, timezone).await?;
        let total_seconds = timeline
            .focus_segments
            .iter()
            .map(segment_seconds_focus)
            .sum::<i64>();

        let mut buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();
        for segment in timeline.focus_segments {
            let seconds = segment_seconds_focus(&segment);
            let entry = buckets
                .entry(segment.app.process_name.clone())
                .or_insert((segment.app.display_name.clone(), 0));
            entry.1 += seconds;
        }

        Ok(to_duration_stats(buckets, total_seconds))
    }

    pub async fn read_domain_stats(
        &self,
        date: Date,
        timezone: UtcOffset,
    ) -> Result<Vec<DurationStat>> {
        let timeline = self.read_day_timeline(date, timezone).await?;
        let total_seconds = timeline
            .browser_segments
            .iter()
            .map(segment_seconds_browser)
            .sum::<i64>();

        let mut buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();
        for segment in timeline.browser_segments {
            let seconds = segment_seconds_browser(&segment);
            let entry = buckets
                .entry(segment.domain.clone())
                .or_insert((segment.domain.clone(), 0));
            entry.1 += seconds;
        }

        Ok(to_duration_stats(buckets, total_seconds))
    }

    pub async fn read_focus_stats(&self, date: Date, timezone: UtcOffset) -> Result<FocusStats> {
        let timeline = self.read_day_timeline(date, timezone).await?;
        let focus_lengths: Vec<i64> = timeline
            .focus_segments
            .iter()
            .map(segment_seconds_focus)
            .filter(|seconds| *seconds > 0)
            .collect();

        let total_focus_seconds = focus_lengths.iter().sum::<i64>();
        let longest_focus_block_seconds = focus_lengths.iter().copied().max().unwrap_or(0);
        let average_focus_block_seconds = if focus_lengths.is_empty() {
            0
        } else {
            total_focus_seconds / focus_lengths.len() as i64
        };

        let total_active_seconds = timeline
            .presence_segments
            .iter()
            .filter(|segment| matches!(segment.state, PresenceState::Active))
            .map(segment_seconds_presence)
            .sum::<i64>();

        Ok(FocusStats {
            total_focus_seconds,
            total_active_seconds,
            switch_count: timeline.focus_segments.len().saturating_sub(1) as i64,
            longest_focus_block_seconds,
            average_focus_block_seconds,
        })
    }

    /// Aggregates a single day's segments into a compact summary for calendar
    /// and overview card display.
    pub async fn read_day_summary(&self, date: Date, timezone: UtcOffset) -> Result<DaySummary> {
        let timeline = self.read_day_timeline(date, timezone).await?;

        let focus_seconds: i64 = timeline
            .focus_segments
            .iter()
            .map(segment_seconds_focus)
            .sum();
        let active_seconds: i64 = timeline
            .presence_segments
            .iter()
            .filter(|s| matches!(s.state, PresenceState::Active))
            .map(segment_seconds_presence)
            .sum();
        let browser_seconds: i64 = timeline
            .browser_segments
            .iter()
            .map(segment_seconds_browser)
            .sum();
        let switch_count = timeline.focus_segments.len().saturating_sub(1) as i64;

        let top_app = top_entry(
            &timeline.focus_segments,
            |s| s.app.process_name.clone(),
            |s| s.app.display_name.clone(),
            segment_seconds_focus,
        );
        let top_domain = top_entry(
            &timeline.browser_segments,
            |s| s.domain.clone(),
            |s| s.domain.clone(),
            segment_seconds_browser,
        );

        Ok(DaySummary {
            date: date.to_string(),
            focus_seconds,
            active_seconds,
            browser_seconds,
            switch_count,
            top_app,
            top_domain,
        })
    }

    /// Returns daily summaries for every day in the given month.
    /// Optimized to fetch all segments in 3 queries and aggregate in memory,
    /// avoiding the previous N+1 pattern of calling read_day_summary per day.
    pub async fn read_month_calendar(
        &self,
        year: i32,
        month: time::Month,
        timezone: UtcOffset,
    ) -> Result<MonthCalendarResponse> {
        let first_day =
            Date::from_calendar_date(year, month, 1).map_err(|e| anyhow!("invalid month: {e}"))?;
        let days_in_month = days_in_month(year, month) as i64;

        let month_start_local =
            PrimitiveDateTime::new(first_day, time::Time::MIDNIGHT).assume_offset(timezone);
        let month_end_local = PrimitiveDateTime::new(
            first_day + Duration::days(days_in_month),
            time::Time::MIDNIGHT,
        )
        .assume_offset(timezone);

        let month_start_utc = month_start_local.to_offset(UtcOffset::UTC);
        let month_end_utc = month_end_local.to_offset(UtcOffset::UTC);
        let now_utc = OffsetDateTime::now_utc();

        let month_start_text = format_time(month_start_utc)?;
        let month_end_text = format_time(month_end_utc)?;
        let now_text = format_time(now_utc)?;

        let focus_rows = sqlx::query(
            r#"
SELECT id, process_name, display_name, exe_path, window_title, is_browser, started_at, ended_at
FROM focus_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
ORDER BY started_at ASC
"#,
        )
        .bind(&month_end_text)
        .bind(&now_text)
        .bind(&month_start_text)
        .fetch_all(&self.pool)
        .await?;

        let browser_rows = sqlx::query(
            r#"
SELECT id, domain, page_title, browser_window_id, tab_id, started_at, ended_at
FROM browser_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
ORDER BY started_at ASC
"#,
        )
        .bind(&month_end_text)
        .bind(&now_text)
        .bind(&month_start_text)
        .fetch_all(&self.pool)
        .await?;

        let presence_rows = sqlx::query(
            r#"
SELECT id, state, started_at, ended_at
FROM presence_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
ORDER BY started_at ASC
"#,
        )
        .bind(&month_end_text)
        .bind(&now_text)
        .bind(&month_start_text)
        .fetch_all(&self.pool)
        .await?;

        let focus_segments: Vec<FocusSegment> = focus_rows
            .iter()
            .map(Self::parse_focus_segment_row)
            .collect::<Result<Vec<_>>>()?;
        let browser_segments: Vec<BrowserSegment> = browser_rows
            .iter()
            .map(Self::parse_browser_segment_row)
            .collect::<Result<Vec<_>>>()?;
        let presence_segments: Vec<PresenceSegment> = presence_rows
            .iter()
            .map(Self::parse_presence_segment_row)
            .collect::<Result<Vec<_>>>()?;

        let mut days = Vec::with_capacity(days_in_month as usize);
        for day_offset in 0..days_in_month {
            let date = first_day + Duration::days(day_offset);
            let (day_start_utc, day_end_utc) = day_bounds(date, timezone)?;

            let mut focus_seconds = 0i64;
            let mut browser_seconds = 0i64;
            let mut active_seconds = 0i64;
            let mut focus_count = 0usize;
            let mut app_buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();
            let mut domain_buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();

            for seg in &focus_segments {
                let seg_end = seg.ended_at.unwrap_or(now_utc);
                if seg.started_at < day_end_utc && seg_end > day_start_utc {
                    let start = clamp_start(seg.started_at, day_start_utc);
                    let end = clamp_end(seg_end, day_end_utc, day_start_utc);
                    let seconds = (end - start).whole_seconds().max(0);
                    focus_seconds += seconds;
                    focus_count += 1;
                    app_buckets
                        .entry(seg.app.process_name.clone())
                        .or_insert((seg.app.display_name.clone(), 0))
                        .1 += seconds;
                }
            }

            for seg in &browser_segments {
                let seg_end = seg.ended_at.unwrap_or(now_utc);
                if seg.started_at < day_end_utc && seg_end > day_start_utc {
                    let start = clamp_start(seg.started_at, day_start_utc);
                    let end = clamp_end(seg_end, day_end_utc, day_start_utc);
                    let seconds = (end - start).whole_seconds().max(0);
                    browser_seconds += seconds;
                    domain_buckets
                        .entry(seg.domain.clone())
                        .or_insert((seg.domain.clone(), 0))
                        .1 += seconds;
                }
            }

            for seg in &presence_segments {
                let seg_end = seg.ended_at.unwrap_or(now_utc);
                if seg.state == PresenceState::Active
                    && seg.started_at < day_end_utc
                    && seg_end > day_start_utc
                {
                    let start = clamp_start(seg.started_at, day_start_utc);
                    let end = clamp_end(seg_end, day_end_utc, day_start_utc);
                    let seconds = (end - start).whole_seconds().max(0);
                    active_seconds += seconds;
                }
            }

            let top_app = app_buckets
                .into_iter()
                .max_by_key(|(_, (_, seconds))| *seconds)
                .map(|(key, (label, seconds))| KeyedDurationEntry {
                    key,
                    label,
                    seconds,
                });

            let top_domain = domain_buckets
                .into_iter()
                .max_by_key(|(_, (_, seconds))| *seconds)
                .map(|(key, (label, seconds))| KeyedDurationEntry {
                    key,
                    label,
                    seconds,
                });

            days.push(DaySummary {
                date: date.to_string(),
                focus_seconds,
                active_seconds,
                browser_seconds,
                switch_count: focus_count.saturating_sub(1) as i64,
                top_app,
                top_domain,
            });
        }

        Ok(MonthCalendarResponse {
            month: format!("{:04}-{:02}", year, month as u8),
            timezone: timezone.to_string(),
            days,
        })
    }

    /// Returns today / this-week / this-month aggregated totals relative to
    /// the given anchor date.
    pub async fn read_period_summary(
        &self,
        anchor_date: Date,
        timezone: UtcOffset,
    ) -> Result<PeriodSummaryResponse> {
        let today_summary = self.read_day_summary(anchor_date, timezone).await?;
        let today = PeriodStat {
            focus_seconds: today_summary.focus_seconds,
            active_seconds: today_summary.active_seconds,
        };

        // Natural week: Monday through Sunday.
        let weekday_offset = anchor_date.weekday().number_days_from_monday() as i64;
        let week_start = anchor_date - Duration::days(weekday_offset);
        let week_end = week_start + Duration::days(6);
        let week = self
            .aggregate_period(week_start, week_end, timezone)
            .await?;

        // Natural month.
        let month_start = Date::from_calendar_date(anchor_date.year(), anchor_date.month(), 1)
            .map_err(|e| anyhow!("invalid month start: {e}"))?;
        let month_days = days_in_month(anchor_date.year(), anchor_date.month());
        let month_end = month_start + Duration::days(month_days as i64 - 1);
        let month = self
            .aggregate_period(month_start, month_end, timezone)
            .await?;

        Ok(PeriodSummaryResponse {
            date: anchor_date.to_string(),
            timezone: timezone.to_string(),
            today,
            week,
            month,
        })
    }

    async fn aggregate_period(
        &self,
        start: Date,
        end: Date,
        timezone: UtcOffset,
    ) -> Result<PeriodStat> {
        let start_local =
            PrimitiveDateTime::new(start, time::Time::MIDNIGHT).assume_offset(timezone);
        let end_next_day = end
            .next_day()
            .ok_or_else(|| anyhow!("period end date overflow"))?;
        let end_local =
            PrimitiveDateTime::new(end_next_day, time::Time::MIDNIGHT).assume_offset(timezone);

        let period_start_utc = start_local.to_offset(UtcOffset::UTC);
        let period_end_utc = end_local.to_offset(UtcOffset::UTC);
        let now_utc = OffsetDateTime::now_utc();

        let period_start_text = format_time(period_start_utc)?;
        let period_end_text = format_time(period_end_utc)?;
        let now_text = format_time(now_utc)?;

        let focus_seconds: i64 = sqlx::query_scalar(
            r#"
SELECT COALESCE(SUM(
    CASE
        WHEN strftime('%s', MIN(COALESCE(ended_at, ?), ?)) > strftime('%s', MAX(started_at, ?))
            THEN strftime('%s', MIN(COALESCE(ended_at, ?), ?)) - strftime('%s', MAX(started_at, ?))
        ELSE 0
    END
), 0)
FROM focus_segments
WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
"#,
        )
        .bind(&now_text)
        .bind(&period_end_text)
        .bind(&period_start_text)
        .bind(&now_text)
        .bind(&period_end_text)
        .bind(&period_start_text)
        .bind(&period_end_text)
        .bind(&now_text)
        .bind(&period_start_text)
        .fetch_one(&self.pool)
        .await?;

        let active_seconds: i64 = sqlx::query_scalar(
            r#"
SELECT COALESCE(SUM(
    CASE
        WHEN strftime('%s', MIN(COALESCE(ended_at, ?), ?)) > strftime('%s', MAX(started_at, ?))
            THEN strftime('%s', MIN(COALESCE(ended_at, ?), ?)) - strftime('%s', MAX(started_at, ?))
        ELSE 0
    END
), 0)
FROM presence_segments
WHERE state = 'active' AND started_at < ? AND COALESCE(ended_at, ?) > ?
"#,
        )
        .bind(&now_text)
        .bind(&period_end_text)
        .bind(&period_start_text)
        .bind(&now_text)
        .bind(&period_end_text)
        .bind(&period_start_text)
        .bind(&period_end_text)
        .bind(&now_text)
        .bind(&period_start_text)
        .fetch_one(&self.pool)
        .await?;

        Ok(PeriodStat {
            focus_seconds,
            active_seconds,
        })
    }

    pub async fn read_recent_events(&self, limit: i64) -> Result<Vec<DebugEvent>> {
        let rows = sqlx::query(
            "SELECT id, kind, payload_json, observed_at FROM raw_events ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut events = Vec::new();
        for row in rows {
            events.push(DebugEvent {
                id: row.get("id"),
                kind: row.get("kind"),
                payload_json: row.get("payload_json"),
                observed_at: parse_time(row.get::<String, _>("observed_at").as_str())?,
            });
        }

        Ok(events)
    }

    async fn run_migrations(&self) -> Result<()> {
        sqlx::query(
            r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
"#,
        )
        .execute(&self.pool)
        .await?;

        for migration in MIGRATIONS {
            let existing = sqlx::query("SELECT version FROM schema_migrations WHERE version = ?")
                .bind(migration.version)
                .fetch_optional(&self.pool)
                .await?;

            if existing.is_some() {
                continue;
            }

            sqlx::query(migration.sql).execute(&self.pool).await?;
            sqlx::query(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            )
            .bind(migration.version)
            .bind(migration.name)
            .bind(format_time(OffsetDateTime::now_utc())?)
            .execute(&self.pool)
            .await?;
        }

        Ok(())
    }
}

/// Parses `started_at`/`ended_at` from a database row and clamps both timestamps
/// to the queried day boundaries. Open segments (NULL `ended_at`) use `now_utc`
/// as a stand-in so the frontend sees them extending to the current moment.
fn parse_segment_bounds(
    row: &sqlx::sqlite::SqliteRow,
    now_utc: OffsetDateTime,
    day_start: OffsetDateTime,
    day_end: OffsetDateTime,
) -> Result<(OffsetDateTime, OffsetDateTime)> {
    let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
    let ended_at = match row.get::<Option<String>, _>("ended_at") {
        Some(value) => parse_time(&value)?,
        None => now_utc,
    };

    Ok((
        clamp_start(started_at, day_start),
        clamp_end(ended_at, day_end, day_start),
    ))
}

/// Converts a local-time `Date` + `UtcOffset` into a pair of UTC timestamps
/// representing [midnight, next midnight) for that local day.
fn day_bounds(date: Date, timezone: UtcOffset) -> Result<(OffsetDateTime, OffsetDateTime)> {
    let start_local = PrimitiveDateTime::new(date, time::Time::MIDNIGHT).assume_offset(timezone);
    let end_local = start_local + Duration::days(1);
    Ok((
        start_local.to_offset(UtcOffset::UTC),
        end_local.to_offset(UtcOffset::UTC),
    ))
}

/// Clamps a segment's start time so it doesn't appear before the queried day boundary.
fn clamp_start(value: OffsetDateTime, min: OffsetDateTime) -> OffsetDateTime {
    if value < min { min } else { value }
}

/// Clamps a segment's end time to [min, max]. The `min` guard ensures that
/// segments starting before midnight don't produce negative durations after clamping.
fn clamp_end(value: OffsetDateTime, max: OffsetDateTime, min: OffsetDateTime) -> OffsetDateTime {
    let upper = if value > max { max } else { value };
    if upper < min { min } else { upper }
}

fn parse_time(value: &str) -> Result<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).with_context(|| format!("invalid timestamp: {}", value))
}

fn format_time(value: OffsetDateTime) -> Result<String> {
    Ok(value.format(&Rfc3339)?)
}

fn parse_presence_state(value: &str) -> Result<PresenceState> {
    match value {
        "active" => Ok(PresenceState::Active),
        "idle" => Ok(PresenceState::Idle),
        "locked" => Ok(PresenceState::Locked),
        other => Err(anyhow!("unknown presence state {}", other)),
    }
}

fn presence_label(value: &PresenceState) -> &'static str {
    match value {
        PresenceState::Active => "active",
        PresenceState::Idle => "idle",
        PresenceState::Locked => "locked",
    }
}

/// Computes the duration in seconds for a segment, returning 0 for open segments
/// or if timestamps are inverted (which can happen with clamping edge cases).
fn segment_seconds_focus(segment: &FocusSegment) -> i64 {
    segment
        .ended_at
        .map(|end| (end - segment.started_at).whole_seconds().max(0))
        .unwrap_or(0)
}

fn segment_seconds_browser(segment: &BrowserSegment) -> i64 {
    segment
        .ended_at
        .map(|end| (end - segment.started_at).whole_seconds().max(0))
        .unwrap_or(0)
}

fn segment_seconds_presence(segment: &PresenceSegment) -> i64 {
    segment
        .ended_at
        .map(|end| (end - segment.started_at).whole_seconds().max(0))
        .unwrap_or(0)
}

fn to_duration_stats(
    buckets: BTreeMap<String, (String, i64)>,
    total_seconds: i64,
) -> Vec<DurationStat> {
    let mut rows: Vec<_> = buckets
        .into_iter()
        .map(|(key, (label, seconds))| DurationStat {
            key,
            label,
            seconds,
            percentage: if total_seconds == 0 {
                0.0
            } else {
                (seconds as f64 / total_seconds as f64) * 100.0
            },
        })
        .collect();

    rows.sort_by(|left, right| right.seconds.cmp(&left.seconds));
    rows
}

/// Finds the entry with the longest total duration across segments, grouped by key.
fn top_entry<S, KeyFn, LabelFn, SecsFn>(
    segments: &[S],
    key_fn: KeyFn,
    label_fn: LabelFn,
    secs_fn: SecsFn,
) -> Option<KeyedDurationEntry>
where
    KeyFn: Fn(&S) -> String,
    LabelFn: Fn(&S) -> String,
    SecsFn: Fn(&S) -> i64,
{
    let mut buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();
    for segment in segments {
        let key = key_fn(segment);
        let label = label_fn(segment);
        let seconds = secs_fn(segment);
        let entry = buckets.entry(key).or_insert((label, 0));
        entry.1 += seconds;
    }

    buckets
        .into_iter()
        .max_by_key(|(_, (_, seconds))| *seconds)
        .map(|(key, (label, seconds))| KeyedDurationEntry {
            key,
            label,
            seconds,
        })
}

/// Returns the number of days in the given year/month.
fn days_in_month(year: i32, month: time::Month) -> u8 {
    let next_month = month.next();
    let (next_year, next_m) = if next_month == time::Month::January {
        (year + 1, next_month)
    } else {
        (year, next_month)
    };

    let first_of_next = Date::from_calendar_date(next_year, next_m, 1).unwrap();
    let first_of_this = Date::from_calendar_date(year, month, 1).unwrap();
    (first_of_next - first_of_this).whole_days() as u8
}

#[cfg(test)]
mod tests {
    use super::{AgentStore, AppConfig, parse_time};
    use common::PresenceState;
    use sqlx::Row;
    use std::path::PathBuf;
    use time::{Duration, OffsetDateTime};

    #[tokio::test]
    async fn restore_unclosed_segments_uses_last_seen_at_instead_of_restart_time() {
        let unique = format!(
            "timeline-test-{}.sqlite",
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let database_path = std::env::temp_dir().join(unique);
        let mut config = AppConfig::default();
        config.database_path = database_path.clone();
        config.lockfile_path = temp_lock_path(&database_path);

        let store = AgentStore::connect(&config).await.expect("connect store");
        let started_at =
            OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("valid timestamp");
        let last_seen_at = started_at + Duration::seconds(30);

        let id = store
            .start_presence_segment(PresenceState::Active, started_at)
            .await
            .expect("start presence");
        store
            .touch_presence_segment(id, last_seen_at)
            .await
            .expect("touch presence");

        store
            .restore_unclosed_segments()
            .await
            .expect("restore segments");

        let row = sqlx::query("SELECT ended_at FROM presence_segments WHERE id = ?")
            .bind(id)
            .fetch_one(&store.pool)
            .await
            .expect("load presence row");

        let ended_at = row.get::<String, _>("ended_at");
        assert_eq!(parse_time(&ended_at).expect("parse ended_at"), last_seen_at);

        let _ = std::fs::remove_file(database_path);
    }

    fn temp_lock_path(database_path: &std::path::Path) -> PathBuf {
        database_path.with_extension("lock")
    }
}
