//! SQLite initialization, migrations, writes, and read models for the timeline agent.

use crate::config::AppConfig;
use anyhow::{Context, Result, anyhow};
use common::{
    AppInfo, AppUsageTrendResponse, AppUsageTrendSeries, BrowserEventPayload, BrowserSegment,
    DaySummary, DebugEvent, DurationStat, FocusSegment, FocusStats, KeyedDurationEntry,
    MonthCalendarResponse, PeriodStat, PeriodSummaryResponse, PresenceSegment, PresenceState,
    TimelineDayResponse, TrendPeriod, UsageMetric, VisibleWindowSegment,
};
use serde::Serialize;
use sqlx::{Row, Sqlite, SqlitePool, Transaction, sqlite::SqliteConnectOptions};
use std::collections::BTreeMap;
use std::str::FromStr;
use time::format_description::well_known::Rfc3339;
use time::{Date, Duration, OffsetDateTime, PrimitiveDateTime, UtcOffset};

#[derive(Clone)]
pub struct AgentStore {
    pool: SqlitePool,
    timezone: UtcOffset,
}

#[derive(Debug, Clone)]
pub struct VisibleWindowSegmentInput {
    pub process_name: String,
    pub display_name: String,
    pub exe_path: Option<String>,
    pub window_title: Option<String>,
    pub hwnd: i64,
    pub process_id: u32,
    pub visible_area_ratio: f64,
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
    Migration {
        version: 5,
        name: "add_overlap_lookup_indexes",
        sql: r#"
CREATE INDEX IF NOT EXISTS idx_focus_segments_ended_started ON focus_segments(ended_at, started_at);
CREATE INDEX IF NOT EXISTS idx_browser_segments_ended_started ON browser_segments(ended_at, started_at);
CREATE INDEX IF NOT EXISTS idx_presence_segments_ended_started ON presence_segments(ended_at, started_at);
"#,
    },
    Migration {
        version: 6,
        name: "create_daily_rollups",
        sql: r#"
CREATE TABLE IF NOT EXISTS daily_app_usage (
  date TEXT NOT NULL,
  process_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, process_name)
);

CREATE TABLE IF NOT EXISTS daily_domain_usage (
  date TEXT NOT NULL,
  domain TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, domain)
);

CREATE TABLE IF NOT EXISTS daily_presence_usage (
  date TEXT NOT NULL,
  state TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, state)
);

CREATE TABLE IF NOT EXISTS rollup_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_app_usage_date_seconds ON daily_app_usage(date, seconds DESC);
CREATE INDEX IF NOT EXISTS idx_daily_domain_usage_date_seconds ON daily_domain_usage(date, seconds DESC);
CREATE INDEX IF NOT EXISTS idx_daily_presence_usage_date_state ON daily_presence_usage(date, state);
"#,
    },
    Migration {
        version: 7,
        name: "create_visible_window_rollups",
        sql: r#"
CREATE TABLE IF NOT EXISTS visible_window_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  exe_path TEXT,
  window_title TEXT,
  hwnd INTEGER NOT NULL,
  process_id INTEGER NOT NULL,
  visible_area_ratio REAL NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_visible_app_usage (
  date TEXT NOT NULL,
  process_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, process_name)
);

CREATE INDEX IF NOT EXISTS idx_visible_window_segments_ended_started ON visible_window_segments(ended_at, started_at);
CREATE INDEX IF NOT EXISTS idx_visible_window_segments_open ON visible_window_segments(id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visible_window_segments_hwnd_process ON visible_window_segments(hwnd, process_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_daily_visible_app_usage_date_seconds ON daily_visible_app_usage(date, seconds DESC);
"#,
    },
];

/// Keep recent raw events for local debugging while capping unbounded DB growth.
const RAW_EVENTS_MAX_ROWS: i64 = 50_000;
const DAILY_ROLLUP_VERSION: &str = "2";

