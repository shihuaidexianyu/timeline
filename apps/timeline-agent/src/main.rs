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
mod updater;
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
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(streak_secs) = parse_debug_trigger_health_reminder() {
        system::show_break_reminder(streak_secs.max(60));
        std::thread::sleep(std::time::Duration::from_millis(1_200));
        return Ok(());
    }

    let explicit_config_path = parse_config_path();
    let (config, config_path) = AppConfig::load(explicit_config_path)?;
    init_tracing(config.debug);

    let timezone = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let started_at = OffsetDateTime::now_utc();
    let _lock = acquire_instance_lock(&config.lockfile_path)?;
    let store = AgentStore::connect(&config).await?;
    store.restore_unclosed_segments().await?;
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

fn init_tracing(debug: bool) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        if debug {
            EnvFilter::new("timeline_agent=debug,info")
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

fn parse_config_path() -> Option<PathBuf> {
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--config" {
            return args.next().map(PathBuf::from);
        }
    }

    None
}

fn parse_debug_trigger_health_reminder() -> Option<i64> {
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--debug-trigger-health-reminder" {
            return args
                .next()
                .and_then(|value| value.parse::<i64>().ok())
                .or(Some(3_000));
        }
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
        .map_err(|_| anyhow!("another timeline-agent instance is already running"))?;

    Ok(file)
}

async fn shutdown_signal(mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = shutdown_rx.changed() => {},
    }

    info!("shutdown signal received");
}
