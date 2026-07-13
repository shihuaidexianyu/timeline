//! SQLite initialization, migrations, writes, and read models for the timeline agent.

use crate::{config::AppConfig, timezone::TimeZoneContext};
use anyhow::{Context, Result, anyhow};
use common::{
    ActiveRollupStatus, AppInfo, AppUsageTrendResponse, AppUsageTrendSeries, BrowserEventPayload,
    BrowserSegment, DaySummary, DebugEvent, DurationStat, FocusSegment, FocusStats,
    KeyedDurationEntry, MonthCalendarResponse, PeriodStat, PeriodSummaryResponse, PresenceSegment,
    PresenceState, RecentTrackedItem, TimelineDayResponse, TrendPeriod,
};
use serde::Serialize;
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use time::format_description::well_known::Rfc3339;
use time::{Date, Duration, OffsetDateTime, UtcOffset};

#[derive(Clone)]
pub struct AgentStore {
    pool: SqlitePool,
    timezone: Arc<RwLock<TimeZoneContext>>,
    database_path: PathBuf,
    debug: bool,
}

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

struct ActiveRollupRebuildPlan {
    next_date: Date,
    completed_days: i64,
    total_days: i64,
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
        name: "create_active_rollups_and_runtime_settings",
        sql: r#"
CREATE TABLE IF NOT EXISTS daily_active_app_usage (
  date TEXT NOT NULL,
  process_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, process_name)
);

CREATE TABLE IF NOT EXISTS daily_active_domain_usage (
  date TEXT NOT NULL,
  domain TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, domain)
);

CREATE TABLE IF NOT EXISTS rollup_rebuild_jobs (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  next_date TEXT,
  completed_days INTEGER NOT NULL DEFAULT 0,
  total_days INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_active_app_usage_date_seconds
  ON daily_active_app_usage(date, seconds DESC);
CREATE INDEX IF NOT EXISTS idx_daily_active_domain_usage_date_seconds
  ON daily_active_domain_usage(date, seconds DESC);
"#,
    },
];

/// Keep recent raw events for local debugging while capping unbounded DB growth.
const RAW_EVENTS_MAX_ROWS: i64 = 50_000;
const DAILY_ROLLUP_VERSION: &str = "2";
pub const ACTIVE_ROLLUP_ALGORITHM_VERSION: &str = "2";

impl AgentStore {
    pub async fn connect(config: &AppConfig, timezone: impl Into<TimeZoneContext>) -> Result<Self> {
        config.ensure_parent_dirs()?;
        let database_existed = config.database_path.is_file();

        let connect_options = SqliteConnectOptions::from_str(
            config
                .database_path
                .to_str()
                .ok_or_else(|| anyhow!("database path is not valid UTF-8"))?,
        )?
        .create_if_missing(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .pragma("journal_mode", "WAL")
        .pragma("synchronous", "NORMAL");

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(connect_options)
            .await
            .context("failed to connect sqlite")?;

        let store = Self {
            pool,
            timezone: Arc::new(RwLock::new(timezone.into())),
            database_path: config.database_path.clone(),
            debug: config.debug,
        };
        if database_existed && store.has_pending_migrations().await? {
            store
                .backup_database_before_migrations(&config.database_path)
                .await?;
        }
        store.run_migrations().await?;
        Ok(store)
    }

    async fn has_pending_migrations(&self) -> Result<bool> {
        let table_exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        )
        .fetch_one(&self.pool)
        .await?;
        if table_exists == 0 {
            return Ok(true);
        }

        let applied = sqlx::query_scalar::<_, i64>("SELECT version FROM schema_migrations")
            .fetch_all(&self.pool)
            .await?;
        Ok(MIGRATIONS
            .iter()
            .any(|migration| !applied.contains(&migration.version)))
    }