impl AgentStore {
    pub async fn connect(config: &AppConfig, timezone: UtcOffset) -> Result<Self> {
        config.ensure_parent_dirs()?;

        let connect_options = SqliteConnectOptions::from_str(
            config
                .database_path
                .to_str()
                .ok_or_else(|| anyhow!("database path is not valid UTF-8"))?,
        )?
        .create_if_missing(true)
        .pragma("journal_mode", "WAL")
        .pragma("synchronous", "NORMAL")
        .pragma("busy_timeout", "5000");

        let pool = SqlitePool::connect_with(connect_options)
            .await
            .context("failed to connect sqlite")?;

        let store = Self { pool, timezone };
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

        let focus_rows = sqlx::query(
            r#"
SELECT process_name, display_name, started_at, COALESCE(last_seen_at, started_at) AS restored_ended_at
FROM focus_segments
WHERE ended_at IS NULL
"#,
        )
        .fetch_all(&mut *tx)
        .await?;
        let browser_rows = sqlx::query(
            r#"
SELECT domain, started_at, COALESCE(last_seen_at, started_at) AS restored_ended_at
FROM browser_segments
WHERE ended_at IS NULL
"#,
        )
        .fetch_all(&mut *tx)
        .await?;
        let presence_rows = sqlx::query(
            r#"
SELECT state, started_at, COALESCE(last_seen_at, started_at) AS restored_ended_at
FROM presence_segments
WHERE ended_at IS NULL
"#,
        )
        .fetch_all(&mut *tx)
        .await?;
        let visible_rows = sqlx::query(
            r#"
SELECT process_name, display_name, started_at, COALESCE(last_seen_at, started_at) AS restored_ended_at
FROM visible_window_segments
WHERE ended_at IS NULL
"#,
        )
        .fetch_all(&mut *tx)
        .await?;

        for row in focus_rows {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let restored_ended_at = parse_time(row.get::<String, _>("restored_ended_at").as_str())?;
            self.add_app_segment_counts_tx(
                &mut tx,
                &process_name,
                &display_name,
                started_at,
                restored_ended_at,
            )
            .await?;
        }

        for row in browser_rows {
            let domain = row.get::<String, _>("domain");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let restored_ended_at = parse_time(row.get::<String, _>("restored_ended_at").as_str())?;
            self.add_domain_segment_counts_tx(&mut tx, &domain, started_at, restored_ended_at)
                .await?;
        }

        for row in presence_rows {
            let state = row.get::<String, _>("state");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let restored_ended_at = parse_time(row.get::<String, _>("restored_ended_at").as_str())?;
            self.add_presence_segment_counts_tx(&mut tx, &state, started_at, restored_ended_at)
                .await?;
        }

        for row in visible_rows {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let restored_ended_at = parse_time(row.get::<String, _>("restored_ended_at").as_str())?;
            self.add_visible_app_segment_counts_tx(
                &mut tx,
                &process_name,
                &display_name,
                started_at,
                restored_ended_at,
            )
            .await?;
        }

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
        sqlx::query(
            "UPDATE visible_window_segments SET ended_at = COALESCE(last_seen_at, started_at) WHERE ended_at IS NULL",
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT process_name, display_name, started_at, last_seen_at FROM focus_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE focus_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
        )
            .bind(&observed_at)
            .bind(&observed_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;

        if let Some(row) = row {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = parse_time(&observed_at)?;
            self.add_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                ended_at,
            )
            .await?;
            self.add_app_segment_counts_tx(
                &mut tx,
                &process_name,
                &display_name,
                started_at,
                ended_at,
            )
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn touch_focus_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT process_name, display_name, started_at, last_seen_at FROM focus_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query("UPDATE focus_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL")
            .bind(&observed_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;

        if let Some(row) = row {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = parse_time(&observed_at)?;
            self.add_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                touched_at,
            )
            .await?;
        }

        tx.commit().await?;
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT state, started_at, last_seen_at FROM presence_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE presence_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
        )
            .bind(&observed_at)
            .bind(&observed_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;

        if let Some(row) = row {
            let state = row.get::<String, _>("state");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = parse_time(&observed_at)?;
            self.add_presence_usage_seconds_tx(&mut tx, &state, previous_seen_at, ended_at)
                .await?;
            self.add_presence_segment_counts_tx(&mut tx, &state, started_at, ended_at)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn touch_presence_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT state, started_at, last_seen_at FROM presence_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE presence_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
        )
        .bind(&observed_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if let Some(row) = row {
            let state = row.get::<String, _>("state");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = parse_time(&observed_at)?;
            self.add_presence_usage_seconds_tx(&mut tx, &state, previous_seen_at, touched_at)
                .await?;
        }

        tx.commit().await?;
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT domain, started_at, last_seen_at FROM browser_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE browser_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
        )
            .bind(&observed_at)
            .bind(&observed_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;

        if let Some(row) = row {
            let domain = row.get::<String, _>("domain");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = parse_time(&observed_at)?;
            self.add_domain_usage_seconds_tx(&mut tx, &domain, previous_seen_at, ended_at)
                .await?;
            self.add_domain_segment_counts_tx(&mut tx, &domain, started_at, ended_at)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn touch_browser_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT domain, started_at, last_seen_at FROM browser_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE browser_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
        )
        .bind(&observed_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if let Some(row) = row {
            let domain = row.get::<String, _>("domain");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = parse_time(&observed_at)?;
            self.add_domain_usage_seconds_tx(&mut tx, &domain, previous_seen_at, touched_at)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn start_visible_window_segment(
        &self,
        window: &VisibleWindowSegmentInput,
        observed_at: OffsetDateTime,
    ) -> Result<i64> {
        let observed_at = format_time(observed_at)?;
        let result = sqlx::query(
            r#"
INSERT INTO visible_window_segments (
  process_name,
  display_name,
  exe_path,
  window_title,
  hwnd,
  process_id,
  visible_area_ratio,
  started_at,
  last_seen_at,
  created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"#,
        )
        .bind(&window.process_name)
        .bind(&window.display_name)
        .bind(&window.exe_path)
        .bind(&window.window_title)
        .bind(window.hwnd)
        .bind(i64::from(window.process_id))
        .bind(window.visible_area_ratio)
        .bind(&observed_at)
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn touch_visible_window_segment(
        &self,
        id: i64,
        observed_at: OffsetDateTime,
        visible_area_ratio: f64,
    ) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT process_name, display_name, started_at, last_seen_at FROM visible_window_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE visible_window_segments SET last_seen_at = ?, visible_area_ratio = ? WHERE id = ? AND ended_at IS NULL",
        )
        .bind(&observed_at)
        .bind(visible_area_ratio)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if let Some(row) = row {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = parse_time(&observed_at)?;
            self.add_visible_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                touched_at,
            )
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn end_visible_window_segment(
        &self,
        id: i64,
        observed_at: OffsetDateTime,
    ) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT process_name, display_name, started_at, last_seen_at FROM visible_window_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE visible_window_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
        )
        .bind(&observed_at)
        .bind(&observed_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if let Some(row) = row {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = parse_time(&observed_at)?;
            self.add_visible_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                ended_at,
            )
            .await?;
            self.add_visible_app_segment_counts_tx(
                &mut tx,
                &process_name,
                &display_name,
                started_at,
                ended_at,
            )
            .await?;
        }

        tx.commit().await?;
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

    pub async fn ensure_daily_rollups(&self) -> Result<()> {
        let existing = sqlx::query_scalar::<_, String>(
            "SELECT value FROM rollup_metadata WHERE key = 'daily_rollup_version'",
        )
        .fetch_optional(&self.pool)
        .await?;

        if existing.as_deref() == Some(DAILY_ROLLUP_VERSION) {
            return Ok(());
        }

        self.rebuild_daily_rollups().await
    }

    /// Deletes closed segments older than `retention_days` from all four
    /// segment tables. Open segments (NULL `ended_at`) are never deleted.
    /// Daily rollup tables (`daily_*`) are NOT touched — aggregated stats
    /// and calendar data are preserved indefinitely so long-term trends
    /// remain visible even after raw segments are pruned.
    pub async fn prune_old_segments(&self, retention_days: u64) -> Result<u64> {
        if retention_days == 0 {
            return Ok(0);
        }

        let cutoff = OffsetDateTime::now_utc() - Duration::days(retention_days as i64);
        let cutoff_text = format_time(cutoff)?;
        let mut total_deleted: u64 = 0;

        for table in [
            "focus_segments",
            "browser_segments",
            "presence_segments",
            "visible_window_segments",
        ] {
            let sql = format!("DELETE FROM {table} WHERE ended_at IS NOT NULL AND ended_at < ?");
            let result = sqlx::query(&sql)
                .bind(&cutoff_text)
                .execute(&self.pool)
                .await?;
            total_deleted += result.rows_affected();
        }

        // Also prune raw_events beyond their cap, in case the rolling cleanup
        // fell behind (e.g. a long period without restarts).
        let raw_pruned = self.cap_raw_events().await?;
        total_deleted += raw_pruned;

        if total_deleted > 0 {
            tracing::info!(
                retention_days,
                cutoff = %cutoff_text,
                total_deleted,
                "pruned old segments"
            );
        }

        Ok(total_deleted)
    }

    /// Trims `raw_events` to the most recent `RAW_EVENTS_MAX_ROWS` rows.
    /// Returns the number of rows deleted.
    async fn cap_raw_events(&self) -> Result<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM raw_events
            WHERE id NOT IN (
                SELECT id FROM raw_events ORDER BY id DESC LIMIT ?
            )
            "#,
        )
        .bind(RAW_EVENTS_MAX_ROWS)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Runs `PRAGMA wal_checkpoint(TRUNCATE)` to fold the WAL back into the
    /// main database file and shrink the WAL file. Call after large pruning
    /// operations or periodically to keep the WAL from growing unbounded.
    pub async fn wal_checkpoint(&self) -> Result<()> {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn rebuild_daily_rollups(&self) -> Result<()> {
        let mut app_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();
        let mut visible_app_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();
        let mut domain_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();
        let mut presence_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();

        // Fetch all four segment tables in parallel. Each table is independent
        // and SQLite WAL mode allows concurrent reads without blocking.
        let (focus_rows, visible_rows, browser_rows, presence_rows) = tokio::try_join!(
            sqlx::query(
                r#"
SELECT process_name, display_name, started_at, ended_at, last_seen_at
FROM focus_segments
"#,
            )
            .fetch_all(&self.pool),
            sqlx::query(
                r#"
SELECT process_name, display_name, started_at, ended_at, last_seen_at
FROM visible_window_segments
"#,
            )
            .fetch_all(&self.pool),
            sqlx::query(
                r#"
SELECT domain, started_at, ended_at, last_seen_at
FROM browser_segments
"#,
            )
            .fetch_all(&self.pool),
            sqlx::query(
                r#"
SELECT state, started_at, ended_at, last_seen_at
FROM presence_segments
"#,
            )
            .fetch_all(&self.pool),
        )?;

        for row in focus_rows {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = parse_optional_time(row.get::<Option<String>, _>("ended_at"))?
                .or(parse_optional_time(
                    row.get::<Option<String>, _>("last_seen_at"),
                )?)
                .unwrap_or(started_at);
            add_rollup_chunks(
                &mut app_buckets,
                &process_name,
                &display_name,
                started_at,
                ended_at,
                self.timezone,
                true,
            )?;
        }

        for row in visible_rows {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = parse_optional_time(row.get::<Option<String>, _>("ended_at"))?
                .or(parse_optional_time(
                    row.get::<Option<String>, _>("last_seen_at"),
                )?)
                .unwrap_or(started_at);
            add_rollup_chunks(
                &mut visible_app_buckets,
                &process_name,
                &display_name,
                started_at,
                ended_at,
                self.timezone,
                true,
            )?;
        }

        for row in browser_rows {
            let domain = row.get::<String, _>("domain");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = parse_optional_time(row.get::<Option<String>, _>("ended_at"))?
                .or(parse_optional_time(
                    row.get::<Option<String>, _>("last_seen_at"),
                )?)
                .unwrap_or(started_at);
            add_rollup_chunks(
                &mut domain_buckets,
                &domain,
                &domain,
                started_at,
                ended_at,
                self.timezone,
                true,
            )?;
        }

        for row in presence_rows {
            let state = row.get::<String, _>("state");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = parse_optional_time(row.get::<Option<String>, _>("ended_at"))?
                .or(parse_optional_time(
                    row.get::<Option<String>, _>("last_seen_at"),
                )?)
                .unwrap_or(started_at);
            add_rollup_chunks(
                &mut presence_buckets,
                &state,
                &state,
                started_at,
                ended_at,
                self.timezone,
                true,
            )?;
        }

        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM daily_app_usage")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM daily_domain_usage")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM daily_presence_usage")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM daily_visible_app_usage")
            .execute(&mut *tx)
            .await?;

        for ((date, key), bucket) in app_buckets {
            upsert_daily_app_usage_tx(
                &mut tx,
                &date,
                &key,
                &bucket.label,
                bucket.seconds,
                bucket.segment_count,
            )
            .await?;
        }

        for ((date, key), bucket) in visible_app_buckets {
            upsert_daily_visible_app_usage_tx(
                &mut tx,
                &date,
                &key,
                &bucket.label,
                bucket.seconds,
                bucket.segment_count,
            )
            .await?;
        }

        for ((date, key), bucket) in domain_buckets {
            upsert_daily_domain_usage_tx(
                &mut tx,
                &date,
                &key,
                bucket.seconds,
                bucket.segment_count,
            )
            .await?;
        }

        for ((date, key), bucket) in presence_buckets {
            upsert_daily_presence_usage_tx(
                &mut tx,
                &date,
                &key,
                bucket.seconds,
                bucket.segment_count,
            )
            .await?;
        }

        let updated_at = format_time(OffsetDateTime::now_utc())?;
        sqlx::query(
            r#"
INSERT INTO rollup_metadata (key, value, updated_at)
VALUES ('daily_rollup_version', ?, ?)
ON CONFLICT(key) DO UPDATE
SET value = excluded.value,
    updated_at = excluded.updated_at
"#,
        )
        .bind(DAILY_ROLLUP_VERSION)
        .bind(updated_at)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    async fn add_app_usage_seconds_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        process_name: &str,
        display_name: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_app_usage_tx(
                tx,
                &chunk.date,
                process_name,
                display_name,
                chunk.seconds,
                0,
            )
            .await?;
        }
        Ok(())
    }

    async fn add_app_segment_counts_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        process_name: &str,
        display_name: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_app_usage_tx(tx, &chunk.date, process_name, display_name, 0, 1).await?;
        }
        Ok(())
    }

