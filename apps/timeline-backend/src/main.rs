#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

//! Entry point for the Windows timeline agent that collects focus and presence data.

mod config;
mod db;
mod http;
mod state;
mod system;
mod trackers;
mod windows;

use crate::config::AppConfig;
use crate::db::AgentStore;
use crate::http::build_router;
use crate::state::AgentState;
use anyhow::{Context, Result, anyhow};
use fs2::FileExt;
use std::env;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::Duration;
use time::{OffsetDateTime, UtcOffset};
use tracing::{info, warn};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    let raw_args: Vec<String> = env::args().skip(1).collect();
    let result = run_backend_mode(&raw_args).await;

    if let Err(error) = &result {
        let friendly = friendly_startup_error(error);
        system::show_startup_error_dialog("Timeline 启动失败", &friendly);
    }

    result
}

/// Maps an `anyhow::Error` from the startup path to a user-facing Chinese
/// message with actionable recovery hints. Falls back to the full error
/// chain (`{error:#}`) for unexpected failures so no diagnostic info is lost.
fn friendly_startup_error(error: &anyhow::Error) -> String {
    let full = format!("{error:#}");
    let lower = full.to_lowercase();

    if lower.contains("another timeline instance is already running")
        || lower.contains("try_lock_exclusive")
    {
        return format!(
            "已有 Timeline 实例正在运行。\n\n如果确认没有其他实例，请删除锁文件后重试。\n\n技术详情：{full}"
        );
    }

    if lower.contains("failed to bind") || lower.contains("addrinuse") {
        return format!(
            "监听端口已被占用。请检查是否有其他 Timeline 实例或其他程序占用了同一端口。\n\n技术详情：{full}"
        );
    }

    if lower.contains("failed to parse") && lower.contains(".toml") {
        return format!(
            "配置文件格式错误，无法解析。请检查 TOML 语法后修正并重试。\n\n技术详情：{full}"
        );
    }

    if lower.contains("配置文件") && lower.contains("无效字段") {
        // Already a Chinese-facing validation message from AppConfig::validate.
        return full;
    }

    if lower.contains("failed to connect sqlite")
        || lower.contains("database")
        || lower.contains("sqlx")
    {
        return format!(
            "无法打开数据库文件。请确认数据目录可写、磁盘未满，且没有其他实例占用数据库。\n\n技术详情：{full}"
        );
    }

    if lower.contains("migration") {
        return format!("数据库迁移失败。可能是数据库文件损坏或版本不兼容。\n\n技术详情：{full}");
    }

    full
}

async fn run_backend_mode(backend_args: &[String]) -> Result<()> {
    if let Some(streak_secs) = parse_debug_trigger_health_reminder(backend_args) {
        system::show_break_reminder(streak_secs.max(60));
        std::thread::sleep(std::time::Duration::from_millis(1_200));
        return Ok(());
    }

    let explicit_config_path = parse_config_path(backend_args);
    let (config, config_path) = AppConfig::load(explicit_config_path)?;
    let _log_guard = init_tracing(&config);

    let timezone = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let started_at = OffsetDateTime::now_utc();
    let _lock = acquire_instance_lock(&config.lockfile_path)?;
    let store = AgentStore::connect(&config, timezone).await?;
    store.restore_unclosed_segments().await?;
    store.ensure_daily_rollups().await?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let state = AgentState::new(
        config.clone(),
        Some(config_path),
        store,
        started_at,
        timezone,
        shutdown_tx,
    );
    if let Err(error) = system::ensure_toast_shortcut_registered(&state) {
        warn!(
            ?error,
            "failed to register Start Menu shortcut for native toast notifications"
        );
    }
    trackers::spawn_trackers(state.clone());
    spawn_timezone_refresher(state.clone());
    if config.tray_enabled {
        system::spawn_tray(state.clone());
    }

    let listener = tokio::net::TcpListener::bind(&config.listen_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.listen_addr))?;

    info!(listen_addr = %config.listen_addr, "timeline agent started");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal(shutdown_rx))
        .await
        .context("axum server failed")?;

    Ok(())
}

