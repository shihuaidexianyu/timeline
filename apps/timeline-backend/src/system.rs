//! Windows integration helpers for autostart, tray actions, and opening the web UI.

use crate::state::AgentState;
use anyhow::{Context, Result};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
#[cfg(target_os = "windows")]
use tao::platform::windows::EventLoopBuilderExtWindows;
use time::OffsetDateTime;
use tracing::{error, info, warn};
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, accelerator::Accelerator},
};
use windows::Win32::Foundation::{HWND, PROPERTYKEY, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0, PropVariantClear,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemAlloc, CoUninitialize, IPersistFile,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{IShellLinkW, ShellExecuteW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{
    MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW, SW_SHOWNORMAL,
};
use windows::core::{GUID, Interface, PCWSTR, PWSTR};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winrt_notification::{Duration as ToastDuration, Sound, Toast};

const AUTOSTART_REG_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE_NAME: &str = "Timeline";
const MENU_OPEN_ID: &str = "open";
const MENU_QUIT_ID: &str = "quit";
const BREAK_REMINDER_TITLE: &str = "Timeline 健康提醒";
pub const TOAST_APP_USER_MODEL_ID: &str = "com.timeline";
const START_MENU_SHORTCUT_DIR: &str = "Timeline";
const START_MENU_SHORTCUT_NAME: &str = "Timeline.lnk";
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

enum TrayUserEvent {
    TrayClick {
        button: MouseButton,
        button_state: MouseButtonState,
    },
    Menu(MenuEvent),
}

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

/// Ensures a Start Menu shortcut exists with our AppUserModelID so Windows can
/// attribute native toast notifications to "Timeline" instead of PowerShell.
pub fn ensure_toast_shortcut_registered(state: &AgentState) -> Result<PathBuf> {
    let appdata = std::env::var_os("APPDATA")
        .context("APPDATA is unavailable; cannot register Start Menu shortcut")?;
    let shortcut_dir = PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join(START_MENU_SHORTCUT_DIR);
    std::fs::create_dir_all(&shortcut_dir)
        .with_context(|| format!("failed to create {:?}", shortcut_dir))?;

    let shortcut_path = shortcut_dir.join(START_MENU_SHORTCUT_NAME);
    let exe_path = state.launch_executable_path();
    let working_dir = exe_path.parent().unwrap_or(Path::new("."));
    let arguments = state
        .config_path()
        .map(|path| format!(r#"--config "{}""#, path.display()));

    write_shortcut_with_aumid(
        &shortcut_path,
        &exe_path,
        working_dir,
        arguments.as_deref(),
        TOAST_APP_USER_MODEL_ID,
    )?;
    Ok(shortcut_path)
}

pub fn open_frontend(url: &str) -> Result<()> {
    let operation = to_wide("open");
    let target = to_wide(url);

    let result = unsafe {
        ShellExecuteW(
            Some(HWND::default()),
            windows::core::PCWSTR(operation.as_ptr()),
            windows::core::PCWSTR(target.as_ptr()),
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW returns a pseudo-HINSTANCE; values <= 32 indicate failure.
    if result.0 as usize <= 32 {
        anyhow::bail!("ShellExecuteW failed with code {}", result.0 as usize);
    }

    Ok(())
}

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn to_wide_os(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn write_shortcut_with_aumid(
    shortcut_path: &Path,
    exe_path: &Path,
    working_dir: &Path,
    arguments: Option<&str>,
    app_user_model_id: &str,
) -> Result<()> {
    struct CoInitializeGuard;
    impl Drop for CoInitializeGuard {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    let coinit_result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let _co_guard = if coinit_result == RPC_E_CHANGED_MODE {
        None
    } else {
        coinit_result
            .ok()
            .context("failed to initialize COM for shortcut registration")?;
        Some(CoInitializeGuard)
    };

    let shell_link: IShellLinkW = unsafe {
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .context("failed to create IShellLinkW COM instance")?
    };

    let exe_wide = to_wide_os(exe_path.as_os_str());
    unsafe {
        shell_link
            .SetPath(PCWSTR(exe_wide.as_ptr()))
            .context("failed to set shortcut target path")?;
    }

    if let Some(arguments) = arguments
        && !arguments.trim().is_empty()
    {
        let arguments_wide = to_wide(arguments);
        unsafe {
            shell_link
                .SetArguments(PCWSTR(arguments_wide.as_ptr()))
                .context("failed to set shortcut arguments")?;
        }
    }

    let description_wide = to_wide("Timeline");
    unsafe {
        shell_link
            .SetDescription(PCWSTR(description_wide.as_ptr()))
            .context("failed to set shortcut description")?;
    }

    let working_dir_wide = to_wide_os(working_dir.as_os_str());
    unsafe {
        shell_link
            .SetWorkingDirectory(PCWSTR(working_dir_wide.as_ptr()))
            .context("failed to set shortcut working directory")?;
        shell_link
            .SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)
            .context("failed to set shortcut icon")?;
    }

    let property_store: IPropertyStore = shell_link
        .cast()
        .context("failed to cast IShellLinkW to IPropertyStore")?;
    let mut app_id_prop = init_prop_variant_from_string(app_user_model_id)?;
    let property_result = unsafe {
        property_store
            .SetValue(&PKEY_APP_USER_MODEL_ID, &app_id_prop)
            .and_then(|_| property_store.Commit())
    };
    unsafe {
        let _ = PropVariantClear(&mut app_id_prop);
    }
    property_result.context("failed to stamp AppUserModelID on Start Menu shortcut")?;

    let persist_file: IPersistFile = shell_link
        .cast()
        .context("failed to cast IShellLinkW to IPersistFile")?;
    let shortcut_wide = to_wide_os(shortcut_path.as_os_str());
    unsafe {
        persist_file
            .Save(PCWSTR(shortcut_wide.as_ptr()), true)
            .with_context(|| format!("failed to save shortcut to {:?}", shortcut_path))?;
    }

    Ok(())
}

fn init_prop_variant_from_string(value: &str) -> Result<PROPVARIANT> {
    let value_wide = to_wide(value);
    let bytes = value_wide.len() * std::mem::size_of::<u16>();
    let raw_ptr = unsafe { CoTaskMemAlloc(bytes) } as *mut u16;
    if raw_ptr.is_null() {
        anyhow::bail!("CoTaskMemAlloc failed while building AppUserModelID PROPVARIANT");
    }

    unsafe {
        std::ptr::copy_nonoverlapping(value_wide.as_ptr(), raw_ptr, value_wide.len());
    }
    Ok(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    pwszVal: PWSTR(raw_ptr),
                },
            }),
        },
    })
}

pub fn show_break_reminder(streak_secs: i64) {
    let active_minutes = ((streak_secs + 59) / 60).max(1);
    let message = format!("你已连续活跃约 {active_minutes} 分钟，建议起身活动 3-5 分钟。");

    std::thread::spawn(move || {
        if let Err(error) = show_break_reminder_toast(BREAK_REMINDER_TITLE, &message) {
            warn!(
                ?error,
                "failed to show break toast reminder, falling back to dialog"
            );
            if let Err(dialog_error) = show_break_reminder_dialog(BREAK_REMINDER_TITLE, &message) {
                warn!(
                    ?dialog_error,
                    "failed to show break reminder fallback dialog"
                );
            }
        }
    });
}

fn show_break_reminder_toast(title: &str, message: &str) -> Result<()> {
    Toast::new(TOAST_APP_USER_MODEL_ID)
        .title(title)
        .text1(message)
        .duration(ToastDuration::Short)
        .sound(Some(Sound::Default))
        .show()
        .context("failed to show Windows toast reminder")?;

    Ok(())
}

fn show_break_reminder_dialog(title: &str, message: &str) -> Result<()> {
    let title = to_wide(title);
    let message = to_wide(message);
    let result = unsafe {
        MessageBoxW(
            Some(HWND::default()),
            windows::core::PCWSTR(message.as_ptr()),
            windows::core::PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };

    if result.0 == 0 {
        anyhow::bail!("MessageBoxW failed");
    }

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
    let mut event_loop_builder = EventLoopBuilder::<TrayUserEvent>::with_user_event();
    #[cfg(target_os = "windows")]
    event_loop_builder.with_any_thread(true);

    let event_loop = event_loop_builder.build();
    let tray_menu = build_tray_menu();
    let tray_icon = build_tray_icon().context("failed to build tray icon image")?;
    let open_id = MenuId::new(MENU_OPEN_ID);
    let quit_id = MenuId::new(MENU_QUIT_ID);

    let proxy = event_loop.create_proxy();
    tray_icon::TrayIconEvent::set_event_handler(Some(move |event| {
        if let tray_icon::TrayIconEvent::Click {
            button,
            button_state,
            ..
        } = event
        {
            let _ = proxy.send_event(TrayUserEvent::TrayClick {
                button,
                button_state,
            });
        }
    }));

    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(TrayUserEvent::Menu(event));
    }));

    let _tray = TrayIconBuilder::new()
        .with_tooltip("Timeline")
        .with_icon(tray_icon)
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false)
        .build()
        .context("failed to create tray icon")?;

    state.mark_tray_online_sync(OffsetDateTime::now_utc());
    info!("tray icon started");

    let state_for_loop = state.clone();
    event_loop.run(move |event, _, control_flow| {
        // Poll at 250ms to keep tray responsive while avoiding excessive CPU usage.
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));

        if state_for_loop.shutdown_requested() {
            *control_flow = ControlFlow::Exit;
            return;
        }

        match event {
            Event::NewEvents(StartCause::Init) => {
                state_for_loop.mark_tray_online_sync(OffsetDateTime::now_utc());
            }
            Event::UserEvent(TrayUserEvent::TrayClick {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
            }) => {
                state_for_loop.mark_tray_online_sync(OffsetDateTime::now_utc());
                if let Err(error) = open_frontend(&state_for_loop.config().effective_web_ui_url()) {
                    warn!(?error, "failed to open frontend from tray click");
                }
            }
            Event::UserEvent(TrayUserEvent::Menu(menu_event)) => {
                state_for_loop.mark_tray_online_sync(OffsetDateTime::now_utc());
                if menu_event.id == open_id {
                    if let Err(error) =
                        open_frontend(&state_for_loop.config().effective_web_ui_url())
                    {
                        warn!(?error, "failed to open frontend from tray menu");
                    }
                } else if menu_event.id == quit_id {
                    state_for_loop.request_shutdown();
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

fn build_tray_menu() -> Menu {
    let menu = Menu::new();
    let open_item = MenuItem::with_id(MENU_OPEN_ID, "打开时间线", true, None::<Accelerator>);
    let quit_item = MenuItem::with_id(MENU_QUIT_ID, "退出", true, None::<Accelerator>);
    menu.append(&open_item)
        .expect("failed to append open menu item");
    menu.append(&PredefinedMenuItem::separator())
        .expect("failed to append tray separator");
    menu.append(&quit_item)
        .expect("failed to append quit menu item");
    menu
}

/// Builds a 32×32 RGBA tray icon procedurally.
///
/// The icon depicts a stylized "T" (for Timeline) on a blue background:
///
/// ```text
///   ┌──────────────────────────┐  ← dark border (2px, #0e1726)
///   │  blue background #1c5ac4 │
///   │     ┌───────────────┐    │
///   │     │  white T-bar  │    │  ← horizontal bar (x 8..23, y 7..10)
///   │     └───┬───┬───────┘    │
///   │         │   │            │
///   │         │ T │            │  ← vertical stem (x 14..17, y 6..25)
///   │         │   │            │
///   │         └───┘   ■■■■■   │  ← accent square (x 20..24, y 20..24, #568eff)
///   └──────────────────────────┘
/// ```
fn build_tray_icon() -> Result<Icon> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];

    // Color constants for the icon layers
    const BORDER: (u8, u8, u8, u8) = (14, 23, 38, 255); // dark navy border
    const BACKGROUND: (u8, u8, u8, u8) = (28, 90, 196, 255); // blue fill
    const GLYPH: (u8, u8, u8, u8) = (255, 255, 255, 255); // white "T" letter
    const ACCENT: (u8, u8, u8, u8) = (86, 142, 255, 255); // lighter blue dot

    for y in 0..SIZE {
        for x in 0..SIZE {
            let offset = ((y * SIZE + x) * 4) as usize;
            let is_border = x < 2 || x >= SIZE - 2 || y < 2 || y >= SIZE - 2;
            let is_vertical = (14..=17).contains(&x) && (6..=25).contains(&y);
            let is_horizontal = (8..=23).contains(&x) && (7..=10).contains(&y);
            let is_highlight = (20..=24).contains(&x) && (20..=24).contains(&y);

            let (r, g, b, a) = if is_border {
                BORDER
            } else if is_vertical || is_horizontal {
                GLYPH
            } else if is_highlight {
                ACCENT
            } else {
                BACKGROUND
            };

            rgba[offset] = r;
            rgba[offset + 1] = g;
            rgba[offset + 2] = b;
            rgba[offset + 3] = a;
        }
    }

    Icon::from_rgba(rgba, SIZE, SIZE).context("failed to create tray icon from rgba")
}
