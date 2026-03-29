#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

//! Entry point for the Windows timeline agent that collects focus and presence data.

mod config;
mod db;
mod http;
mod layout;
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
use std::process::Command;
use time::{OffsetDateTime, UtcOffset};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const BACKEND_MODE_FLAG: &str = "--backend";

enum StartupMode {
    Launcher { forwarded_args: Vec<String> },
    Backend { backend_args: Vec<String> },
    ApplyUpdate(updater::ApplyUpdateArgs),
}

#[tokio::main]
async fn main() -> Result<()> {
    let raw_args: Vec<String> = env::args().skip(1).collect();
    match parse_startup_mode(&raw_args)? {
        StartupMode::Launcher { forwarded_args } => run_launcher_mode(forwarded_args),
        StartupMode::Backend { backend_args } => run_backend_mode(&backend_args).await,
        StartupMode::ApplyUpdate(args) => updater::run_apply_update(args).await,
    }
}

fn parse_startup_mode(raw_args: &[String]) -> Result<StartupMode> {
    if raw_args
        .first()
        .is_some_and(|argument| argument == updater::APPLY_UPDATE_MODE_FLAG)
    {
        return Ok(StartupMode::ApplyUpdate(updater::parse_apply_update_args(
            &raw_args[1..],
        )?));
    }

    if let Some(index) = raw_args
        .iter()
        .position(|argument| argument == BACKEND_MODE_FLAG)
    {
        let mut backend_args = raw_args.to_vec();
        backend_args.remove(index);
        return Ok(StartupMode::Backend { backend_args });
    }

    Ok(StartupMode::Launcher {
        forwarded_args: raw_args.to_vec(),
    })
}

fn run_launcher_mode(forwarded_args: Vec<String>) -> Result<()> {
    let install_root = layout::resolve_install_root()?;
    let backend_executable = layout::resolve_backend_executable(&install_root)
        .or_else(|_| std::env::current_exe().context("failed to resolve launcher executable"))?;

    let mut child_args = Vec::with_capacity(forwarded_args.len() + 1);
    child_args.push(BACKEND_MODE_FLAG.to_string());
    child_args.extend(forwarded_args);

    let status = Command::new(&backend_executable)
        .args(child_args)
        .env(layout::INSTALL_ROOT_ENV, &install_root)
        .current_dir(&install_root)
        .status()
        .with_context(|| {
            format!(
                "failed to launch backend executable {:?}",
                backend_executable
            )
        })?;

    std::process::exit(status.code().unwrap_or(1));
}

async fn run_backend_mode(backend_args: &[String]) -> Result<()> {
    if let Some(streak_secs) = parse_debug_trigger_health_reminder(backend_args) {
        system::show_break_reminder(streak_secs.max(60));
        std::thread::sleep(std::time::Duration::from_millis(1_200));
        return Ok(());
    }

    let explicit_config_path = parse_config_path(backend_args);
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

async fn shutdown_signal(mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = shutdown_rx.changed() => {},
    }

    info!("shutdown signal received");
}