/// Periodically refreshes the local timezone offset to handle DST transitions
/// and travel across zones. Runs every hour; exits when shutdown is requested.
fn spawn_timezone_refresher(state: AgentState) {
    tokio::spawn(async move {
        let mut shutdown_rx = state.shutdown_rx();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(3600)) => {
                    state.refresh_timezone();
                }
                _ = shutdown_rx.changed() => {
                    break;
                }
            }
        }
    });
}

/// Initializes tracing with optional daily-rotating file logging.
///
/// Returns a `WorkerGuard` that must be kept alive for the entire process lifetime;
/// dropping it flushes and closes the non-blocking file writer. In release builds
/// the process has no console (`windows_subsystem = "windows"`), so file logging
/// is the only way to diagnose issues after the fact.
fn init_tracing(config: &AppConfig) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        if config.debug {
            EnvFilter::new("timeline=debug,info")
        } else {
            EnvFilter::new("info")
        }
    });

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_thread_names(config.debug)
        .compact();

    if !config.log_to_file {
        tracing_subscriber::registry()
            .with(filter)
            .with(stdout_layer)
            .init();
        return None;
    }

    let log_dir = config.log_dir.as_path();
    if let Err(error) = std::fs::create_dir_all(log_dir) {
        // Fall back to stdout-only if we cannot create the log directory; failing
        // to start the agent entirely just because logs are unavailable is too harsh.
        eprintln!(
            "warning: failed to create log dir {:?}: {error}; falling back to stdout only",
            log_dir
        );
        tracing_subscriber::registry()
            .with(filter)
            .with(stdout_layer)
            .init();
        return None;
    }

    // `rolling::daily` creates one file per day with a `YYYY-MM-DD` suffix and
    // never deletes old files. We prune stale logs after the subscriber is up.
    let file_appender = tracing_appender::rolling::daily(log_dir, "timeline.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false)
        .with_target(true)
        .compact();

    tracing_subscriber::registry()
        .with(filter)
        .with(stdout_layer)
        .with(file_layer)
        .init();

    prune_old_logs(log_dir, config.log_retention_days);
    info!(log_dir = %log_dir.display(), "file logging enabled");
    Some(guard)
}

/// Deletes log files older than `retention_days` from `log_dir`. Errors are
/// logged but never propagated — log cleanup must not prevent the agent from
/// starting or running.
fn prune_old_logs(log_dir: &Path, retention_days: u64) {
    if retention_days == 0 {
        return;
    }

    let cutoff = OffsetDateTime::now_utc() - time::Duration::days(retention_days as i64);
    let entries = match std::fs::read_dir(log_dir) {
        Ok(entries) => entries,
        Err(error) => {
            warn!(?error, ?log_dir, "failed to read log dir for pruning");
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("log")
            && !path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("timeline.log"))
                .unwrap_or(false)
        {
            continue;
        }

        let modified = match entry.metadata().and_then(|m| m.modified()) {
            Ok(time) => time,
            Err(_) => continue,
        };
        let modified_utc = OffsetDateTime::from(modified);

        if modified_utc < cutoff
            && let Err(error) = std::fs::remove_file(&path)
        {
            warn!(?error, ?path, "failed to delete stale log file");
        }
    }
}

fn parse_config_path(args: &[String]) -> Option<PathBuf> {
    let mut index = 0usize;
    while index < args.len() {
        if args[index] == "--config" {
            return args.get(index + 1).map(PathBuf::from);
        }
        index += 1;
    }

    None
}

fn parse_debug_trigger_health_reminder(args: &[String]) -> Option<i64> {
    let mut index = 0usize;
    while index < args.len() {
        if args[index] == "--debug-trigger-health-reminder" {
            return args
                .get(index + 1)
                .and_then(|value| value.parse::<i64>().ok())
                .or(Some(3_000));
        }
        index += 1;
    }

    None
}

fn acquire_instance_lock(lockfile_path: &PathBuf) -> Result<std::fs::File> {
    if let Some(parent) = lockfile_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lockfile_path)
        .with_context(|| format!("failed to open {:?}", lockfile_path))?;

    file.try_lock_exclusive()
        .map_err(|_| anyhow!("another timeline instance is already running"))?;

    Ok(file)
}

async fn shutdown_signal(mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = shutdown_rx.changed() => {},
    }

    info!("shutdown signal received");
}
