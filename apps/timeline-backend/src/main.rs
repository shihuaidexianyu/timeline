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
mod timezone;
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
use std::path::PathBuf;
use time::{OffsetDateTime, UtcOffset};
use timezone::TimeZoneContext;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let raw_args: Vec<String> = env::args().skip(1).collect();
    let result = run_backend_mode(&raw_args).await;

    if let Err(error) = &result {
        system::show_startup_error_dialog("Timeline 启动失败", &format!("{error:#}"));
    }

    result
}

async fn run_backend_mode(backend_args: &[String]) -> Result<()> {
    if let Some(streak_secs) = parse_debug_trigger_health_reminder(backend_args) {
        system::show_break_reminder_preview(streak_secs.max(60));
        std::thread::sleep(std::time::Duration::from_millis(1_200));
        return Ok(());
    }

    let explicit_config_path = parse_config_path(backend_args);
    let (config, config_path) = AppConfig::load(explicit_config_path)?;
    init_tracing(config.debug);

    let started_at = OffsetDateTime::now_utc();
    let timezone_context = TimeZoneContext::current_windows().unwrap_or_else(|error| {
        warn!(
            ?error,
            "failed to load Windows dynamic time zone; using fixed current offset"
        );
        TimeZoneContext::Fixed(UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC))
    });
    let timezone = timezone_context
        .offset_at(started_at)
        .unwrap_or_else(|_| UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC));
    let _lock = acquire_instance_lock(&config.lockfile_path)?;
    let store = AgentStore::connect(&config, timezone_context).await?;
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
    let active_rollup_store = state.store().clone();
    tokio::spawn(async move {
        if let Err(error) = active_rollup_store.ensure_active_rollups().await {
            warn!(?error, "failed to rebuild active rollups");
        }
    });
    let timezone_state = state.clone();
    tokio::spawn(async move {
        let mut shutdown = timezone_state.subscribe_shutdown();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(5 * 60)) => {
                    match timezone_state.store().refresh_windows_timezone() {
                        Ok(true) => {
                            info!(timezone = %timezone_state.store().timezone_id(), "Windows time zone changed; rebuilding daily rollups");
                            if let Err(error) = timezone_state.store().rebuild_daily_rollups().await {
                                warn!(?error, "failed to rebuild daily rollups after time-zone change");
                                continue;
                            }
                            if let Err(error) = timezone_state.store().rebuild_active_rollups().await {
                                warn!(?error, "failed to rebuild active rollups after time-zone change");
                            }
                        }
                        Ok(false) => {}
                        Err(error) => warn!(?error, "failed to refresh Windows time zone"),
                    }
                }
                _ = shutdown.changed() => return,
            }
        }
    });
    trackers::restore_tracking_pause(&state).await?;
    let maintenance_state = state.clone();
    tokio::spawn(async move {
        loop {
            match maintenance_state
                .store()
                .runtime_setting("retention_days")
                .await
            {
                Ok(Some(value)) => match value.parse::<u32>() {
                    Ok(days) => {
                        if let Err(error) = maintenance_state.store().apply_retention(days).await {
                            warn!(?error, "retention maintenance failed");
                        }
                    }
                    Err(error) => warn!(?error, "invalid persisted retention_days"),
                },
                Ok(None) => {}
                Err(error) => warn!(?error, "failed to read retention settings"),
            }
            let mut shutdown = maintenance_state.subscribe_shutdown();
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)) => {},
                _ = shutdown.changed() => return,
            }
        }
    });
    if let Err(error) = system::reconcile_autostart_command(&state) {
        warn!(?error, "failed to reconcile autostart command");
    }
    if let Err(error) = system::ensure_toast_shortcut_registered(&state) {
        warn!(
            ?error,
            "failed to register Start Menu shortcut for native toast notifications"
        );
    }
    trackers::spawn_trackers(state.clone());
    if config.tray_enabled {
        system::spawn_tray(state.clone());
    }

    let listener = tokio::net::TcpListener::bind(&config.listen_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.listen_addr))?;

    info!(listen_addr = %config.listen_addr, "timeline agent started");
    let serve_result = axum::serve(listener, build_router(state.clone()))
        .with_graceful_shutdown(shutdown_signal(state.clone(), shutdown_rx))
        .await;
    state.request_shutdown();
    if let Err(error) = trackers::shutdown_open_segments(&state).await {
        warn!(?error, "failed to close open segments during shutdown");
    }
    serve_result.context("axum server failed")?;

    Ok(())
}

fn init_tracing(debug: bool) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        if debug {
            EnvFilter::new("timeline=debug,info")
        } else {
            EnvFilter::new("info")
        }
    });

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_thread_names(debug)
        .compact()
        .init();
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

async fn shutdown_signal(state: AgentState, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = shutdown_rx.changed() => {},
    }

    state.request_shutdown();
    info!("shutdown signal received");
}
