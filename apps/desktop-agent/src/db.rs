//! SQLite initialization, migrations, writes, and read models for the desktop agent.

use crate::config::AppConfig;
use anyhow::{Context, Result, anyhow};
use common::{
    AppInfo, BrowserEventPayload, BrowserSegment, DebugEvent, DurationStat, FocusSegment,
    FocusStats, PresenceSegment, PresenceState, TimelineDayResponse,
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
];

impl AgentStore {
    pub async fn connect(config: &AppConfig) -> Result<Self> {
        config.ensure_parent_dirs()?;

        let connect_options = SqliteConnectOptions::from_str(
            config
                .database_path
                .to_str()
                .ok_or_else(|| anyhow!("database path is not valid UTF-8"))?,
        )?
        .create_if_missing(true);

        let pool = SqlitePool::connect_with(connect_options)
            .await
            .context("failed to connect sqlite")?;

        let store = Self { pool };
        store.run_migrations().await?;
        Ok(store)
    }

    pub async fn restore_unclosed_segments(&self, closed_at: OffsetDateTime) -> Result<()> {
        let closed_at = format_time(closed_at)?;
        sqlx::query("UPDATE focus_segments SET ended_at = ? WHERE ended_at IS NULL")
            .bind(&closed_at)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE browser_segments SET ended_at = ? WHERE ended_at IS NULL")
            .bind(&closed_at)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE presence_segments SET ended_at = ? WHERE ended_at IS NULL")
            .bind(&closed_at)
            .execute(&self.pool)
            .await?;

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
  created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?)
"#,
        )
        .bind(&app.process_name)
        .bind(&app.display_name)
        .bind(&app.exe_path)
        .bind(&app.window_title)
        .bind(if app.is_browser { 1 } else { 0 })
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn end_focus_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE focus_segments SET ended_at = ? WHERE id = ?")
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
            "INSERT INTO presence_segments (state, started_at, created_at) VALUES (?, ?, ?)",
        )
        .bind(presence_label(&state))
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn end_presence_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE presence_segments SET ended_at = ? WHERE id = ?")
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
  created_at
)
VALUES (?, ?, ?, ?, ?, ?)
"#,
        )
        .bind(&payload.domain)
        .bind(&payload.page_title)
        .bind(payload.browser_window_id)
        .bind(payload.tab_id)
        .bind(&observed_at)
        .bind(&observed_at)
        .execute(&self.pool)
        .await?;

        Ok(result.last_insert_rowid())
    }

    pub async fn end_browser_segment(&self, id: i64, observed_at: OffsetDateTime) -> Result<()> {
        let observed_at = format_time(observed_at)?;
        sqlx::query("UPDATE browser_segments SET ended_at = ? WHERE id = ?")
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
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = match row.get::<Option<String>, _>("ended_at") {
                Some(value) => Some(parse_time(&value)?),
                None => None,
            };

            focus_segments.push(FocusSegment {
                id: row.get("id"),
                started_at: clamp_start(started_at, day_start_utc),
                ended_at: Some(clamp_end(
                    ended_at.unwrap_or(now_utc),
                    day_end_utc,
                    day_start_utc,
                )),
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
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = match row.get::<Option<String>, _>("ended_at") {
                Some(value) => Some(parse_time(&value)?),
                None => None,
            };

            browser_segments.push(BrowserSegment {
                id: row.get("id"),
                domain: row.get("domain"),
                page_title: row.get("page_title"),
                browser_window_id: row.get("browser_window_id"),
                tab_id: row.get("tab_id"),
                started_at: clamp_start(started_at, day_start_utc),
                ended_at: Some(clamp_end(
                    ended_at.unwrap_or(now_utc),
                    day_end_utc,
                    day_start_utc,
                )),
            });
        }

        let mut presence_segments = Vec::new();
        for row in presence_rows {
            let started_at = parse_time(row.get::<String, _>("started_at").as_str())?;
            let ended_at = match row.get::<Option<String>, _>("ended_at") {
                Some(value) => Some(parse_time(&value)?),
                None => None,
            };

            presence_segments.push(PresenceSegment {
                id: row.get("id"),
                state: parse_presence_state(row.get::<String, _>("state").as_str())?,
                started_at: clamp_start(started_at, day_start_utc),
                ended_at: Some(clamp_end(
                    ended_at.unwrap_or(now_utc),
                    day_end_utc,
                    day_start_utc,
                )),
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

fn day_bounds(date: Date, timezone: UtcOffset) -> Result<(OffsetDateTime, OffsetDateTime)> {
    let start_local = PrimitiveDateTime::new(date, time::Time::MIDNIGHT).assume_offset(timezone);
    let end_local = start_local + Duration::days(1);
    Ok((
        start_local.to_offset(UtcOffset::UTC),
        end_local.to_offset(UtcOffset::UTC),
    ))
}

fn clamp_start(value: OffsetDateTime, min: OffsetDateTime) -> OffsetDateTime {
    if value < min { min } else { value }
}

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
