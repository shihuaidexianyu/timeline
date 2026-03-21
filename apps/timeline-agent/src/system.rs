//! Windows integration helpers for autostart, tray actions, and opening the web UI.

use crate::state::AgentState;
use anyhow::{Context, Result};
use std::process::Command;
use time::OffsetDateTime;
use tracing::{error, info, warn};
use tray_menu::{
    Divider, MouseButton, MouseButtonState, PopupMenu, TextEntry, TrayIconBuilder, TrayIconEvent,
};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

const AUTOSTART_REG_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE_NAME: &str = "TimelineAgent";

pub fn autostart_enabled() -> Result<bool> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(AUTOSTART_REG_PATH, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("failed to open HKCU Run key"),
    };

    Ok(key.get_value::<String, _>(AUTOSTART_VALUE_NAME).is_ok())
}

pub fn set_autostart_enabled(state: &AgentState, enabled: bool) -> Result<bool> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(AUTOSTART_REG_PATH)
        .context("failed to create HKCU Run key")?;

    if enabled {
        key.set_value(AUTOSTART_VALUE_NAME, &state.launch_command())
            .context("failed to write autostart registry value")?;
    } else {
        match key.delete_value(AUTOSTART_VALUE_NAME) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("failed to delete autostart registry value"),
        }
    }

    autostart_enabled()
}

pub fn open_frontend(url: &str) -> Result<()> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .with_context(|| format!("failed to open frontend url {}", url))?;

    Ok(())
}

pub fn spawn_tray(state: AgentState) {
    std::thread::spawn(move || {
        if let Err(error) = run_tray_loop(state) {
            error!(?error, "tray loop stopped");
        }
    });
}

fn run_tray_loop(state: AgentState) -> Result<()> {
    let _tray = TrayIconBuilder::new()
        .build()
        .context("failed to create tray icon")?;
    let receiver = TrayIconEvent::receiver();
    state.mark_tray_online_sync(OffsetDateTime::now_utc());
    info!("tray icon started");

    loop {
        if state.shutdown_requested() {
            break;
        }

        if let Ok(event) = receiver.recv_timeout(std::time::Duration::from_millis(100)) {
            state.mark_tray_online_sync(OffsetDateTime::now_utc());

            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    if let Err(error) = open_frontend(&state.config().web_ui_url) {
                        warn!(?error, "failed to open frontend from tray click");
                    }
                }
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    position,
                    ..
                } => {
                    let mut menu = PopupMenu::new();
                    menu.add(&TextEntry::of("open", "打开时间线"));
                    menu.add(&Divider);
                    menu.add(&TextEntry::of("quit", "退出"));

                    if let Some(id) = menu.popup(position) {
                        if id.0 == "open" {
                            if let Err(error) = open_frontend(&state.config().web_ui_url) {
                                warn!(?error, "failed to open frontend from tray menu");
                            }
                        } else if id.0 == "quit" {
                            state.request_shutdown();
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    Ok(())
}