    async fn add_domain_usage_seconds_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        domain: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_domain_usage_tx(tx, &chunk.date, domain, chunk.seconds, 0).await?;
        }
        Ok(())
    }

    async fn add_domain_segment_counts_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        domain: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_domain_usage_tx(tx, &chunk.date, domain, 0, 1).await?;
        }
        Ok(())
    }

    async fn add_presence_usage_seconds_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        state: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_presence_usage_tx(tx, &chunk.date, state, chunk.seconds, 0).await?;
        }
        Ok(())
    }

    async fn add_presence_segment_counts_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        state: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_presence_usage_tx(tx, &chunk.date, state, 0, 1).await?;
        }
        Ok(())
    }

    async fn add_visible_app_usage_seconds_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        process_name: &str,
        display_name: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_visible_app_usage_tx(
                tx,
                &chunk.date,
                process_name,
                display_name,
                chunk.seconds,
                0,
            )
            .await?;
        }
        Ok(())
    }

    async fn add_visible_app_segment_counts_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        process_name: &str,
        display_name: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<()> {
        for chunk in split_interval_by_local_day(start, end, self.timezone)? {
            upsert_daily_visible_app_usage_tx(tx, &chunk.date, process_name, display_name, 0, 1)
                .await?;
        }
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

        // Run all four segment queries in parallel. Each query hits a
        // different table with its own index, so they don't contend on the
        // same pages. With SQLite WAL mode, concurrent reads are safe and
        // don't block each other. This cuts the endpoint latency from
        // ~4×round-trip to ~1×round-trip.
        let (focus_rows, browser_rows, presence_rows, visible_rows) = tokio::try_join!(
            sqlx::query(
                r#"
SELECT *
FROM (
    SELECT id, process_name, display_name, exe_path, window_title, is_browser, started_at, ended_at
    FROM focus_segments INDEXED BY idx_focus_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, process_name, display_name, exe_path, window_title, is_browser, started_at, ended_at
    FROM focus_segments
    WHERE ended_at IS NULL AND started_at < ? AND ? > ?
)
ORDER BY started_at ASC
"#,
            )
            .bind(&day_start_text)
            .bind(&day_end_text)
            .bind(&day_end_text)
            .bind(&now_text)
            .bind(&day_start_text)
            .fetch_all(&self.pool),
            sqlx::query(
                r#"
SELECT *
FROM (
    SELECT id, domain, page_title, browser_window_id, tab_id, started_at, ended_at
    FROM browser_segments INDEXED BY idx_browser_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, domain, page_title, browser_window_id, tab_id, started_at, ended_at
    FROM browser_segments
    WHERE ended_at IS NULL AND started_at < ? AND ? > ?
)
ORDER BY started_at ASC
"#,
            )
            .bind(&day_start_text)
            .bind(&day_end_text)
            .bind(&day_end_text)
            .bind(&now_text)
            .bind(&day_start_text)
            .fetch_all(&self.pool),
            sqlx::query(
                r#"
SELECT *
FROM (
    SELECT id, state, started_at, ended_at
    FROM presence_segments INDEXED BY idx_presence_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, state, started_at, ended_at
    FROM presence_segments
    WHERE ended_at IS NULL AND started_at < ? AND ? > ?
)
ORDER BY started_at ASC
"#,
            )
            .bind(&day_start_text)
            .bind(&day_end_text)
            .bind(&day_end_text)
            .bind(&now_text)
            .bind(&day_start_text)
            .fetch_all(&self.pool),
            sqlx::query(
                r#"
SELECT *
FROM (
    SELECT id, process_name, display_name, exe_path, window_title, hwnd, process_id, visible_area_ratio, started_at, ended_at
    FROM visible_window_segments INDEXED BY idx_visible_window_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, process_name, display_name, exe_path, window_title, hwnd, process_id, visible_area_ratio, started_at, ended_at
    FROM visible_window_segments
    WHERE ended_at IS NULL AND started_at < ? AND ? > ?
)
ORDER BY started_at ASC
"#,
            )
            .bind(&day_start_text)
            .bind(&day_end_text)
            .bind(&day_end_text)
            .bind(&now_text)
            .bind(&day_start_text)
            .fetch_all(&self.pool),
        )?;

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

        let mut visible_window_segments = Vec::new();
        for row in visible_rows {
            let (started_at, ended_at) =
                parse_segment_bounds(&row, now_utc, day_start_utc, day_end_utc)?;
            let process_name = row.get::<String, _>("process_name");

            visible_window_segments.push(VisibleWindowSegment {
                id: row.get("id"),
                started_at,
                ended_at: Some(ended_at),
                app: AppInfo {
                    is_browser: is_browser_process(&process_name),
                    process_name,
                    display_name: row.get("display_name"),
                    exe_path: row.get("exe_path"),
                    window_title: row.get("window_title"),
                },
                hwnd: row.get("hwnd"),
                process_id: row.get("process_id"),
                visible_area_ratio: row.get("visible_area_ratio"),
            });
        }

        Ok(TimelineDayResponse {
            date: date.to_string(),
            timezone: timezone.to_string(),
            focus_segments,
            browser_segments,
            presence_segments,
            visible_window_segments,
        })
    }

    pub async fn read_app_stats(
        &self,
        date: Date,
        _timezone: UtcOffset,
        metric: UsageMetric,
    ) -> Result<Vec<DurationStat>> {
        let table = app_usage_table(metric);
        let mut buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();
        let sql = format!(
            r#"
SELECT process_name, display_name, seconds
FROM {table}
WHERE date = ?
ORDER BY seconds DESC
"#,
        );
        let rows = sqlx::query(&sql)
            .bind(date.to_string())
            .fetch_all(&self.pool)
            .await?;
        let mut total_seconds = 0;
        for row in rows {
            let seconds = row.get::<i64, _>("seconds");
            total_seconds += seconds;
            buckets.insert(
                row.get::<String, _>("process_name"),
                (row.get::<String, _>("display_name"), seconds),
            );
        }

        Ok(to_duration_stats(buckets, total_seconds))
    }

    pub async fn read_domain_stats(
        &self,
        date: Date,
        _timezone: UtcOffset,
    ) -> Result<Vec<DurationStat>> {
        let mut buckets: BTreeMap<String, (String, i64)> = BTreeMap::new();
        let rows = sqlx::query(
            r#"
SELECT domain, seconds
FROM daily_domain_usage
WHERE date = ?
ORDER BY seconds DESC
"#,
        )
        .bind(date.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut total_seconds = 0;
        for row in rows {
            let domain = row.get::<String, _>("domain");
            let seconds = row.get::<i64, _>("seconds");
            total_seconds += seconds;
            buckets.insert(domain.clone(), (domain, seconds));
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
    pub async fn read_day_summary(&self, date: Date, _timezone: UtcOffset) -> Result<DaySummary> {
        let date_text = date.to_string();
        let app_rows = sqlx::query(
            r#"
SELECT process_name, display_name, seconds, segment_count
FROM daily_app_usage
WHERE date = ?
"#,
        )
        .bind(&date_text)
        .fetch_all(&self.pool)
        .await?;
        let domain_rows = sqlx::query(
            r#"
SELECT domain, seconds
FROM daily_domain_usage
WHERE date = ?
"#,
        )
        .bind(&date_text)
        .fetch_all(&self.pool)
        .await?;
        let active_seconds = sqlx::query_scalar::<_, i64>(
            r#"
SELECT COALESCE(SUM(seconds), 0)
FROM daily_presence_usage
WHERE date = ? AND state = 'active'
"#,
        )
        .bind(&date_text)
        .fetch_one(&self.pool)
        .await?;

        let mut focus_seconds = 0;
        let mut focus_count = 0;
        let mut top_app = None;
        for row in app_rows {
            let seconds = row.get::<i64, _>("seconds");
            focus_seconds += seconds;
            focus_count += row.get::<i64, _>("segment_count");
            if top_app
                .as_ref()
                .map(|entry: &KeyedDurationEntry| seconds > entry.seconds)
                .unwrap_or(true)
            {
                top_app = Some(KeyedDurationEntry {
                    key: row.get("process_name"),
                    label: row.get("display_name"),
                    seconds,
                });
            }
        }

        let mut browser_seconds = 0;
        let mut top_domain = None;
        for row in domain_rows {
            let seconds = row.get::<i64, _>("seconds");
            browser_seconds += seconds;
            if top_domain
                .as_ref()
                .map(|entry: &KeyedDurationEntry| seconds > entry.seconds)
                .unwrap_or(true)
            {
                let domain = row.get::<String, _>("domain");
                top_domain = Some(KeyedDurationEntry {
                    key: domain.clone(),
                    label: domain,
                    seconds,
                });
            }
        }

        Ok(DaySummary {
            date: date.to_string(),
            focus_seconds,
            active_seconds,
            browser_seconds,
            switch_count: focus_count.saturating_sub(1),
            top_app,
            top_domain,
        })
    }

    /// Returns daily summaries for every day in the given month.
    /// Reads pre-aggregated daily rollups in 3 range queries instead of scanning
    /// raw segments or issuing one query set per day.
    pub async fn read_month_calendar(
        &self,
        year: i32,
        month: time::Month,
        timezone: UtcOffset,
    ) -> Result<MonthCalendarResponse> {
        let first_day =
            Date::from_calendar_date(year, month, 1).map_err(|e| anyhow!("invalid month: {e}"))?;
        let days_in_month = days_in_month(year, month) as i64;
        let last_day = first_day + Duration::days(days_in_month - 1);
        let start_text = first_day.to_string();
        let end_text = last_day.to_string();

        let mut summaries = BTreeMap::new();
        for day_offset in 0..days_in_month {
            let date = first_day + Duration::days(day_offset);
            summaries.insert(
                date.to_string(),
                DaySummary {
                    date: date.to_string(),
                    focus_seconds: 0,
                    active_seconds: 0,
                    browser_seconds: 0,
                    switch_count: 0,
                    top_app: None,
                    top_domain: None,
                },
            );
        }

        let app_rows = sqlx::query(
            r#"
SELECT date, process_name, display_name, seconds, segment_count
FROM daily_app_usage
WHERE date >= ? AND date <= ?
"#,
        )
        .bind(&start_text)
        .bind(&end_text)
        .fetch_all(&self.pool)
        .await?;
        for row in app_rows {
            let date = row.get::<String, _>("date");
            let Some(summary) = summaries.get_mut(&date) else {
                continue;
            };
            let seconds = row.get::<i64, _>("seconds");
            summary.focus_seconds += seconds;
            summary.switch_count += row.get::<i64, _>("segment_count");
            if summary
                .top_app
                .as_ref()
                .map(|entry| seconds > entry.seconds)
                .unwrap_or(true)
            {
                summary.top_app = Some(KeyedDurationEntry {
                    key: row.get("process_name"),
                    label: row.get("display_name"),
                    seconds,
                });
            }
        }

        let domain_rows = sqlx::query(
            r#"
SELECT date, domain, seconds
FROM daily_domain_usage
WHERE date >= ? AND date <= ?
"#,
        )
        .bind(&start_text)
        .bind(&end_text)
        .fetch_all(&self.pool)
        .await?;
        for row in domain_rows {
            let date = row.get::<String, _>("date");
            let Some(summary) = summaries.get_mut(&date) else {
                continue;
            };
            let seconds = row.get::<i64, _>("seconds");
            summary.browser_seconds += seconds;
            if summary
                .top_domain
                .as_ref()
                .map(|entry| seconds > entry.seconds)
                .unwrap_or(true)
            {
                let domain = row.get::<String, _>("domain");
                summary.top_domain = Some(KeyedDurationEntry {
                    key: domain.clone(),
                    label: domain,
                    seconds,
                });
            }
        }

        let active_rows = sqlx::query(
            r#"
SELECT date, seconds
FROM daily_presence_usage
WHERE state = 'active' AND date >= ? AND date <= ?
"#,
        )
        .bind(&start_text)
        .bind(&end_text)
        .fetch_all(&self.pool)
        .await?;
        for row in active_rows {
            let date = row.get::<String, _>("date");
            let Some(summary) = summaries.get_mut(&date) else {
                continue;
            };
            summary.active_seconds += row.get::<i64, _>("seconds");
        }

        let days = summaries
            .into_values()
            .map(|mut summary| {
                summary.switch_count = summary.switch_count.saturating_sub(1);
                summary
            })
            .collect();

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
        _timezone: UtcOffset,
    ) -> Result<PeriodStat> {
        let focus_seconds: i64 = sqlx::query_scalar(
            r#"
SELECT COALESCE(SUM(seconds), 0)
FROM daily_app_usage
WHERE date >= ? AND date <= ?
"#,
        )
        .bind(start.to_string())
        .bind(end.to_string())
        .fetch_one(&self.pool)
        .await?;

        let active_seconds: i64 = sqlx::query_scalar(
            r#"
SELECT COALESCE(SUM(seconds), 0)
FROM daily_presence_usage
WHERE state = 'active' AND date >= ? AND date <= ?
"#,
        )
        .bind(start.to_string())
        .bind(end.to_string())
        .fetch_one(&self.pool)
        .await?;

        Ok(PeriodStat {
            focus_seconds,
            active_seconds,
        })
    }

    pub async fn read_app_usage_trend(
        &self,
        anchor_date: Date,
        period: TrendPeriod,
        limit: usize,
        metric: UsageMetric,
    ) -> Result<AppUsageTrendResponse> {
        let (start_date, end_date) = trend_bounds(anchor_date, period)?;
        let days = date_range(start_date, end_date)?;
        let day_index = days
            .iter()
            .enumerate()
            .map(|(index, date)| (date.to_string(), index))
            .collect::<BTreeMap<_, _>>();
        let table = app_usage_table(metric);
        let sql = format!(
            r#"
SELECT date, process_name, display_name, seconds
FROM {table}
WHERE date >= ? AND date <= ? AND seconds > 0
ORDER BY date ASC
"#,
        );
        let rows = sqlx::query(&sql)
            .bind(start_date.to_string())
            .bind(end_date.to_string())
            .fetch_all(&self.pool)
            .await?;

        let mut totals: BTreeMap<String, (String, i64)> = BTreeMap::new();
        let mut values: BTreeMap<(String, String), i64> = BTreeMap::new();
        for row in rows {
            let date = row.get::<String, _>("date");
            let key = row.get::<String, _>("process_name");
            let label = row.get::<String, _>("display_name");
            let seconds = row.get::<i64, _>("seconds");
            totals
                .entry(key.clone())
                .and_modify(|entry| {
                    entry.0 = label.clone();
                    entry.1 += seconds;
                })
                .or_insert((label, seconds));
            values.insert((key, date), seconds);
        }

        let normalized_limit = limit.clamp(1, 12);
        let series = totals
            .into_iter()
            .map(|(key, (label, total_seconds))| (key, label, total_seconds))
            .collect::<Vec<_>>();
        let mut series = series;
        series.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));

        let series = series
            .into_iter()
            .take(normalized_limit)
            .map(|(key, label, total_seconds)| {
                let mut daily_seconds = vec![0; days.len()];
                for ((candidate_key, date), seconds) in &values {
                    if candidate_key == &key
                        && let Some(index) = day_index.get(date)
                    {
                        daily_seconds[*index] = *seconds;
                    }
                }

                AppUsageTrendSeries {
                    key,
                    label,
                    total_seconds,
                    daily_seconds,
                }
            })
            .collect();

        Ok(AppUsageTrendResponse {
            period,
            metric,
            start_date: start_date.to_string(),
            end_date: end_date.to_string(),
            timezone: self.timezone.to_string(),
            days: days.into_iter().map(|date| date.to_string()).collect(),
            series,
        })
    }

    /// Like `read_app_usage_trend` but for browser domains. Reads from
    /// `daily_domain_usage` and returns the same `AppUsageTrendResponse`
    /// shape (the `metric` field is set to `VisibleWindow` as a placeholder
    /// since the enum doesn't have a domain variant — the frontend ignores
    /// `metric` for domain trends).
    pub async fn read_domain_usage_trend(
        &self,
        anchor_date: Date,
        period: TrendPeriod,
        limit: usize,
    ) -> Result<AppUsageTrendResponse> {
        let (start_date, end_date) = trend_bounds(anchor_date, period)?;
        let days = date_range(start_date, end_date)?;
        let day_index = days
            .iter()
            .enumerate()
            .map(|(index, date)| (date.to_string(), index))
            .collect::<BTreeMap<_, _>>();

        let rows = sqlx::query(
            r#"
SELECT date, domain, seconds
FROM daily_domain_usage
WHERE date >= ? AND date <= ? AND seconds > 0
ORDER BY date ASC
"#,
        )
        .bind(start_date.to_string())
        .bind(end_date.to_string())
        .fetch_all(&self.pool)
        .await?;

        let mut totals: BTreeMap<String, (String, i64)> = BTreeMap::new();
        let mut values: BTreeMap<(String, String), i64> = BTreeMap::new();
        for row in rows {
            let date = row.get::<String, _>("date");
            let domain = row.get::<String, _>("domain");
            let seconds = row.get::<i64, _>("seconds");
            totals
                .entry(domain.clone())
                .and_modify(|entry| {
                    entry.1 += seconds;
                })
                .or_insert((domain.clone(), seconds));
            values.insert((domain, date), seconds);
        }

        let normalized_limit = limit.clamp(1, 12);
        let mut series: Vec<(String, String, i64)> = totals
            .into_iter()
            .map(|(key, (label, total_seconds))| (key, label, total_seconds))
            .collect();
        series.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));

        let series = series
            .into_iter()
            .take(normalized_limit)
            .map(|(key, label, total_seconds)| {
                let mut daily_seconds = vec![0; days.len()];
                for ((candidate_key, date), seconds) in &values {
                    if candidate_key == &key
                        && let Some(index) = day_index.get(date)
                    {
                        daily_seconds[*index] = *seconds;
                    }
                }

                AppUsageTrendSeries {
                    key,
                    label,
                    total_seconds,
                    daily_seconds,
                }
            })
            .collect();

        Ok(AppUsageTrendResponse {
            period,
            metric: UsageMetric::VisibleWindow,
            start_date: start_date.to_string(),
            end_date: end_date.to_string(),
            timezone: self.timezone.to_string(),
            days: days.into_iter().map(|date| date.to_string()).collect(),
            series,
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

fn parse_optional_time(value: Option<String>) -> Result<Option<OffsetDateTime>> {
    value.map(|value| parse_time(&value)).transpose()
}

struct DailyChunk {
    date: String,
    seconds: i64,
}

struct RollupBucket {
    label: String,
    seconds: i64,
    segment_count: i64,
}

fn split_interval_by_local_day(
    start: OffsetDateTime,
    end: OffsetDateTime,
    timezone: UtcOffset,
) -> Result<Vec<DailyChunk>> {
    if end <= start {
        return Ok(Vec::new());
    }

    let mut cursor = start.to_offset(timezone);
    let end_local = end.to_offset(timezone);
    let mut chunks = Vec::new();

    while cursor < end_local {
        let date = cursor.date();
        let next_midnight = PrimitiveDateTime::new(date + Duration::days(1), time::Time::MIDNIGHT)
            .assume_offset(timezone);
        let chunk_end = if next_midnight < end_local {
            next_midnight
        } else {
            end_local
        };
        let seconds = (chunk_end.to_offset(UtcOffset::UTC) - cursor.to_offset(UtcOffset::UTC))
            .whole_seconds()
            .max(0);

        if seconds > 0 {
            chunks.push(DailyChunk {
                date: date.to_string(),
                seconds,
            });
        }

        cursor = chunk_end;
    }

    Ok(chunks)
}

fn add_rollup_chunks(
    buckets: &mut BTreeMap<(String, String), RollupBucket>,
    key: &str,
    label: &str,
    start: OffsetDateTime,
    end: OffsetDateTime,
    timezone: UtcOffset,
    count_segment: bool,
) -> Result<()> {
    for chunk in split_interval_by_local_day(start, end, timezone)? {
        let entry = buckets
            .entry((chunk.date, key.to_string()))
            .or_insert_with(|| RollupBucket {
                label: label.to_string(),
                seconds: 0,
                segment_count: 0,
            });
        entry.label = label.to_string();
        entry.seconds += chunk.seconds;
        if count_segment {
            entry.segment_count += 1;
        }
    }

    Ok(())
}

async fn upsert_daily_app_usage_tx(
    tx: &mut Transaction<'_, Sqlite>,
    date: &str,
    process_name: &str,
    display_name: &str,
    seconds: i64,
    segment_count: i64,
) -> Result<()> {
    if seconds <= 0 && segment_count <= 0 {
        return Ok(());
    }

    let updated_at = format_time(OffsetDateTime::now_utc())?;
    sqlx::query(
        r#"
INSERT INTO daily_app_usage (date, process_name, display_name, seconds, segment_count, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(date, process_name) DO UPDATE
SET display_name = excluded.display_name,
    seconds = daily_app_usage.seconds + excluded.seconds,
    segment_count = daily_app_usage.segment_count + excluded.segment_count,
    updated_at = excluded.updated_at
"#,
    )
    .bind(date)
    .bind(process_name)
    .bind(display_name)
    .bind(seconds)
    .bind(segment_count)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn upsert_daily_domain_usage_tx(
    tx: &mut Transaction<'_, Sqlite>,
    date: &str,
    domain: &str,
    seconds: i64,
    segment_count: i64,
) -> Result<()> {
    if seconds <= 0 && segment_count <= 0 {
        return Ok(());
    }

    let updated_at = format_time(OffsetDateTime::now_utc())?;
    sqlx::query(
        r#"
INSERT INTO daily_domain_usage (date, domain, seconds, segment_count, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(date, domain) DO UPDATE
SET seconds = daily_domain_usage.seconds + excluded.seconds,
    segment_count = daily_domain_usage.segment_count + excluded.segment_count,
    updated_at = excluded.updated_at
"#,
    )
    .bind(date)
    .bind(domain)
    .bind(seconds)
    .bind(segment_count)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn upsert_daily_presence_usage_tx(
    tx: &mut Transaction<'_, Sqlite>,
    date: &str,
    state: &str,
    seconds: i64,
    segment_count: i64,
) -> Result<()> {
    if seconds <= 0 && segment_count <= 0 {
        return Ok(());
    }

    let updated_at = format_time(OffsetDateTime::now_utc())?;
    sqlx::query(
        r#"
INSERT INTO daily_presence_usage (date, state, seconds, segment_count, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(date, state) DO UPDATE
SET seconds = daily_presence_usage.seconds + excluded.seconds,
    segment_count = daily_presence_usage.segment_count + excluded.segment_count,
    updated_at = excluded.updated_at
"#,
    )
    .bind(date)
    .bind(state)
    .bind(seconds)
    .bind(segment_count)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn upsert_daily_visible_app_usage_tx(
    tx: &mut Transaction<'_, Sqlite>,
    date: &str,
    process_name: &str,
    display_name: &str,
    seconds: i64,
    segment_count: i64,
) -> Result<()> {
    if seconds <= 0 && segment_count <= 0 {
        return Ok(());
    }

    let updated_at = format_time(OffsetDateTime::now_utc())?;
    sqlx::query(
        r#"
INSERT INTO daily_visible_app_usage (date, process_name, display_name, seconds, segment_count, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(date, process_name) DO UPDATE
SET display_name = excluded.display_name,
    seconds = daily_visible_app_usage.seconds + excluded.seconds,
    segment_count = daily_visible_app_usage.segment_count + excluded.segment_count,
    updated_at = excluded.updated_at
"#,
    )
    .bind(date)
    .bind(process_name)
    .bind(display_name)
    .bind(seconds)
    .bind(segment_count)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn trend_bounds(anchor_date: Date, period: TrendPeriod) -> Result<(Date, Date)> {
    match period {
        TrendPeriod::Week => {
            let weekday_offset = anchor_date.weekday().number_days_from_monday() as i64;
            let start = anchor_date - Duration::days(weekday_offset);
            Ok((start, start + Duration::days(6)))
        }
        TrendPeriod::Month => {
            let start = Date::from_calendar_date(anchor_date.year(), anchor_date.month(), 1)
                .map_err(|error| anyhow!("invalid trend month: {error}"))?;
            let end = start
                + Duration::days(days_in_month(anchor_date.year(), anchor_date.month()) as i64 - 1);
            Ok((start, end))
        }
    }
}

fn date_range(start: Date, end: Date) -> Result<Vec<Date>> {
    if end < start {
        return Ok(Vec::new());
    }

    let mut days = Vec::new();
    let mut current = start;
    while current <= end {
        days.push(current);
        current = current
            .next_day()
            .ok_or_else(|| anyhow!("date range exceeds supported calendar"))?;
    }
    Ok(days)
}

fn parse_presence_state(value: &str) -> Result<PresenceState> {
    match value {
        "active" => Ok(PresenceState::Active),
        "idle" => Ok(PresenceState::Idle),
        "locked" => Ok(PresenceState::Locked),
        other => Err(anyhow!("unknown presence state {}", other)),
    }
}

fn is_browser_process(process_name: &str) -> bool {
    matches!(
        process_name.to_ascii_lowercase().as_str(),
        "chrome.exe" | "msedge.exe" | "firefox.exe" | "brave.exe"
    )
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

    rows.sort_by_key(|row| std::cmp::Reverse(row.seconds));
    rows
}

fn app_usage_table(metric: UsageMetric) -> &'static str {
    match metric {
        UsageMetric::Focus => "daily_app_usage",
        UsageMetric::VisibleWindow => "daily_visible_app_usage",
    }
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
    use super::{AgentStore, AppConfig, VisibleWindowSegmentInput, format_time, parse_time};
    use common::{AppInfo, BrowserEventPayload, PresenceState, UsageMetric};
    use sqlx::Row;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use time::{Duration, OffsetDateTime};

    static TEST_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[tokio::test]
    async fn restore_unclosed_segments_uses_last_seen_at_instead_of_restart_time() {
        let database_path = unique_database_path();
        let config = AppConfig {
            database_path: database_path.clone(),
            lockfile_path: temp_lock_path(&database_path),
            ..AppConfig::default()
        };

        let store = AgentStore::connect(&config, time::UtcOffset::UTC)
            .await
            .expect("connect store");
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

    #[tokio::test]
    async fn migrations_create_overlap_lookup_indexes() {
        let unique = format!(
            "timeline-test-{}.sqlite",
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let database_path = std::env::temp_dir().join(unique);
        let config = AppConfig {
            database_path: database_path.clone(),
            lockfile_path: temp_lock_path(&database_path),
            ..AppConfig::default()
        };

        let store = AgentStore::connect(&config, time::UtcOffset::UTC)
            .await
            .expect("connect store");

        assert!(index_exists(&store, "focus_segments", "idx_focus_segments_ended_started").await);
        assert!(
            index_exists(
                &store,
                "browser_segments",
                "idx_browser_segments_ended_started"
            )
            .await
        );
        assert!(
            index_exists(
                &store,
                "presence_segments",
                "idx_presence_segments_ended_started"
            )
            .await
        );

        let _ = std::fs::remove_file(database_path);
    }

    async fn index_exists(store: &AgentStore, table: &str, index_name: &str) -> bool {
        let sql = format!("PRAGMA index_list({table})");
        let rows = sqlx::query(&sql)
            .fetch_all(&store.pool)
            .await
            .expect("load index list");

        rows.iter()
            .any(|row| row.get::<String, _>("name") == index_name)
    }

    #[tokio::test]
    async fn daily_rollups_power_calendar_summary_and_app_trend() {
        let (store, database_path) = temp_store().await;
        let app = AppInfo {
            process_name: "code.exe".to_string(),
            display_name: "Code".to_string(),
            exe_path: None,
            window_title: None,
            is_browser: false,
        };
        let focus_start = parse_time("2026-06-16T23:30:00Z").expect("focus start");
        let focus_end = parse_time("2026-06-17T00:30:00Z").expect("focus end");
        let focus_id = store
            .start_focus_segment(&app, focus_start)
            .await
            .expect("start focus");
        store
            .end_focus_segment(focus_id, focus_end)
            .await
            .expect("end focus");

        let presence_id = store
            .start_presence_segment(PresenceState::Active, focus_start)
            .await
            .expect("start presence");
        store
            .end_presence_segment(presence_id, focus_end)
            .await
            .expect("end presence");

        let browser_payload = BrowserEventPayload {
            domain: "example.com".to_string(),
            page_title: None,
            browser_window_id: 1,
            tab_id: 1,
            observed_at: None,
        };
        let browser_id = store
            .start_browser_segment(&browser_payload, focus_start)
            .await
            .expect("start browser");
        store
            .end_browser_segment(browser_id, focus_end)
            .await
            .expect("end browser");

        let calendar = store
            .read_month_calendar(2026, time::Month::June, time::UtcOffset::UTC)
            .await
            .expect("read calendar");
        let june_16 = calendar
            .days
            .iter()
            .find(|day| day.date == "2026-06-16")
            .expect("june 16 summary");
        let june_17 = calendar
            .days
            .iter()
            .find(|day| day.date == "2026-06-17")
            .expect("june 17 summary");
        assert_eq!(june_16.focus_seconds, 30 * 60);
        assert_eq!(june_17.focus_seconds, 30 * 60);
        assert_eq!(june_16.active_seconds, 30 * 60);
        assert_eq!(june_17.browser_seconds, 30 * 60);
        assert_eq!(
            june_16.top_app.as_ref().map(|entry| entry.key.as_str()),
            Some("code.exe")
        );
        assert_eq!(
            june_17.top_domain.as_ref().map(|entry| entry.key.as_str()),
            Some("example.com")
        );

        let summary = store
            .read_period_summary(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("anchor date"),
                time::UtcOffset::UTC,
            )
            .await
            .expect("read period summary");
        assert_eq!(summary.today.focus_seconds, 30 * 60);
        assert_eq!(summary.week.focus_seconds, 60 * 60);

        let trend = store
            .read_app_usage_trend(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("anchor date"),
                common::TrendPeriod::Week,
                6,
                UsageMetric::Focus,
            )
            .await
            .expect("read app trend");
        let code = trend.series.first().expect("code series");
        assert_eq!(code.key, "code.exe");
        assert_eq!(code.total_seconds, 60 * 60);
        assert_eq!(code.daily_seconds.iter().sum::<i64>(), 60 * 60);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn rebuild_daily_rollups_backfills_existing_segments() {
        let (store, database_path) = temp_store().await;
        let started_at = "2026-06-17T01:00:00Z";
        let ended_at = "2026-06-17T01:45:00Z";
        sqlx::query(
            r#"
INSERT INTO focus_segments (
  process_name,
  display_name,
  exe_path,
  window_title,
  is_browser,
  started_at,
  ended_at,
  last_seen_at,
  created_at
)
VALUES ('legacy.exe', 'Legacy App', NULL, NULL, 0, ?, ?, ?, ?)
"#,
        )
        .bind(started_at)
        .bind(ended_at)
        .bind(ended_at)
        .bind(started_at)
        .execute(&store.pool)
        .await
        .expect("insert legacy focus row");

        store
            .rebuild_daily_rollups()
            .await
            .expect("rebuild rollups");

        let trend = store
            .read_app_usage_trend(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("anchor date"),
                common::TrendPeriod::Week,
                6,
                UsageMetric::Focus,
            )
            .await
            .expect("read app trend");

        assert_eq!(trend.series[0].key, "legacy.exe");
        assert_eq!(trend.series[0].total_seconds, 45 * 60);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn rebuild_daily_rollups_backfills_visible_window_segments() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-17T03:00:00Z").expect("start");
        let end = parse_time("2026-06-17T03:20:00Z").expect("end");
        let code = visible_input("code.exe", "Code", 100, 10, 0.50);

        store
            .start_visible_window_segment(&code, start)
            .await
            .expect("start visible segment");

        sqlx::query("DELETE FROM daily_visible_app_usage")
            .execute(&store.pool)
            .await
            .expect("clear visible rollup");

        sqlx::query(
            "UPDATE visible_window_segments SET ended_at = ?, last_seen_at = ? WHERE process_name = ?",
        )
        .bind(format_time(end).expect("format end"))
        .bind(format_time(end).expect("format last seen"))
        .bind("code.exe")
        .execute(&store.pool)
        .await
        .expect("close visible segment without rollup");

        store
            .rebuild_daily_rollups()
            .await
            .expect("rebuild rollups");

        let anchor =
            time::Date::from_calendar_date(2026, time::Month::June, 17).expect("anchor date");
        let trend = store
            .read_app_usage_trend(
                anchor,
                common::TrendPeriod::Week,
                6,
                UsageMetric::VisibleWindow,
            )
            .await
            .expect("read visible trend");

        assert_eq!(trend.series.len(), 1);
        assert_eq!(trend.series[0].key, "code.exe");
        assert_eq!(trend.series[0].total_seconds, 20 * 60);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn visible_window_rollups_count_parallel_windows_and_stay_separate_from_focus() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-16T23:30:00Z").expect("start");
        let end = parse_time("2026-06-17T00:30:00Z").expect("end");
        let code = visible_input("code.exe", "Code", 100, 10, 0.50);
        let weixin = visible_input("weixin.exe", "Weixin", 200, 20, 0.45);

        let code_id = store
            .start_visible_window_segment(&code, start)
            .await
            .expect("start code visible");
        let weixin_id = store
            .start_visible_window_segment(&weixin, start)
            .await
            .expect("start weixin visible");
        store
            .end_visible_window_segment(code_id, end)
            .await
            .expect("end code visible");
        store
            .end_visible_window_segment(weixin_id, end)
            .await
            .expect("end weixin visible");

        let anchor =
            time::Date::from_calendar_date(2026, time::Month::June, 17).expect("anchor date");
        let visible_trend = store
            .read_app_usage_trend(
                anchor,
                common::TrendPeriod::Week,
                6,
                UsageMetric::VisibleWindow,
            )
            .await
            .expect("read visible trend");
        assert_eq!(visible_trend.metric, UsageMetric::VisibleWindow);
        assert_eq!(visible_trend.series.len(), 2);
        assert_eq!(visible_trend.series[0].total_seconds, 60 * 60);
        assert_eq!(visible_trend.series[1].total_seconds, 60 * 60);
        assert_eq!(
            visible_trend
                .series
                .iter()
                .map(|series| series.daily_seconds.iter().sum::<i64>())
                .sum::<i64>(),
            2 * 60 * 60
        );

        let focus_trend = store
            .read_app_usage_trend(anchor, common::TrendPeriod::Week, 6, UsageMetric::Focus)
            .await
            .expect("read focus trend");
        assert!(focus_trend.series.is_empty());

        let visible_stats = store
            .read_app_stats(anchor, time::UtcOffset::UTC, UsageMetric::VisibleWindow)
            .await
            .expect("read visible app stats");
        assert_eq!(visible_stats.len(), 2);
        assert!(visible_stats.iter().all(|row| row.seconds == 30 * 60));

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn day_timeline_includes_visible_window_segments() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-17T02:00:00Z").expect("start");
        let end = parse_time("2026-06-17T02:05:00Z").expect("end");
        let code = visible_input("code.exe", "Code", 100, 10, 0.50);

        let id = store
            .start_visible_window_segment(&code, start)
            .await
            .expect("start visible");
        store
            .end_visible_window_segment(id, end)
            .await
            .expect("end visible");

        let timeline = store
            .read_day_timeline(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("date"),
                time::UtcOffset::UTC,
            )
            .await
            .expect("read day timeline");

        assert_eq!(timeline.visible_window_segments.len(), 1);
        let visible = &timeline.visible_window_segments[0];
        assert_eq!(visible.id, id);
        assert_eq!(visible.app.process_name, "code.exe");
        assert_eq!(visible.hwnd, 100);
        assert_eq!(visible.process_id, 10);
        assert_eq!(visible.visible_area_ratio, 0.50);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn restore_unclosed_visible_windows_uses_last_seen_at() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-17T01:00:00Z").expect("start");
        let last_seen = parse_time("2026-06-17T01:20:00Z").expect("last seen");
        let code = visible_input("code.exe", "Code", 100, 10, 0.50);
        let id = store
            .start_visible_window_segment(&code, start)
            .await
            .expect("start visible");
        store
            .touch_visible_window_segment(id, last_seen, 0.50)
            .await
            .expect("touch visible");

        store
            .restore_unclosed_segments()
            .await
            .expect("restore segments");

        let row = sqlx::query("SELECT ended_at FROM visible_window_segments WHERE id = ?")
            .bind(id)
            .fetch_one(&store.pool)
            .await
            .expect("load visible row");
        let ended_at = row.get::<String, _>("ended_at");
        assert_eq!(parse_time(&ended_at).expect("parse ended_at"), last_seen);

        let stats = store
            .read_app_stats(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("anchor date"),
                time::UtcOffset::UTC,
                UsageMetric::VisibleWindow,
            )
            .await
            .expect("read visible app stats");
        assert_eq!(stats[0].seconds, 20 * 60);

        let _ = std::fs::remove_file(database_path);
    }

    fn visible_input(
        process_name: &str,
        display_name: &str,
        hwnd: i64,
        process_id: u32,
        visible_area_ratio: f64,
    ) -> VisibleWindowSegmentInput {
        VisibleWindowSegmentInput {
            process_name: process_name.to_string(),
            display_name: display_name.to_string(),
            exe_path: Some(format!("C:\\Apps\\{process_name}")),
            window_title: None,
            hwnd,
            process_id,
            visible_area_ratio,
        }
    }

    async fn temp_store() -> (AgentStore, PathBuf) {
        let database_path = unique_database_path();
        let config = AppConfig {
            database_path: database_path.clone(),
            lockfile_path: temp_lock_path(&database_path),
            ..AppConfig::default()
        };

        (
            AgentStore::connect(&config, time::UtcOffset::UTC)
                .await
                .expect("connect store"),
            database_path,
        )
    }

    fn unique_database_path() -> PathBuf {
        let counter = TEST_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let unique = format!(
            "timeline-test-{}-{}-{}.sqlite",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos(),
            counter,
        );
        std::env::temp_dir().join(unique)
    }

    fn temp_lock_path(database_path: &std::path::Path) -> PathBuf {
        database_path.with_extension("lock")
    }
}