    async fn backup_database_before_migrations(&self, database_path: &Path) -> Result<PathBuf> {
        sqlx::query("PRAGMA wal_checkpoint(FULL)")
            .execute(&self.pool)
            .await
            .context("failed to checkpoint database before migration backup")?;

        let file_name = database_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("timeline.sqlite");
        let backup_path = database_path.with_file_name(format!("{file_name}.pre-migration.bak"));
        if backup_path.exists() {
            std::fs::remove_file(&backup_path)
                .with_context(|| format!("failed to replace migration backup {:?}", backup_path))?;
        }
        let escaped = backup_path
            .to_str()
            .context("migration backup path is not valid UTF-8")?
            .replace('\'', "''");
        sqlx::raw_sql(&format!("VACUUM INTO '{escaped}'"))
            .execute(&self.pool)
            .await
            .with_context(|| format!("failed to back up database to {:?}", backup_path))?;
        Ok(backup_path)
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT process_name, display_name, started_at, last_seen_at FROM focus_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = std::cmp::max(previous_seen_at, observed_at);
            let ended_at_text = format_time(ended_at)?;
            sqlx::query(
                "UPDATE focus_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
            )
            .bind(&ended_at_text)
            .bind(&ended_at_text)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            self.add_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                ended_at,
            )
            .await?;
            self.add_active_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                ended_at,
                true,
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT process_name, display_name, started_at, last_seen_at FROM focus_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let process_name = row.get::<String, _>("process_name");
            let display_name = row.get::<String, _>("display_name");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = std::cmp::max(previous_seen_at, observed_at);
            sqlx::query(
                "UPDATE focus_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
            )
            .bind(format_time(touched_at)?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            self.add_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                touched_at,
            )
            .await?;
            self.add_active_app_usage_seconds_tx(
                &mut tx,
                &process_name,
                &display_name,
                previous_seen_at,
                touched_at,
                false,
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT state, started_at, last_seen_at FROM presence_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let state = row.get::<String, _>("state");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = std::cmp::max(previous_seen_at, observed_at);
            let ended_at_text = format_time(ended_at)?;
            sqlx::query(
                "UPDATE presence_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
            )
            .bind(&ended_at_text)
            .bind(&ended_at_text)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            self.add_presence_usage_seconds_tx(&mut tx, &state, previous_seen_at, ended_at)
                .await?;
            self.add_presence_segment_counts_tx(&mut tx, &state, started_at, ended_at)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn touch_presence_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT state, started_at, last_seen_at FROM presence_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let state = row.get::<String, _>("state");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = std::cmp::max(previous_seen_at, observed_at);
            sqlx::query(
                "UPDATE presence_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
            )
            .bind(format_time(touched_at)?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
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
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT domain, started_at, last_seen_at FROM browser_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let domain = row.get::<String, _>("domain");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let ended_at = std::cmp::max(previous_seen_at, observed_at);
            let ended_at_text = format_time(ended_at)?;
            sqlx::query(
                "UPDATE browser_segments SET last_seen_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
            )
            .bind(&ended_at_text)
            .bind(&ended_at_text)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            self.add_domain_usage_seconds_tx(&mut tx, &domain, previous_seen_at, ended_at)
                .await?;
            self.add_active_domain_usage_seconds_tx(
                &mut tx,
                &domain,
                previous_seen_at,
                ended_at,
                true,
            )
            .await?;
            self.add_domain_segment_counts_tx(&mut tx, &domain, started_at, ended_at)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn touch_browser_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT domain, started_at, last_seen_at FROM browser_segments WHERE id = ? AND ended_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let domain = row.get::<String, _>("domain");
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let previous_seen_at =
                parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                    .unwrap_or(started_at);
            let touched_at = std::cmp::max(previous_seen_at, observed_at);
            sqlx::query(
                "UPDATE browser_segments SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL",
            )
            .bind(format_time(touched_at)?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            self.add_domain_usage_seconds_tx(&mut tx, &domain, previous_seen_at, touched_at)
                .await?;
            self.add_active_domain_usage_seconds_tx(
                &mut tx,
                &domain,
                previous_seen_at,
                touched_at,
                false,
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
        let payload_json = if self.debug {
            serde_json::to_string(payload)?
        } else {
            "{}".to_string()
        };
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
        let timezone = sqlx::query_scalar::<_, String>(
            "SELECT value FROM rollup_metadata WHERE key = 'daily_rollup_timezone'",
        )
        .fetch_optional(&self.pool)
        .await?;

        if existing.as_deref() == Some(DAILY_ROLLUP_VERSION)
            && timezone.as_deref() == Some(self.timezone_id().as_str())
        {
            return Ok(());
        }

        self.rebuild_daily_rollups().await
    }

    pub async fn schema_version(&self) -> Result<i64> {
        Ok(
            sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub fn timezone_id(&self) -> String {
        self.timezone_snapshot().id()
    }

    pub fn local_offset_at(&self, utc: OffsetDateTime) -> Result<UtcOffset> {
        self.timezone_snapshot().offset_at(utc)
    }

    pub fn next_local_midnight(&self, utc: OffsetDateTime) -> Result<OffsetDateTime> {
        let tomorrow = self
            .local_date_at(utc)?
            .next_day()
            .context("local date overflow")?;
        Ok(self.day_bounds(tomorrow)?.0)
    }

    pub fn refresh_windows_timezone(&self) -> Result<bool> {
        let next = TimeZoneContext::current_windows()?;
        let mut current = self
            .timezone
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current.id() == next.id() {
            return Ok(false);
        }
        *current = next;
        Ok(true)
    }

    fn timezone_snapshot(&self) -> TimeZoneContext {
        self.timezone
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn local_date_at(&self, utc: OffsetDateTime) -> Result<Date> {
        self.timezone_snapshot().local_date(utc)
    }

    fn day_bounds(&self, date: Date) -> Result<(OffsetDateTime, OffsetDateTime)> {
        self.timezone_snapshot().day_bounds(date)
    }

    fn split_interval_by_local_day(
        &self,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ) -> Result<Vec<DailyChunk>> {
        split_interval_by_local_day(start, end, &self.timezone_snapshot())
    }

    pub async fn active_rollup_status(&self) -> Result<ActiveRollupStatus> {
        let row = sqlx::query(
            r#"
SELECT status, completed_days, total_days, next_date, last_error, updated_at
FROM rollup_rebuild_jobs
WHERE key = 'active_rollups'
"#,
        )
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(ActiveRollupStatus {
                status: row.get("status"),
                completed_days: row.get("completed_days"),
                total_days: row.get("total_days"),
                next_date: row.get("next_date"),
                last_error: row.get("last_error"),
                updated_at: parse_optional_time(row.get::<Option<String>, _>("updated_at"))?,
            }),
            None => Ok(ActiveRollupStatus {
                status: "pending".to_string(),
                completed_days: 0,
                total_days: 0,
                next_date: None,
                last_error: None,
                updated_at: None,
            }),
        }
    }

    pub async fn ensure_active_rollups(&self) -> Result<()> {
        let version = sqlx::query_scalar::<_, String>(
            "SELECT value FROM rollup_metadata WHERE key = 'active_rollup_algorithm_version'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let timezone = sqlx::query_scalar::<_, String>(
            "SELECT value FROM rollup_metadata WHERE key = 'rollup_timezone'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let status = self.active_rollup_status().await?;
        if version.as_deref() == Some(ACTIVE_ROLLUP_ALGORITHM_VERSION)
            && timezone.as_deref() == Some(self.timezone_id().as_str())
            && status.status == "ready"
        {
            return Ok(());
        }
        self.rebuild_active_rollups().await
    }

    pub async fn rebuild_active_rollups(&self) -> Result<()> {
        let result = self.rebuild_active_rollups_inner().await;
        if let Err(error) = &result {
            let status = self
                .active_rollup_status()
                .await
                .unwrap_or(ActiveRollupStatus {
                    status: "pending".to_string(),
                    completed_days: 0,
                    total_days: 0,
                    next_date: None,
                    last_error: None,
                    updated_at: None,
                });
            let _ = self
                .set_active_rollup_job(
                    "failed",
                    status.completed_days,
                    status.total_days,
                    status.next_date.as_deref(),
                    Some(&error.to_string()),
                )
                .await;
        }
        result
    }

    async fn rebuild_active_rollups_inner(&self) -> Result<()> {
        let Some(plan) = self.prepare_active_rollup_rebuild().await? else {
            return Ok(());
        };

        let remaining_days = plan.total_days.saturating_sub(plan.completed_days);
        let mut date = plan.next_date;
        for offset in 0..remaining_days {
            let completed_days = plan.completed_days + offset + 1;
            self.rebuild_active_rollup_date(date, completed_days, plan.total_days)
                .await?;
            if completed_days < plan.total_days {
                date = date
                    .next_day()
                    .ok_or_else(|| anyhow!("active rollup date range overflow"))?;
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    async fn prepare_active_rollup_rebuild(&self) -> Result<Option<ActiveRollupRebuildPlan>> {
        let rebuild_version = sqlx::query_scalar::<_, String>(
            "SELECT value FROM rollup_metadata WHERE key = 'active_rollup_rebuild_version'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let rebuild_timezone = sqlx::query_scalar::<_, String>(
            "SELECT value FROM rollup_metadata WHERE key = 'active_rollup_rebuild_timezone'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let timezone = self.timezone_id();
        let status = self.active_rollup_status().await?;
        if rebuild_version.as_deref() == Some(ACTIVE_ROLLUP_ALGORITHM_VERSION)
            && rebuild_timezone.as_deref() == Some(timezone.as_str())
            && matches!(status.status.as_str(), "pending" | "running" | "failed")
            && status.completed_days < status.total_days
            && let Some(next_date) = status.next_date.as_deref()
        {
            let next_date = parse_date(next_date)?;
            let next_date_text = next_date.to_string();
            self.set_active_rollup_job(
                "running",
                status.completed_days,
                status.total_days,
                Some(&next_date_text),
                None,
            )
            .await?;
            return Ok(Some(ActiveRollupRebuildPlan {
                next_date,
                completed_days: status.completed_days,
                total_days: status.total_days,
            }));
        }

        let bounds = sqlx::query(
            r#"
SELECT MIN(started_at) AS earliest, MAX(effective_end) AS latest
FROM (
  SELECT started_at, COALESCE(ended_at, last_seen_at, started_at) AS effective_end FROM focus_segments
  UNION ALL
  SELECT started_at, COALESCE(ended_at, last_seen_at, started_at) AS effective_end FROM browser_segments
  UNION ALL
  SELECT started_at, COALESCE(ended_at, last_seen_at, started_at) AS effective_end FROM presence_segments
)
"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let earliest = bounds.get::<Option<String>, _>("earliest");
        let latest = bounds.get::<Option<String>, _>("latest");
        let date_bounds = match (earliest, latest) {
            (Some(earliest), Some(latest)) => {
                let earliest = parse_time(&earliest)?;
                let latest = parse_time(&latest)?;
                let start_date = self.local_date_at(earliest)?;
                let end_instant = if latest > earliest {
                    latest - Duration::nanoseconds(1)
                } else {
                    latest
                };
                Some((start_date, self.local_date_at(end_instant)?))
            }
            _ => None,
        };

        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM daily_active_app_usage")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM daily_active_domain_usage")
            .execute(&mut *tx)
            .await?;
        let updated_at = format_time(OffsetDateTime::now_utc())?;
        for (key, value) in [
            (
                "active_rollup_rebuild_version",
                ACTIVE_ROLLUP_ALGORITHM_VERSION,
            ),
            ("active_rollup_rebuild_timezone", timezone.as_str()),
        ] {
            upsert_rollup_metadata_tx(&mut tx, key, value, &updated_at).await?;
        }

        let Some((start_date, end_date)) = date_bounds else {
            upsert_rollup_metadata_tx(
                &mut tx,
                "active_rollup_algorithm_version",
                ACTIVE_ROLLUP_ALGORITHM_VERSION,
                &updated_at,
            )
            .await?;
            upsert_rollup_metadata_tx(&mut tx, "rollup_timezone", &timezone, &updated_at).await?;
            upsert_active_rollup_job_tx(&mut tx, "ready", 0, 0, None, None, &updated_at).await?;
            tx.commit().await?;
            return Ok(None);
        };

        let total_days = (end_date - start_date).whole_days() + 1;
        let start_date_text = start_date.to_string();
        upsert_active_rollup_job_tx(
            &mut tx,
            "running",
            0,
            total_days,
            Some(&start_date_text),
            None,
            &updated_at,
        )
        .await?;
        tx.commit().await?;
        Ok(Some(ActiveRollupRebuildPlan {
            next_date: start_date,
            completed_days: 0,
            total_days,
        }))
    }

    async fn rebuild_active_rollup_date(
        &self,
        date: Date,
        completed_days: i64,
        total_days: i64,
    ) -> Result<()> {
        let date_text = date.to_string();
        let (day_start, day_end) = self.day_bounds(date)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM daily_active_app_usage WHERE date = ?")
            .bind(&date_text)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM daily_active_domain_usage WHERE date = ?")
            .bind(&date_text)
            .execute(&mut *tx)
            .await?;

        let active_intervals = active_overlaps_tx(&mut tx, day_start, day_end).await?;
        let focus_rows = sqlx::query(
            r#"
SELECT process_name, display_name, started_at,
       COALESCE(ended_at, last_seen_at, started_at) AS effective_end
FROM focus_segments
WHERE started_at < ? AND COALESCE(ended_at, last_seen_at, started_at) > ?
ORDER BY started_at
"#,
        )
        .bind(format_time(day_end)?)
        .bind(format_time(day_start)?)
        .fetch_all(&mut *tx)
        .await?;
        let mut app_buckets: BTreeMap<String, RollupBucket> = BTreeMap::new();
        for row in focus_rows {
            let key = row.get::<String, _>("process_name");
            let label = row.get::<String, _>("display_name");
            let start = std::cmp::max(
                day_start,
                parse_time(row.get::<String, _>("started_at").as_str())?,
            );
            let end = std::cmp::min(
                day_end,
                parse_time(row.get::<String, _>("effective_end").as_str())?,
            );
            let overlaps = intersect_active_intervals(start, end, &active_intervals);
            if overlaps.is_empty() {
                continue;
            }
            let bucket = app_buckets.entry(key).or_insert_with(|| RollupBucket {
                label: label.clone(),
                seconds: 0,
                segment_count: 0,
            });
            bucket.label = label;
            bucket.seconds += overlaps
                .iter()
                .map(|(start, end)| (*end - *start).whole_seconds().max(0))
                .sum::<i64>();
            bucket.segment_count += 1;
        }
        for (key, bucket) in app_buckets {
            upsert_daily_active_app_usage_tx(
                &mut tx,
                &date_text,
                &key,
                &bucket.label,
                bucket.seconds,
                bucket.segment_count,
            )
            .await?;
        }

        let browser_rows = sqlx::query(
            r#"
SELECT domain, started_at, COALESCE(ended_at, last_seen_at, started_at) AS effective_end
FROM browser_segments
WHERE started_at < ? AND COALESCE(ended_at, last_seen_at, started_at) > ?
ORDER BY started_at
"#,
        )
        .bind(format_time(day_end)?)
        .bind(format_time(day_start)?)
        .fetch_all(&mut *tx)
        .await?;
        let mut domain_buckets: BTreeMap<String, RollupBucket> = BTreeMap::new();
        for row in browser_rows {
            let domain = row.get::<String, _>("domain");
            let start = std::cmp::max(
                day_start,
                parse_time(row.get::<String, _>("started_at").as_str())?,
            );
            let end = std::cmp::min(
                day_end,
                parse_time(row.get::<String, _>("effective_end").as_str())?,
            );
            let overlaps = intersect_active_intervals(start, end, &active_intervals);
            if overlaps.is_empty() {
                continue;
            }
            let bucket = domain_buckets
                .entry(domain.clone())
                .or_insert_with(|| RollupBucket {
                    label: domain.clone(),
                    seconds: 0,
                    segment_count: 0,
                });
            bucket.seconds += overlaps
                .iter()
                .map(|(start, end)| (*end - *start).whole_seconds().max(0))
                .sum::<i64>();
            bucket.segment_count += 1;
        }
        for (domain, bucket) in domain_buckets {
            upsert_daily_active_domain_usage_tx(
                &mut tx,
                &date_text,
                &domain,
                bucket.seconds,
                bucket.segment_count,
            )
            .await?;
        }

        let updated_at = format_time(OffsetDateTime::now_utc())?;
        let ready = completed_days >= total_days;
        let next_date = if ready {
            None
        } else {
            Some(
                date.next_day()
                    .ok_or_else(|| anyhow!("active rollup date range overflow"))?
                    .to_string(),
            )
        };
        if ready {
            let timezone = self.timezone_id();
            upsert_rollup_metadata_tx(
                &mut tx,
                "active_rollup_algorithm_version",
                ACTIVE_ROLLUP_ALGORITHM_VERSION,
                &updated_at,
            )
            .await?;
            upsert_rollup_metadata_tx(&mut tx, "rollup_timezone", &timezone, &updated_at).await?;
        }
        upsert_active_rollup_job_tx(
            &mut tx,
            if ready { "ready" } else { "running" },
            completed_days,
            total_days,
            next_date.as_deref(),
            None,
            &updated_at,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn set_active_rollup_job(
        &self,
        status: &str,
        completed_days: i64,
        total_days: i64,
        next_date: Option<&str>,
        last_error: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            r#"
INSERT INTO rollup_rebuild_jobs(key, status, next_date, completed_days, total_days, last_error, updated_at)
VALUES('active_rollups', ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET status=excluded.status, next_date=excluded.next_date,
  completed_days=excluded.completed_days, total_days=excluded.total_days,
  last_error=excluded.last_error, updated_at=excluded.updated_at
"#,
        )
        .bind(status)
        .bind(next_date)
        .bind(completed_days)
        .bind(total_days)
        .bind(last_error)
        .bind(format_time(OffsetDateTime::now_utc())?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn database_size_bytes(&self) -> Result<u64> {
        let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&self.pool)
            .await?;
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(&self.pool)
            .await?;
        Ok(page_count.saturating_mul(page_size).max(0) as u64)
    }

    pub async fn earliest_recorded_date(&self) -> Result<Option<String>> {
        let earliest = sqlx::query_scalar::<_, Option<String>>(
            r#"
SELECT MIN(value) FROM (
  SELECT MIN(started_at) AS value FROM focus_segments
  UNION ALL SELECT MIN(started_at) FROM browser_segments
  UNION ALL SELECT MIN(started_at) FROM presence_segments
)
"#,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(earliest.map(|value| value.chars().take(10).collect()))
    }

    pub async fn runtime_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT value FROM runtime_settings WHERE key = ?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn set_runtime_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        if let Some(value) = value {
            sqlx::query(
                "INSERT INTO runtime_settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            )
            .bind(key)
            .bind(value)
            .bind(format_time(OffsetDateTime::now_utc())?)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query("DELETE FROM runtime_settings WHERE key = ?")
                .bind(key)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn export_json(&self, from: Date, to: Date) -> Result<Vec<u8>> {
        let (start, _) = self.day_bounds(from)?;
        let (_, end) = self.day_bounds(to)?;
        let start_text = format_time(start)?;
        let end_text = format_time(end)?;
        let focus_rows = sqlx::query(
            r#"
SELECT process_name, display_name, exe_path, window_title, is_browser, started_at,
       COALESCE(ended_at, last_seen_at, started_at) AS ended_at
FROM focus_segments
WHERE started_at < ? AND COALESCE(ended_at, last_seen_at, started_at) >= ?
ORDER BY started_at
"#,
        )
        .bind(&end_text)
        .bind(&start_text)
        .fetch_all(&self.pool)
        .await?;
        let browser_rows = sqlx::query(
            r#"
SELECT domain, page_title, browser_window_id, tab_id, started_at,
       COALESCE(ended_at, last_seen_at, started_at) AS ended_at
FROM browser_segments
WHERE started_at < ? AND COALESCE(ended_at, last_seen_at, started_at) >= ?
ORDER BY started_at
"#,
        )
        .bind(&end_text)
        .bind(&start_text)
        .fetch_all(&self.pool)
        .await?;
        let presence_rows = sqlx::query(
            r#"
SELECT state, started_at, COALESCE(ended_at, last_seen_at, started_at) AS ended_at
FROM presence_segments
WHERE started_at < ? AND COALESCE(ended_at, last_seen_at, started_at) >= ?
ORDER BY started_at
"#,
        )
        .bind(&end_text)
        .bind(&start_text)
        .fetch_all(&self.pool)
        .await?;

        let focus = focus_rows
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "process_name": row.get::<String, _>("process_name"),
                    "display_name": row.get::<String, _>("display_name"),
                    "exe_path": row.get::<Option<String>, _>("exe_path"),
                    "window_title": row.get::<Option<String>, _>("window_title"),
                    "is_browser": row.get::<i64, _>("is_browser") == 1,
                    "started_at": row.get::<String, _>("started_at"),
                    "ended_at": row.get::<String, _>("ended_at"),
                })
            })
            .collect::<Vec<_>>();
        let browser = browser_rows
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "domain": row.get::<String, _>("domain"),
                    "page_title": row.get::<Option<String>, _>("page_title"),
                    "browser_window_id": row.get::<i64, _>("browser_window_id"),
                    "tab_id": row.get::<i64, _>("tab_id"),
                    "started_at": row.get::<String, _>("started_at"),
                    "ended_at": row.get::<String, _>("ended_at"),
                })
            })
            .collect::<Vec<_>>();
        let presence = presence_rows
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "state": row.get::<String, _>("state"),
                    "started_at": row.get::<String, _>("started_at"),
                    "ended_at": row.get::<String, _>("ended_at"),
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "from": from.to_string(),
            "to": to.to_string(),
            "timezone": self.timezone_id(),
            "focus": focus,
            "browser": browser,
            "presence": presence,
        }))?)
    }

    pub async fn export_csv_archive(&self, from: Date, to: Date) -> Result<Vec<u8>> {
        let json: serde_json::Value = serde_json::from_slice(&self.export_json(from, to).await?)?;
        let mut focus_csv = String::from(
            "process_name,display_name,exe_path,window_title,is_browser,started_at,ended_at\r\n",
        );
        for row in json["focus"].as_array().into_iter().flatten() {
            focus_csv.push_str(&csv_row(&[
                row["process_name"].as_str().unwrap_or_default(),
                row["display_name"].as_str().unwrap_or_default(),
                row["exe_path"].as_str().unwrap_or_default(),
                row["window_title"].as_str().unwrap_or_default(),
                if row["is_browser"].as_bool().unwrap_or(false) {
                    "true"
                } else {
                    "false"
                },
                row["started_at"].as_str().unwrap_or_default(),
                row["ended_at"].as_str().unwrap_or_default(),
            ]));
        }

        let mut browser_csv =
            String::from("domain,page_title,browser_window_id,tab_id,started_at,ended_at\r\n");
        for row in json["browser"].as_array().into_iter().flatten() {
            let browser_window_id = row["browser_window_id"].to_string();
            let tab_id = row["tab_id"].to_string();
            browser_csv.push_str(&csv_row(&[
                row["domain"].as_str().unwrap_or_default(),
                row["page_title"].as_str().unwrap_or_default(),
                &browser_window_id,
                &tab_id,
                row["started_at"].as_str().unwrap_or_default(),
                row["ended_at"].as_str().unwrap_or_default(),
            ]));
        }

        let mut presence_csv = String::from("state,started_at,ended_at\r\n");
        for row in json["presence"].as_array().into_iter().flatten() {
            presence_csv.push_str(&csv_row(&[
                row["state"].as_str().unwrap_or_default(),
                row["started_at"].as_str().unwrap_or_default(),
                row["ended_at"].as_str().unwrap_or_default(),
            ]));
        }

        build_stored_zip(&[
            ("focus.csv", focus_csv.as_bytes()),
            ("browser.csv", browser_csv.as_bytes()),
            ("presence.csv", presence_csv.as_bytes()),
        ])
    }

    pub async fn create_online_backup(&self) -> Result<PathBuf> {
        let backup_path = self.database_path.with_file_name(format!(
            "timeline-backup-{}.sqlite",
            OffsetDateTime::now_utc().unix_timestamp()
        ));
        let escaped = backup_path
            .to_str()
            .context("backup path is not valid UTF-8")?
            .replace('\'', "''");
        sqlx::raw_sql(&format!("VACUUM INTO '{escaped}'"))
            .execute(&self.pool)
            .await?;
        self.set_runtime_setting(
            "last_backup_at",
            Some(&format_time(OffsetDateTime::now_utc())?),
        )
        .await?;
        Ok(backup_path)
    }

    pub async fn last_backup_at(&self) -> Result<Option<OffsetDateTime>> {
        self.runtime_setting("last_backup_at")
            .await?
            .map(|value| parse_time(&value))
            .transpose()
    }

    pub async fn recent_apps(&self, limit: i64) -> Result<Vec<RecentTrackedItem>> {
        let rows = sqlx::query(
            "SELECT process_name, display_name FROM app_registry ORDER BY updated_at DESC LIMIT ?",
        )
        .bind(limit.clamp(1, 50))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| RecentTrackedItem {
                key: row.get("process_name"),
                label: row.get("display_name"),
            })
            .collect())
    }

    pub async fn recent_domains(&self, limit: i64) -> Result<Vec<RecentTrackedItem>> {
        let rows = sqlx::query(
            r#"
SELECT domain, MAX(COALESCE(ended_at, last_seen_at, started_at)) AS last_observed_at
FROM browser_segments
GROUP BY domain
ORDER BY last_observed_at DESC
LIMIT ?
"#,
        )
        .bind(limit.clamp(1, 50))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let domain = row.get::<String, _>("domain");
                RecentTrackedItem {
                    key: domain.clone(),
                    label: domain,
                }
            })
            .collect())
    }

    pub async fn delete_data(&self, from: Option<Date>, to: Option<Date>, all: bool) -> Result<()> {
        self.delete_data_internal(from, to, all, true).await
    }

    async fn delete_data_internal(
        &self,
        from: Option<Date>,
        to: Option<Date>,
        all: bool,
        rebuild_rollups: bool,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        if all {
            for table in [
                "focus_segments",
                "browser_segments",
                "presence_segments",
                "raw_events",
                "daily_app_usage",
                "daily_domain_usage",
                "daily_presence_usage",
                "daily_active_app_usage",
                "daily_active_domain_usage",
            ] {
                sqlx::query(&format!("DELETE FROM {table}"))
                    .execute(&mut *tx)
                    .await?;
            }
        } else {
            let from = from.context("from is required unless all is true")?;
            let to = to.context("to is required unless all is true")?;
            if to < from {
                return Err(anyhow!("to must not be earlier than from"));
            }
            let (start, _) = self.day_bounds(from)?;
            let (_, end) = self.day_bounds(to)?;
            let start_text = format_time(start)?;
            let end_text = format_time(end)?;
            delete_segment_range_tx(
                &mut tx,
                "focus_segments",
                "process_name, display_name, exe_path, window_title, is_browser",
                &start_text,
                &end_text,
            )
            .await?;
            delete_segment_range_tx(
                &mut tx,
                "browser_segments",
                "domain, page_title, browser_window_id, tab_id",
                &start_text,
                &end_text,
            )
            .await?;
            delete_segment_range_tx(
                &mut tx,
                "presence_segments",
                "state",
                &start_text,
                &end_text,
            )
            .await?;
            sqlx::query("DELETE FROM raw_events WHERE observed_at >= ? AND observed_at < ?")
                .bind(&start_text)
                .bind(&end_text)
                .execute(&mut *tx)
                .await?;
            for table in [
                "daily_app_usage",
                "daily_domain_usage",
                "daily_presence_usage",
                "daily_active_app_usage",
                "daily_active_domain_usage",
            ] {
                sqlx::query(&format!(
                    "DELETE FROM {table} WHERE date >= ? AND date <= ?"
                ))
                .bind(from.to_string())
                .bind(to.to_string())
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        if rebuild_rollups {
            self.rebuild_daily_rollups().await?;
            self.rebuild_active_rollups().await?;
        }
        Ok(())
    }

    pub async fn apply_retention(&self, retention_days: u32) -> Result<()> {
        let today = self.local_date_at(OffsetDateTime::now_utc())?;
        // The current local date counts as day one. For example, a 90-day
        // policy keeps today plus the preceding 89 local dates.
        let keep_from = today - Duration::days(retention_days.saturating_sub(1) as i64);
        let oldest = self.earliest_recorded_date().await?;
        let Some(oldest) = oldest else {
            return Ok(());
        };
        let oldest = Date::parse(
            &oldest,
            &time::format_description::parse("[year]-[month]-[day]")?,
        )?;
        if oldest < keep_from {
            self.delete_data_internal(
                Some(oldest),
                Some(keep_from.previous_day().unwrap_or(keep_from)),
                false,
                false,
            )
            .await?;
        }
        Ok(())
    }

    pub async fn rebuild_daily_rollups(&self) -> Result<()> {
        let mut app_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();
        let mut domain_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();
        let mut presence_buckets: BTreeMap<(String, String), RollupBucket> = BTreeMap::new();

        let focus_rows = sqlx::query(
            r#"
SELECT process_name, display_name, started_at, ended_at, last_seen_at
FROM focus_segments
"#,
        )
        .fetch_all(&self.pool)
        .await?;
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
                &self.timezone_snapshot(),
                true,
            )?;
        }

        let browser_rows = sqlx::query(
            r#"
SELECT domain, started_at, ended_at, last_seen_at
FROM browser_segments
"#,
        )
        .fetch_all(&self.pool)
        .await?;
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
                &self.timezone_snapshot(),
                true,
            )?;
        }

        let presence_rows = sqlx::query(
            r#"
SELECT state, started_at, ended_at, last_seen_at
FROM presence_segments
"#,
        )
        .fetch_all(&self.pool)
        .await?;
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
                &self.timezone_snapshot(),
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
        .bind(&updated_at)
        .execute(&mut *tx)
        .await?;
        upsert_rollup_metadata_tx(
            &mut tx,
            "daily_rollup_timezone",
            &self.timezone_id(),
            &updated_at,
        )
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
        for chunk in self.split_interval_by_local_day(start, end)? {
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
        for chunk in self.split_interval_by_local_day(start, end)? {
            upsert_daily_app_usage_tx(tx, &chunk.date, process_name, display_name, 0, 1).await?;
        }
        Ok(())
    }

    async fn add_active_app_usage_seconds_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        process_name: &str,
        display_name: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
        count_segment: bool,
    ) -> Result<()> {
        let intervals = active_overlaps_tx(tx, start, end).await?;
        for (index, (overlap_start, overlap_end)) in intervals.into_iter().enumerate() {
            for chunk in self.split_interval_by_local_day(overlap_start, overlap_end)? {
                upsert_daily_active_app_usage_tx(
                    tx,
                    &chunk.date,
                    process_name,
                    display_name,
                    chunk.seconds,
                    i64::from(count_segment && index == 0),
                )
                .await?;
            }
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
        for chunk in self.split_interval_by_local_day(start, end)? {
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
        for chunk in self.split_interval_by_local_day(start, end)? {
            upsert_daily_domain_usage_tx(tx, &chunk.date, domain, 0, 1).await?;
        }
        Ok(())
    }

    async fn add_active_domain_usage_seconds_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        domain: &str,
        start: OffsetDateTime,
        end: OffsetDateTime,
        count_segment: bool,
    ) -> Result<()> {
        let intervals = active_overlaps_tx(tx, start, end).await?;
        for (index, (overlap_start, overlap_end)) in intervals.into_iter().enumerate() {
            for chunk in self.split_interval_by_local_day(overlap_start, overlap_end)? {
                upsert_daily_active_domain_usage_tx(
                    tx,
                    &chunk.date,
                    domain,
                    chunk.seconds,
                    i64::from(count_segment && index == 0),
                )
                .await?;
            }
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
        for chunk in self.split_interval_by_local_day(start, end)? {
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
        for chunk in self.split_interval_by_local_day(start, end)? {
            upsert_daily_presence_usage_tx(tx, &chunk.date, state, 0, 1).await?;
        }
        Ok(())
    }

    pub async fn read_day_timeline(
        &self,
        date: Date,
        _timezone: UtcOffset,
        open_segment_grace: Duration,
    ) -> Result<TimelineDayResponse> {
        let (day_start_utc, day_end_utc) = self.day_bounds(date)?;
        let response_offset = self.local_offset_at(day_start_utc)?;
        let now_utc = OffsetDateTime::now_utc();
        let day_start_text = format_time(day_start_utc)?;
        let day_end_text = format_time(day_end_utc)?;
        let now_text = format_time(now_utc)?;

        let focus_rows = sqlx::query(
            r#"
SELECT *
FROM (
    SELECT id, process_name, display_name, exe_path, window_title, is_browser, started_at, ended_at, last_seen_at
    FROM focus_segments INDEXED BY idx_focus_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, process_name, display_name, exe_path, window_title, is_browser, started_at, ended_at, last_seen_at
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
        .fetch_all(&self.pool)
        .await?;

        let browser_rows = sqlx::query(
            r#"
SELECT *
FROM (
    SELECT id, domain, page_title, browser_window_id, tab_id, started_at, ended_at, last_seen_at
    FROM browser_segments INDEXED BY idx_browser_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, domain, page_title, browser_window_id, tab_id, started_at, ended_at, last_seen_at
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
        .fetch_all(&self.pool)
        .await?;

        let presence_rows = sqlx::query(
            r#"
SELECT *
FROM (
    SELECT id, state, started_at, ended_at, last_seen_at
    FROM presence_segments INDEXED BY idx_presence_segments_ended_started
    WHERE ended_at > ? AND started_at < ?

    UNION ALL

    SELECT id, state, started_at, ended_at, last_seen_at
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
        .fetch_all(&self.pool)
        .await?;

        let mut focus_segments = Vec::new();
        for row in focus_rows {
            let (started_at, ended_at) = parse_segment_bounds(
                &row,
                now_utc,
                day_start_utc,
                day_end_utc,
                open_segment_grace,
            )?;

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
            let (started_at, ended_at) = parse_segment_bounds(
                &row,
                now_utc,
                day_start_utc,
                day_end_utc,
                open_segment_grace,
            )?;

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
            let (started_at, ended_at) = parse_segment_bounds(
                &row,
                now_utc,
                day_start_utc,
                day_end_utc,
                open_segment_grace,
            )?;

            presence_segments.push(PresenceSegment {
                id: row.get("id"),
                state: parse_presence_state(row.get::<String, _>("state").as_str())?,
                started_at,
                ended_at: Some(ended_at),
            });
        }

        Ok(TimelineDayResponse {
            date: date.to_string(),
            timezone: response_offset.to_string(),
            focus_segments,
            browser_segments,
            presence_segments,
        })
    }

    pub async fn read_app_stats(
        &self,
        date: Date,
        _timezone: UtcOffset,
    ) -> Result<Vec<DurationStat>> {
        let mut buckets: BTreeMap<String, (String, i64, i64)> = BTreeMap::new();
        let rows = sqlx::query(
            r#"
SELECT raw.process_name, raw.display_name, raw.seconds,
       COALESCE(active.seconds, 0) AS active_seconds
FROM daily_app_usage raw
LEFT JOIN daily_active_app_usage active
  ON active.date = raw.date AND active.process_name = raw.process_name
WHERE raw.date = ?
ORDER BY active_seconds DESC, raw.seconds DESC
"#,
        )
        .bind(date.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut total_seconds = 0;
        let mut total_active_seconds = 0;
        for row in rows {
            let seconds = row.get::<i64, _>("seconds");
            let active_seconds = row.get::<i64, _>("active_seconds");
            total_seconds += seconds;
            total_active_seconds += active_seconds;
            buckets.insert(
                row.get::<String, _>("process_name"),
                (
                    row.get::<String, _>("display_name"),
                    seconds,
                    active_seconds,
                ),
            );
        }

        Ok(to_duration_stats(
            buckets,
            total_seconds,
            total_active_seconds,
        ))
    }

    pub async fn read_domain_stats(
        &self,
        date: Date,
        _timezone: UtcOffset,
    ) -> Result<Vec<DurationStat>> {
        let mut buckets: BTreeMap<String, (String, i64, i64)> = BTreeMap::new();
        let rows = sqlx::query(
            r#"
SELECT raw.domain, raw.seconds, COALESCE(active.seconds, 0) AS active_seconds
FROM daily_domain_usage raw
LEFT JOIN daily_active_domain_usage active
  ON active.date = raw.date AND active.domain = raw.domain
WHERE raw.date = ?
ORDER BY active_seconds DESC, raw.seconds DESC
"#,
        )
        .bind(date.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut total_seconds = 0;
        let mut total_active_seconds = 0;
        for row in rows {
            let domain = row.get::<String, _>("domain");
            let seconds = row.get::<i64, _>("seconds");
            let active_seconds = row.get::<i64, _>("active_seconds");
            total_seconds += seconds;
            total_active_seconds += active_seconds;
            buckets.insert(domain.clone(), (domain, seconds, active_seconds));
        }

        Ok(to_duration_stats(
            buckets,
            total_seconds,
            total_active_seconds,
        ))
    }

    pub async fn read_focus_stats(
        &self,
        date: Date,
        timezone: UtcOffset,
        open_segment_grace: Duration,
    ) -> Result<FocusStats> {
        let timeline = self
            .read_day_timeline(date, timezone, open_segment_grace)
            .await?;
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

        let mut active_focus_lengths = Vec::new();
        let mut active_switch_count = 0;
        for presence in timeline
            .presence_segments
            .iter()
            .filter(|segment| matches!(segment.state, PresenceState::Active))
        {
            let mut previous_process: Option<&str> = None;
            let presence_end = presence.ended_at.unwrap_or(presence.started_at);
            for focus in &timeline.focus_segments {
                let focus_end = focus.ended_at.unwrap_or(focus.started_at);
                let start = std::cmp::max(focus.started_at, presence.started_at);
                let end = std::cmp::min(focus_end, presence_end);
                if end > start {
                    active_focus_lengths.push((end - start).whole_seconds());
                    if previous_process.is_some_and(|previous| {
                        !previous.eq_ignore_ascii_case(&focus.app.process_name)
                    }) {
                        active_switch_count += 1;
                    }
                    previous_process = Some(&focus.app.process_name);
                }
            }
        }
        let active_foreground_seconds = active_focus_lengths.iter().sum::<i64>();
        let longest_active_block_seconds = active_focus_lengths.iter().copied().max().unwrap_or(0);
        let average_active_block_seconds = if active_focus_lengths.is_empty() {
            0
        } else {
            active_foreground_seconds / active_focus_lengths.len() as i64
        };

        Ok(FocusStats {
            total_focus_seconds,
            total_active_seconds,
            switch_count: timeline.focus_segments.len().saturating_sub(1) as i64,
            longest_focus_block_seconds,
            average_focus_block_seconds,
            foreground_seconds: total_focus_seconds,
            active_foreground_seconds,
            active_switch_count,
            longest_active_block_seconds,
            average_active_block_seconds,
        })
    }

    /// Aggregates a single day's segments into a compact summary for calendar
    /// and overview card display.
    pub async fn read_day_summary(&self, date: Date, timezone: UtcOffset) -> Result<DaySummary> {
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
        let active_app_seconds = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(SUM(seconds), 0) FROM daily_active_app_usage WHERE date = ?",
        )
        .bind(&date_text)
        .fetch_one(&self.pool)
        .await?;
        let active_browser_seconds = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(SUM(seconds), 0) FROM daily_active_domain_usage WHERE date = ?",
        )
        .bind(&date_text)
        .fetch_one(&self.pool)
        .await?;
        let active_switch_count = self
            .read_focus_stats(date, timezone, Duration::ZERO)
            .await?
            .active_switch_count;

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
            active_app_seconds,
            active_browser_seconds,
            active_switch_count,
            top_app,
            top_domain,
        })
    }

    /// Returns daily summaries for every day in the given month. Duration fields
    /// use range rollup queries; active switches use two ordered raw-segment range
    /// queries so idle-time app changes are not misreported as active switches.
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
                    active_app_seconds: 0,
                    active_browser_seconds: 0,
                    active_switch_count: 0,
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

        let active_app_rows = sqlx::query(
            "SELECT date, seconds FROM daily_active_app_usage WHERE date >= ? AND date <= ?",
        )
        .bind(&start_text)
        .bind(&end_text)
        .fetch_all(&self.pool)
        .await?;
        for row in active_app_rows {
            if let Some(summary) = summaries.get_mut(&row.get::<String, _>("date")) {
                summary.active_app_seconds += row.get::<i64, _>("seconds");
            }
        }
        let active_domain_rows = sqlx::query(
            "SELECT date, seconds FROM daily_active_domain_usage WHERE date >= ? AND date <= ?",
        )
        .bind(&start_text)
        .bind(&end_text)
        .fetch_all(&self.pool)
        .await?;
        for row in active_domain_rows {
            if let Some(summary) = summaries.get_mut(&row.get::<String, _>("date")) {
                summary.active_browser_seconds += row.get::<i64, _>("seconds");
            }
        }

        for (date, count) in self.read_active_switch_counts(first_day, last_day).await? {
            if let Some(summary) = summaries.get_mut(&date) {
                summary.active_switch_count = count;
            }
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
            active_rollup_status: self.active_rollup_status().await?,
        })
    }

    async fn read_active_switch_counts(
        &self,
        first_day: Date,
        last_day: Date,
    ) -> Result<BTreeMap<String, i64>> {
        let range_start = self.day_bounds(first_day)?.0;
        let range_end = self.day_bounds(last_day)?.1;
        let range_start_text = format_time(range_start)?;
        let range_end_text = format_time(range_end)?;

        let focus_rows = sqlx::query(
            r#"
SELECT process_name, started_at,
       COALESCE(ended_at, last_seen_at, started_at) AS effective_end
FROM focus_segments
WHERE started_at < ?
  AND COALESCE(ended_at, last_seen_at, started_at) > ?
ORDER BY started_at
"#,
        )
        .bind(&range_end_text)
        .bind(&range_start_text)
        .fetch_all(&self.pool)
        .await?;
        let mut focus_intervals = Vec::with_capacity(focus_rows.len());
        for row in focus_rows {
            focus_intervals.push((
                row.get::<String, _>("process_name"),
                parse_time(row.get::<String, _>("started_at").as_str())?,
                parse_time(row.get::<String, _>("effective_end").as_str())?,
            ));
        }

        let active_rows = sqlx::query(
            r#"
SELECT started_at, COALESCE(ended_at, last_seen_at, started_at) AS effective_end
FROM presence_segments
WHERE state = 'active'
  AND started_at < ?
  AND COALESCE(ended_at, last_seen_at, started_at) > ?
ORDER BY started_at
"#,
        )
        .bind(&range_end_text)
        .bind(&range_start_text)
        .fetch_all(&self.pool)
        .await?;
        let mut active_intervals = Vec::with_capacity(active_rows.len());
        for row in active_rows {
            active_intervals.push((
                parse_time(row.get::<String, _>("started_at").as_str())?,
                parse_time(row.get::<String, _>("effective_end").as_str())?,
            ));
        }

        let mut counts = BTreeMap::new();
        let mut date = first_day;
        while date <= last_day {
            let (day_start, day_end) = self.day_bounds(date)?;
            let mut count = 0;
            for (presence_start, presence_end) in &active_intervals {
                let active_start = std::cmp::max(day_start, *presence_start);
                let active_end = std::cmp::min(day_end, *presence_end);
                if active_end <= active_start {
                    continue;
                }

                let mut previous_process: Option<&str> = None;
                for (process_name, focus_start, focus_end) in &focus_intervals {
                    if *focus_start >= active_end {
                        break;
                    }
                    if *focus_end <= active_start {
                        continue;
                    }
                    if previous_process
                        .is_some_and(|previous| !previous.eq_ignore_ascii_case(process_name))
                    {
                        count += 1;
                    }
                    previous_process = Some(process_name);
                }
            }
            counts.insert(date.to_string(), count);
            date = date.next_day().context("calendar date overflow")?;
        }

        Ok(counts)
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
            foreground_seconds: today_summary.focus_seconds,
            active_foreground_seconds: today_summary.active_app_seconds,
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
            active_rollup_status: self.active_rollup_status().await?,
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
        let active_foreground_seconds: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(seconds), 0) FROM daily_active_app_usage WHERE date >= ? AND date <= ?",
        )
        .bind(start.to_string())
        .bind(end.to_string())
        .fetch_one(&self.pool)
        .await?;

        Ok(PeriodStat {
            focus_seconds,
            active_seconds,
            foreground_seconds: focus_seconds,
            active_foreground_seconds,
        })
    }

    pub async fn read_app_usage_trend(
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
SELECT date, process_name, display_name, seconds
FROM daily_app_usage
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
        let active_rows = sqlx::query(
            r#"
SELECT date, process_name, display_name, seconds
FROM daily_active_app_usage
WHERE date >= ? AND date <= ? AND seconds > 0
ORDER BY date ASC
"#,
        )
        .bind(start_date.to_string())
        .bind(end_date.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut active_totals: BTreeMap<String, i64> = BTreeMap::new();
        let mut active_values: BTreeMap<(String, String), i64> = BTreeMap::new();
        for row in active_rows {
            let date = row.get::<String, _>("date");
            let key = row.get::<String, _>("process_name");
            let label = row.get::<String, _>("display_name");
            let seconds = row.get::<i64, _>("seconds");
            *active_totals.entry(key.clone()).or_default() += seconds;
            active_values.insert((key.clone(), date), seconds);
            totals.entry(key).or_insert((label, 0));
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
                let mut active_daily_seconds = vec![0; days.len()];
                for ((candidate_key, date), seconds) in &values {
                    if candidate_key == &key
                        && let Some(index) = day_index.get(date)
                    {
                        daily_seconds[*index] = *seconds;
                    }
                }
                for ((candidate_key, date), seconds) in &active_values {
                    if candidate_key == &key
                        && let Some(index) = day_index.get(date)
                    {
                        active_daily_seconds[*index] = *seconds;
                    }
                }

                AppUsageTrendSeries {
                    active_total_seconds: active_totals.get(&key).copied().unwrap_or(0),
                    key,
                    label,
                    total_seconds,
                    daily_seconds,
                    active_daily_seconds,
                }
            })
            .collect();

        Ok(AppUsageTrendResponse {
            period,
            start_date: start_date.to_string(),
            end_date: end_date.to_string(),
            timezone: self.timezone_id(),
            days: days.into_iter().map(|date| date.to_string()).collect(),
            series,
            active_rollup_status: self.active_rollup_status().await?,
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
        let mut schema_tx = self.pool.begin().await?;
        sqlx::query(
            r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
"#,
        )
        .execute(&mut *schema_tx)
        .await?;
        schema_tx.commit().await?;

        for migration in MIGRATIONS {
            let existing = sqlx::query("SELECT version FROM schema_migrations WHERE version = ?")
                .bind(migration.version)
                .fetch_optional(&self.pool)
                .await?;

            if existing.is_some() {
                continue;
            }

            self.apply_migration(migration).await?;
        }

        Ok(())
    }

    async fn apply_migration(&self, migration: &Migration) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::raw_sql(migration.sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
            .bind(migration.version)
            .bind(migration.name)
            .bind(format_time(OffsetDateTime::now_utc())?)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
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
    open_segment_grace: Duration,
) -> Result<(OffsetDateTime, OffsetDateTime)> {
    let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
    let ended_at = match row.get::<Option<String>, _>("ended_at") {
        Some(value) => parse_time(&value)?,
        None => {
            let last_seen_at = parse_optional_time(row.get::<Option<String>, _>("last_seen_at"))?
                .unwrap_or(started_at);
            std::cmp::min(now_utc, last_seen_at + open_segment_grace)
        }
    };

    Ok((
        clamp_start(started_at, day_start),
        clamp_end(ended_at, day_end, day_start),
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

fn parse_date(value: &str) -> Result<Date> {
    Date::parse(
        value,
        &time::format_description::parse("[year]-[month]-[day]")?,
    )
    .with_context(|| format!("invalid date: {}", value))
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
    timezone: &TimeZoneContext,
) -> Result<Vec<DailyChunk>> {
    if end <= start {
        return Ok(Vec::new());
    }

    let mut cursor = start.to_offset(UtcOffset::UTC);
    let end = end.to_offset(UtcOffset::UTC);
    let mut chunks = Vec::new();

    while cursor < end {
        let date = timezone.local_date(cursor)?;
        let (_, next_midnight) = timezone.day_bounds(date)?;
        if next_midnight <= cursor {
            return Err(anyhow!("time-zone day boundary did not advance"));
        }
        let chunk_end = std::cmp::min(next_midnight, end);
        let seconds = (chunk_end - cursor).whole_seconds().max(0);

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
    timezone: &TimeZoneContext,
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

async fn upsert_rollup_metadata_tx(
    tx: &mut Transaction<'_, Sqlite>,
    key: &str,
    value: &str,
    updated_at: &str,
) -> Result<()> {
    sqlx::query(
        r#"
INSERT INTO rollup_metadata(key, value, updated_at)
VALUES(?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
"#,
    )
    .bind(key)
    .bind(value)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_active_rollup_job_tx(
    tx: &mut Transaction<'_, Sqlite>,
    status: &str,
    completed_days: i64,
    total_days: i64,
    next_date: Option<&str>,
    last_error: Option<&str>,
    updated_at: &str,
) -> Result<()> {
    sqlx::query(
        r#"
INSERT INTO rollup_rebuild_jobs(
  key, status, next_date, completed_days, total_days, last_error, updated_at
)
VALUES('active_rollups', ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  status=excluded.status,
  next_date=excluded.next_date,
  completed_days=excluded.completed_days,
  total_days=excluded.total_days,
  last_error=excluded.last_error,
  updated_at=excluded.updated_at
"#,
    )
    .bind(status)
    .bind(next_date)
    .bind(completed_days)
    .bind(total_days)
    .bind(last_error)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;
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

async fn upsert_daily_active_app_usage_tx(
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
    sqlx::query(
        r#"
INSERT INTO daily_active_app_usage(date, process_name, display_name, seconds, segment_count, updated_at)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(date, process_name) DO UPDATE SET
  display_name=excluded.display_name,
  seconds=daily_active_app_usage.seconds + excluded.seconds,
  segment_count=daily_active_app_usage.segment_count + excluded.segment_count,
  updated_at=excluded.updated_at
"#,
    )
    .bind(date)
    .bind(process_name)
    .bind(display_name)
    .bind(seconds)
    .bind(segment_count)
    .bind(format_time(OffsetDateTime::now_utc())?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_daily_active_domain_usage_tx(
    tx: &mut Transaction<'_, Sqlite>,
    date: &str,
    domain: &str,
    seconds: i64,
    segment_count: i64,
) -> Result<()> {
    if seconds <= 0 && segment_count <= 0 {
        return Ok(());
    }
    sqlx::query(
        r#"
INSERT INTO daily_active_domain_usage(date, domain, seconds, segment_count, updated_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(date, domain) DO UPDATE SET
  seconds=daily_active_domain_usage.seconds + excluded.seconds,
  segment_count=daily_active_domain_usage.segment_count + excluded.segment_count,
  updated_at=excluded.updated_at
"#,
    )
    .bind(date)
    .bind(domain)
    .bind(seconds)
    .bind(segment_count)
    .bind(format_time(OffsetDateTime::now_utc())?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn intersect_active_intervals(
    start: OffsetDateTime,
    end: OffsetDateTime,
    active_intervals: &[(OffsetDateTime, OffsetDateTime)],
) -> Vec<(OffsetDateTime, OffsetDateTime)> {
    if end <= start {
        return Vec::new();
    }
    active_intervals
        .iter()
        .skip_while(|(_, active_end)| *active_end <= start)
        .take_while(|(active_start, _)| *active_start < end)
        .filter_map(|(active_start, active_end)| {
            let overlap_start = std::cmp::max(start, *active_start);
            let overlap_end = std::cmp::min(end, *active_end);
            (overlap_end > overlap_start).then_some((overlap_start, overlap_end))
        })
        .collect()
}

fn csv_row(values: &[&str]) -> String {
    let mut row = values
        .iter()
        .map(|value| format!("\"{}\"", value.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",");
    row.push_str("\r\n");
    row
}

fn build_stored_zip(files: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    let mut archive = Vec::new();
    let mut entries = Vec::with_capacity(files.len());

    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let name_len = u16::try_from(name_bytes.len()).context("ZIP filename is too long")?;
        let size = u32::try_from(data.len()).context("CSV export exceeds ZIP32 size limit")?;
        let local_offset =
            u32::try_from(archive.len()).context("CSV export exceeds ZIP32 offset limit")?;
        let crc = crc32(data);

        push_u32(&mut archive, 0x0403_4b50);
        push_u16(&mut archive, 20);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u32(&mut archive, crc);
        push_u32(&mut archive, size);
        push_u32(&mut archive, size);
        push_u16(&mut archive, name_len);
        push_u16(&mut archive, 0);
        archive.extend_from_slice(name_bytes);
        archive.extend_from_slice(data);
        entries.push((*name, crc, size, local_offset));
    }

    let central_offset =
        u32::try_from(archive.len()).context("CSV export exceeds ZIP32 offset limit")?;
    for (name, crc, size, local_offset) in &entries {
        let name_bytes = name.as_bytes();
        let name_len = u16::try_from(name_bytes.len()).context("ZIP filename is too long")?;
        push_u32(&mut archive, 0x0201_4b50);
        push_u16(&mut archive, 20);
        push_u16(&mut archive, 20);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u32(&mut archive, *crc);
        push_u32(&mut archive, *size);
        push_u32(&mut archive, *size);
        push_u16(&mut archive, name_len);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u16(&mut archive, 0);
        push_u32(&mut archive, 0);
        push_u32(&mut archive, *local_offset);
        archive.extend_from_slice(name_bytes);
    }
    let central_size = u32::try_from(archive.len())
        .context("CSV export exceeds ZIP32 size limit")?
        .checked_sub(central_offset)
        .context("invalid ZIP central directory size")?;
    let entry_count = u16::try_from(entries.len()).context("too many CSV files in export")?;
    push_u32(&mut archive, 0x0605_4b50);
    push_u16(&mut archive, 0);
    push_u16(&mut archive, 0);
    push_u16(&mut archive, entry_count);
    push_u16(&mut archive, entry_count);
    push_u32(&mut archive, central_size);
    push_u32(&mut archive, central_offset);
    push_u16(&mut archive, 0);

    Ok(archive)
}

fn push_u16(buffer: &mut Vec<u8>, value: u16) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

async fn delete_segment_range_tx(
    tx: &mut Transaction<'_, Sqlite>,
    table: &str,
    copied_columns: &str,
    start: &str,
    end: &str,
) -> Result<()> {
    let effective_end = "COALESCE(ended_at, last_seen_at, started_at)";

    // Preserve the right-hand side before shortening segments that span the
    // complete deletion interval. Table/column identifiers are fixed internal
    // constants supplied by delete_data, never request input.
    sqlx::query(&format!(
        r#"
INSERT INTO {table}(
  {copied_columns}, started_at, ended_at, last_seen_at, created_at
)
SELECT {copied_columns}, ?, effective_end, effective_end, created_at
FROM (
  SELECT *, {effective_end} AS effective_end
  FROM {table}
)
WHERE started_at < ? AND effective_end > ?
"#,
    ))
    .bind(end)
    .bind(start)
    .bind(end)
    .execute(&mut **tx)
    .await?;

    sqlx::query(&format!(
        "DELETE FROM {table} WHERE started_at >= ? AND started_at < ? AND {effective_end} <= ?",
    ))
    .bind(start)
    .bind(end)
    .bind(end)
    .execute(&mut **tx)
    .await?;

    sqlx::query(&format!(
        "UPDATE {table} SET ended_at = ?, last_seen_at = ? WHERE started_at < ? AND {effective_end} > ?",
    ))
    .bind(start)
    .bind(start)
    .bind(start)
    .bind(start)
    .execute(&mut **tx)
    .await?;

    sqlx::query(&format!(
        "UPDATE {table} SET started_at = ? WHERE started_at >= ? AND started_at < ? AND {effective_end} > ?",
    ))
    .bind(end)
    .bind(start)
    .bind(end)
    .bind(end)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn active_overlaps_tx(
    tx: &mut Transaction<'_, Sqlite>,
    start: OffsetDateTime,
    end: OffsetDateTime,
) -> Result<Vec<(OffsetDateTime, OffsetDateTime)>> {
    if end <= start {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        r#"
SELECT started_at, COALESCE(ended_at, last_seen_at, started_at) AS effective_end
FROM presence_segments
WHERE state = 'active'
  AND started_at < ?
  AND COALESCE(ended_at, last_seen_at, started_at) > ?
ORDER BY started_at
"#,
    )
    .bind(format_time(end)?)
    .bind(format_time(start)?)
    .fetch_all(&mut **tx)
    .await?;
    let mut intervals = Vec::with_capacity(rows.len());
    for row in rows {
        let active_start = parse_time(row.get::<String, _>("started_at").as_str())?;
        let active_end = parse_time(row.get::<String, _>("effective_end").as_str())?;
        let overlap_start = std::cmp::max(start, active_start);
        let overlap_end = std::cmp::min(end, active_end);
        if overlap_end > overlap_start {
            intervals.push((overlap_start, overlap_end));
        }
    }
    Ok(intervals)
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
        "paused" => Ok(PresenceState::Paused),
        other => Err(anyhow!("unknown presence state {}", other)),
    }
}

fn presence_label(value: &PresenceState) -> &'static str {
    match value {
        PresenceState::Active => "active",
        PresenceState::Idle => "idle",
        PresenceState::Locked => "locked",
        PresenceState::Paused => "paused",
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
    buckets: BTreeMap<String, (String, i64, i64)>,
    total_seconds: i64,
    total_active_seconds: i64,
) -> Vec<DurationStat> {
    let mut rows: Vec<_> = buckets
        .into_iter()
        .map(|(key, (label, seconds, active_seconds))| DurationStat {
            key,
            label,
            seconds,
            percentage: if total_seconds == 0 {
                0.0
            } else {
                (seconds as f64 / total_seconds as f64) * 100.0
            },
            active_seconds,
            active_percentage: if total_active_seconds == 0 {
                0.0
            } else {
                (active_seconds as f64 / total_active_seconds as f64) * 100.0
            },
        })
        .collect();

    rows.sort_by_key(|row| std::cmp::Reverse((row.active_seconds, row.seconds)));
    rows
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
    use super::{
        ACTIVE_ROLLUP_ALGORITHM_VERSION, AgentStore, AppConfig, Migration, format_time, parse_time,
    };
    use crate::windows::WindowsTimeZone;
    use common::{AppInfo, BrowserEventPayload, PresenceState};
    use sqlx::Row;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use time::{Duration, OffsetDateTime};

    #[tokio::test]
    async fn restore_unclosed_segments_uses_last_seen_at_instead_of_restart_time() {
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

    #[tokio::test]
    async fn failed_migration_rolls_back_schema_and_version() {
        let (store, database_path) = temp_store().await;
        let migration = Migration {
            version: 999,
            name: "atomic_failure_probe",
            sql: "CREATE TABLE migration_atomic_probe (id INTEGER); INSERT INTO missing_table VALUES (1);",
        };

        assert!(store.apply_migration(&migration).await.is_err());
        let table_exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_atomic_probe')",
        )
        .fetch_one(&store.pool)
        .await
        .expect("query table");
        let version_exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 999)",
        )
        .fetch_one(&store.pool)
        .await
        .expect("query version");

        assert_eq!(table_exists, 0);
        assert_eq!(version_exists, 0);
        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn segment_heartbeats_never_move_last_seen_backwards() {
        let (store, database_path) = temp_store().await;
        let started_at = parse_time("2026-06-17T01:00:00Z").expect("start");
        let newest = started_at + Duration::seconds(30);
        let stale = started_at + Duration::seconds(10);
        let id = store
            .start_presence_segment(PresenceState::Active, started_at)
            .await
            .expect("start presence");

        store
            .touch_presence_segment(id, newest)
            .await
            .expect("new heartbeat");
        store
            .touch_presence_segment(id, stale)
            .await
            .expect("stale heartbeat");

        let last_seen: String =
            sqlx::query_scalar("SELECT last_seen_at FROM presence_segments WHERE id = ?")
                .bind(id)
                .fetch_one(&store.pool)
                .await
                .expect("last seen");
        assert_eq!(parse_time(&last_seen).expect("parse last seen"), newest);
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
            )
            .await
            .expect("read app trend");

        assert_eq!(trend.series[0].key, "legacy.exe");
        assert_eq!(trend.series[0].total_seconds, 45 * 60);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn active_rollups_intersect_focus_and_browser_with_active_presence() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-17T01:00:00Z").expect("start");
        let app = AppInfo {
            process_name: "editor.exe".to_string(),
            display_name: "Editor".to_string(),
            exe_path: None,
            window_title: None,
            is_browser: true,
        };
        let focus = store
            .start_focus_segment(&app, start)
            .await
            .expect("start focus");
        store
            .end_focus_segment(focus, start + Duration::hours(1))
            .await
            .expect("end focus");
        let browser = store
            .start_browser_segment(
                &BrowserEventPayload {
                    domain: "example.com".to_string(),
                    page_title: None,
                    browser_window_id: 1,
                    tab_id: 2,
                    observed_at: None,
                },
                start,
            )
            .await
            .expect("start browser");
        store
            .end_browser_segment(browser, start + Duration::hours(1))
            .await
            .expect("end browser");

        for (state, offset, seconds) in [
            (PresenceState::Active, 0, 20 * 60),
            (PresenceState::Idle, 20 * 60, 10 * 60),
            (PresenceState::Active, 30 * 60, 10 * 60),
            (PresenceState::Paused, 40 * 60, 20 * 60),
        ] {
            let segment = store
                .start_presence_segment(state, start + Duration::seconds(offset))
                .await
                .expect("start presence");
            store
                .end_presence_segment(segment, start + Duration::seconds(offset + seconds))
                .await
                .expect("end presence");
        }

        store
            .rebuild_active_rollups()
            .await
            .expect("active rebuild");
        let date = time::Date::from_calendar_date(2026, time::Month::June, 17).expect("date");
        let apps = store
            .read_app_stats(date, time::UtcOffset::UTC)
            .await
            .expect("app stats");
        let domains = store
            .read_domain_stats(date, time::UtcOffset::UTC)
            .await
            .expect("domain stats");
        assert_eq!(apps[0].seconds, 60 * 60);
        assert_eq!(apps[0].active_seconds, 30 * 60);
        assert_eq!(domains[0].active_seconds, 30 * 60);
        assert_eq!(
            store.active_rollup_status().await.expect("status").status,
            "ready"
        );

        let exported = store
            .export_csv_archive(date, date)
            .await
            .expect("csv archive");
        assert_eq!(&exported[..4], &[0x50, 0x4b, 0x03, 0x04]);
        let archive_text = String::from_utf8_lossy(&exported);
        assert!(archive_text.contains("focus.csv"));
        assert!(archive_text.contains("\"editor.exe\""));
        assert!(archive_text.contains("presence.csv"));
        assert!(archive_text.contains("\"paused\""));
        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn active_rollup_rebuild_resumes_from_next_date() {
        let (store, database_path) = temp_store().await;
        let app = AppInfo {
            process_name: "resume.exe".to_string(),
            display_name: "Resume App".to_string(),
            exe_path: None,
            window_title: None,
            is_browser: false,
        };
        for started_at in ["2026-06-17T01:00:00Z", "2026-06-18T01:00:00Z"] {
            let start = parse_time(started_at).expect("start");
            let focus = store
                .start_focus_segment(&app, start)
                .await
                .expect("start focus");
            store
                .end_focus_segment(focus, start + Duration::hours(1))
                .await
                .expect("end focus");
            let presence = store
                .start_presence_segment(PresenceState::Active, start)
                .await
                .expect("start presence");
            store
                .end_presence_segment(presence, start + Duration::hours(1))
                .await
                .expect("end presence");
        }

        let updated_at = format_time(OffsetDateTime::now_utc()).expect("updated at");
        sqlx::query("DELETE FROM daily_active_app_usage")
            .execute(&store.pool)
            .await
            .expect("clear active apps");
        sqlx::query(
            r#"
INSERT INTO daily_active_app_usage(
  date, process_name, display_name, seconds, segment_count, updated_at
)
VALUES('2026-06-17', 'sentinel.exe', 'Already Rebuilt', 111, 1, ?)
"#,
        )
        .bind(&updated_at)
        .execute(&store.pool)
        .await
        .expect("insert completed day sentinel");
        let timezone = store.timezone_id();
        for (key, value) in [
            (
                "active_rollup_rebuild_version",
                ACTIVE_ROLLUP_ALGORITHM_VERSION,
            ),
            ("active_rollup_rebuild_timezone", timezone.as_str()),
        ] {
            sqlx::query("INSERT INTO rollup_metadata(key, value, updated_at) VALUES(?, ?, ?)")
                .bind(key)
                .bind(value)
                .bind(&updated_at)
                .execute(&store.pool)
                .await
                .expect("insert rebuild metadata");
        }
        sqlx::query(
            r#"
INSERT INTO rollup_rebuild_jobs(
  key, status, next_date, completed_days, total_days, last_error, updated_at
)
VALUES('active_rollups', 'running', '2026-06-18', 1, 2, NULL, ?)
"#,
        )
        .bind(&updated_at)
        .execute(&store.pool)
        .await
        .expect("insert interrupted job");

        sqlx::query(
            "UPDATE focus_segments SET ended_at = 'invalid', last_seen_at = 'invalid' WHERE started_at = '2026-06-18T01:00:00Z'",
        )
        .execute(&store.pool)
        .await
        .expect("inject date rebuild failure");
        assert!(store.ensure_active_rollups().await.is_err());
        let failed_status = store.active_rollup_status().await.expect("failed status");
        assert_eq!(failed_status.status, "failed");
        assert_eq!(failed_status.completed_days, 1);
        assert_eq!(failed_status.next_date.as_deref(), Some("2026-06-18"));

        sqlx::query(
            "UPDATE focus_segments SET ended_at = '2026-06-18T02:00:00Z', last_seen_at = '2026-06-18T02:00:00Z' WHERE started_at = '2026-06-18T01:00:00Z'",
        )
        .execute(&store.pool)
        .await
        .expect("repair date source row");
        store.ensure_active_rollups().await.expect("resume rebuild");

        let completed_day_seconds: i64 = sqlx::query_scalar(
            "SELECT seconds FROM daily_active_app_usage WHERE date = '2026-06-17' AND process_name = 'sentinel.exe'",
        )
        .fetch_one(&store.pool)
        .await
        .expect("completed day retained");
        let resumed_day_seconds: i64 = sqlx::query_scalar(
            "SELECT seconds FROM daily_active_app_usage WHERE date = '2026-06-18' AND process_name = 'resume.exe'",
        )
        .fetch_one(&store.pool)
        .await
        .expect("resumed day rebuilt");
        let status = store.active_rollup_status().await.expect("status");
        assert_eq!(completed_day_seconds, 111);
        assert_eq!(resumed_day_seconds, 60 * 60);
        assert_eq!(status.status, "ready");
        assert_eq!(status.completed_days, 2);
        assert_eq!(status.total_days, 2);
        assert_eq!(status.next_date, None);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn range_delete_splits_segments_and_preserves_outside_data() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-16T23:00:00Z").expect("start");
        let end = parse_time("2026-06-18T01:00:00Z").expect("end");
        let app = AppInfo {
            process_name: "cross-day.exe".to_string(),
            display_name: "Cross Day".to_string(),
            exe_path: None,
            window_title: None,
            is_browser: true,
        };
        let focus = store
            .start_focus_segment(&app, start)
            .await
            .expect("start focus");
        store
            .end_focus_segment(focus, end)
            .await
            .expect("end focus");
        let browser = store
            .start_browser_segment(
                &BrowserEventPayload {
                    domain: "cross-day.example".to_string(),
                    page_title: None,
                    browser_window_id: 1,
                    tab_id: 1,
                    observed_at: None,
                },
                start,
            )
            .await
            .expect("start browser");
        store
            .end_browser_segment(browser, end)
            .await
            .expect("end browser");
        let presence = store
            .start_presence_segment(PresenceState::Active, start)
            .await
            .expect("start presence");
        store
            .end_presence_segment(presence, end)
            .await
            .expect("end presence");

        let deleted_date =
            time::Date::from_calendar_date(2026, time::Month::June, 17).expect("date");
        store
            .delete_data(Some(deleted_date), Some(deleted_date), false)
            .await
            .expect("delete middle date");

        let rows =
            sqlx::query("SELECT started_at, ended_at FROM focus_segments ORDER BY started_at")
                .fetch_all(&store.pool)
                .await
                .expect("read split focus");
        let bounds = rows
            .iter()
            .map(|row| {
                (
                    row.get::<String, _>("started_at"),
                    row.get::<String, _>("ended_at"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            bounds,
            vec![
                (
                    "2026-06-16T23:00:00Z".to_string(),
                    "2026-06-17T00:00:00Z".to_string(),
                ),
                (
                    "2026-06-18T00:00:00Z".to_string(),
                    "2026-06-18T01:00:00Z".to_string(),
                ),
            ]
        );

        let deleted_summary = store
            .read_day_summary(deleted_date, time::UtcOffset::UTC)
            .await
            .expect("deleted day summary");
        let before_summary = store
            .read_day_summary(
                time::Date::from_calendar_date(2026, time::Month::June, 16).expect("before date"),
                time::UtcOffset::UTC,
            )
            .await
            .expect("before summary");
        let after_summary = store
            .read_day_summary(
                time::Date::from_calendar_date(2026, time::Month::June, 18).expect("after date"),
                time::UtcOffset::UTC,
            )
            .await
            .expect("after summary");
        assert_eq!(deleted_summary.focus_seconds, 0);
        assert_eq!(before_summary.focus_seconds, 60 * 60);
        assert_eq!(after_summary.focus_seconds, 60 * 60);
        assert_eq!(before_summary.active_app_seconds, 60 * 60);
        assert_eq!(after_summary.active_app_seconds, 60 * 60);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn daily_rollups_follow_windows_dst_day_boundaries() {
        let unique = format!(
            "timeline-dst-test-{}.sqlite",
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let database_path = std::env::temp_dir().join(unique);
        let config = AppConfig {
            database_path: database_path.clone(),
            lockfile_path: temp_lock_path(&database_path),
            ..AppConfig::default()
        };
        let timezone =
            WindowsTimeZone::from_id("Pacific Standard Time").expect("load Pacific Standard Time");
        let store = AgentStore::connect(&config, timezone.clone())
            .await
            .expect("connect DST store");
        let app = AppInfo {
            process_name: "dst.exe".to_string(),
            display_name: "DST App".to_string(),
            exe_path: None,
            window_title: None,
            is_browser: false,
        };

        for (date, expected_hours) in [
            (
                time::Date::from_calendar_date(2026, time::Month::March, 8).expect("spring date"),
                23,
            ),
            (
                time::Date::from_calendar_date(2026, time::Month::November, 1).expect("fall date"),
                25,
            ),
        ] {
            let (start, end) = timezone.day_bounds(date).expect("DST day bounds");
            let presence = store
                .start_presence_segment(PresenceState::Active, start)
                .await
                .expect("start presence");
            let focus = store
                .start_focus_segment(&app, start)
                .await
                .expect("start focus");
            store
                .end_focus_segment(focus, end)
                .await
                .expect("end focus");
            store
                .end_presence_segment(presence, end)
                .await
                .expect("end presence");

            let summary = store
                .read_day_summary(date, time::UtcOffset::UTC)
                .await
                .expect("raw DST summary");
            assert_eq!(summary.focus_seconds, expected_hours * 60 * 60);
            assert_eq!(summary.active_seconds, expected_hours * 60 * 60);
        }

        store
            .rebuild_active_rollups()
            .await
            .expect("rebuild DST active rollups");
        for (date, expected_hours) in [
            (
                time::Date::from_calendar_date(2026, time::Month::March, 8).expect("spring date"),
                23,
            ),
            (
                time::Date::from_calendar_date(2026, time::Month::November, 1).expect("fall date"),
                25,
            ),
        ] {
            let summary = store
                .read_day_summary(date, time::UtcOffset::UTC)
                .await
                .expect("active DST summary");
            assert_eq!(summary.active_app_seconds, expected_hours * 60 * 60);
        }

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn active_switches_ignore_app_changes_during_idle() {
        let (store, database_path) = temp_store().await;
        let start = parse_time("2026-06-17T01:00:00Z").expect("start");
        for (process_name, display_name, offset_minutes, duration_minutes) in [
            ("a.exe", "A", 0, 10),
            ("b.exe", "B", 10, 20),
            ("c.exe", "C", 30, 10),
        ] {
            let app = AppInfo {
                process_name: process_name.to_string(),
                display_name: display_name.to_string(),
                exe_path: None,
                window_title: None,
                is_browser: false,
            };
            let segment_start = start + Duration::minutes(offset_minutes);
            let segment = store
                .start_focus_segment(&app, segment_start)
                .await
                .expect("start focus");
            store
                .end_focus_segment(segment, segment_start + Duration::minutes(duration_minutes))
                .await
                .expect("end focus");
        }
        for (state, offset_minutes, duration_minutes) in [
            (PresenceState::Active, 0, 10),
            (PresenceState::Idle, 10, 10),
            (PresenceState::Active, 20, 20),
        ] {
            let segment_start = start + Duration::minutes(offset_minutes);
            let segment = store
                .start_presence_segment(state, segment_start)
                .await
                .expect("start presence");
            store
                .end_presence_segment(segment, segment_start + Duration::minutes(duration_minutes))
                .await
                .expect("end presence");
        }

        let stats = store
            .read_focus_stats(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("date"),
                time::UtcOffset::UTC,
                Duration::seconds(4),
            )
            .await
            .expect("focus stats");
        assert_eq!(stats.switch_count, 2);
        assert_eq!(stats.active_foreground_seconds, 30 * 60);
        assert_eq!(stats.active_switch_count, 1);
        let summary = store
            .read_day_summary(
                time::Date::from_calendar_date(2026, time::Month::June, 17).expect("date"),
                time::UtcOffset::UTC,
            )
            .await
            .expect("day summary");
        assert_eq!(summary.active_switch_count, 1);
        let calendar = store
            .read_month_calendar(2026, time::Month::June, time::UtcOffset::UTC)
            .await
            .expect("month calendar");
        let calendar_day = calendar
            .days
            .iter()
            .find(|day| day.date == "2026-06-17")
            .expect("calendar day");
        assert_eq!(calendar_day.active_switch_count, 1);

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn online_backup_records_last_backup_time() {
        let (store, database_path) = temp_store().await;
        let backup_path = store.create_online_backup().await.expect("create backup");

        assert!(backup_path.is_file());
        assert!(store.last_backup_at().await.expect("last backup").is_some());

        let _ = std::fs::remove_file(backup_path);
        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn recent_picker_values_use_exact_app_and_domain_keys() {
        let (store, database_path) = temp_store().await;
        let now = OffsetDateTime::now_utc();
        store
            .upsert_app_registry("Code.exe", "Visual Studio Code", now)
            .await
            .expect("upsert app");
        let browser = common::BrowserEventPayload {
            domain: "example.com".to_string(),
            page_title: None,
            browser_window_id: 1,
            tab_id: 2,
            observed_at: None,
        };
        let browser_id = store
            .start_browser_segment(&browser, now)
            .await
            .expect("start browser");
        store
            .end_browser_segment(browser_id, now + Duration::seconds(1))
            .await
            .expect("end browser");

        let apps = store.recent_apps(20).await.expect("recent apps");
        let domains = store.recent_domains(20).await.expect("recent domains");
        assert_eq!(apps[0].key, "Code.exe");
        assert_eq!(apps[0].label, "Visual Studio Code");
        assert_eq!(domains[0].key, "example.com");

        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn retention_keeps_exact_number_of_local_dates() {
        let (store, database_path) = temp_store().await;
        let today = store
            .local_date_at(OffsetDateTime::now_utc())
            .expect("local today");
        let keep_from = today - Duration::days(29);
        let delete_date = keep_from.previous_day().expect("previous day");

        for (process_name, date) in [("delete.exe", delete_date), ("keep.exe", keep_from)] {
            let start = store.day_bounds(date).expect("day bounds").0 + Duration::hours(12);
            let app = AppInfo {
                process_name: process_name.to_string(),
                display_name: process_name.to_string(),
                exe_path: None,
                window_title: None,
                is_browser: false,
            };
            let id = store
                .start_focus_segment(&app, start)
                .await
                .expect("start focus");
            store
                .end_focus_segment(id, start + Duration::minutes(5))
                .await
                .expect("end focus");
        }

        store.apply_retention(30).await.expect("apply retention");

        let deleted = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM focus_segments WHERE process_name = 'delete.exe'",
        )
        .fetch_one(&store.pool)
        .await
        .expect("deleted count");
        let kept = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM focus_segments WHERE process_name = 'keep.exe'",
        )
        .fetch_one(&store.pool)
        .await
        .expect("kept count");
        assert_eq!(deleted, 0);
        assert_eq!(kept, 1);

        let _ = std::fs::remove_file(database_path);
    }

    static TEST_DATABASE_COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn temp_store() -> (AgentStore, PathBuf) {
        let unique = format!(
            "timeline-test-{}-{}-{}.sqlite",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos(),
            TEST_DATABASE_COUNTER.fetch_add(1, Ordering::Relaxed),
        );
        let database_path = std::env::temp_dir().join(unique);
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

    fn temp_lock_path(database_path: &std::path::Path) -> PathBuf {
        database_path.with_extension("lock")
    }
}
