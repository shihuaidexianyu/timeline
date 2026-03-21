//! Windows-specific helpers for reading foreground window and user presence.

use anyhow::{Context, Result};
use common::PresenceState;
use serde::Serialize;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW, HDESK,
    OpenInputDesktop, UOI_NAME,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible,
};
use windows::core::PWSTR;

#[derive(Debug, Clone, Serialize)]
pub struct ForegroundWindowSnapshot {
    pub hwnd: isize,
    pub process_id: u32,
    pub session_id: u32,
    pub process_name: String,
    pub exe_path: String,
    pub window_title: Option<String>,
    pub is_browser: bool,
}

impl ForegroundWindowSnapshot {
    pub fn fingerprint(&self) -> String {
        format!(
            "{}:{}:{}",
            self.hwnd,
            self.process_id,
            self.window_title.as_deref().unwrap_or_default()
        )
    }
}

pub fn capture_foreground_window() -> Result<Option<ForegroundWindowSnapshot>> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(None);
    }

    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return Ok(None);
    }

    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return Ok(None);
    }

    let exe_path = read_process_path(process_id)?;
    let process_name = Path::new(&exe_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown.exe")
        .to_string();
    let session_id = read_session_id(process_id)?;
    let window_title = read_window_title(hwnd);

    Ok(Some(ForegroundWindowSnapshot {
        hwnd: hwnd.0 as isize,
        process_id,
        session_id,
        process_name: process_name.clone(),
        exe_path,
        window_title,
        is_browser: is_browser_process(&process_name),
    }))
}

pub fn detect_presence(idle_threshold: Duration) -> Result<PresenceState> {
    if is_workstation_locked()? {
        return Ok(PresenceState::Locked);
    }

    let idle_for = read_idle_duration()?;
    if idle_for >= idle_threshold {
        Ok(PresenceState::Idle)
    } else {
        Ok(PresenceState::Active)
    }
}

fn read_idle_duration() -> Result<Duration> {
    let mut last_input_info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };

    unsafe {
        GetLastInputInfo(&mut last_input_info)
            .ok()
            .context("GetLastInputInfo failed")?;
    }

    let now_tick = unsafe { GetTickCount64() };
    let last_tick = u64::from(last_input_info.dwTime);

    Ok(Duration::from_millis(now_tick.saturating_sub(last_tick)))
}

fn read_window_title(hwnd: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return None;
    }

    let mut buffer = vec![0u16; length as usize + 1];
    let written = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if written <= 0 {
        return None;
    }

    let value = OsString::from_wide(&buffer[..written as usize]);
    let title = value.to_string_lossy().trim().to_string();
    if title.is_empty() { None } else { Some(title) }
}

fn read_process_path(process_id: u32) -> Result<String> {
    let handle = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .with_context(|| format!("OpenProcess failed for pid {}", process_id))?
    };
    let _guard = HandleGuard(handle);

    let mut buffer = vec![0u16; 1024];
    let mut length = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .context("QueryFullProcessImageNameW failed")?;
    }

    Ok(String::from_utf16_lossy(&buffer[..length as usize]))
}

fn read_session_id(process_id: u32) -> Result<u32> {
    let mut session_id = 0u32;
    unsafe {
        ProcessIdToSessionId(process_id, &mut session_id as *mut u32)
            .context("ProcessIdToSessionId failed")?;
    }

    Ok(session_id)
}

fn is_workstation_locked() -> Result<bool> {
    let desktop = unsafe {
        OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            .context("OpenInputDesktop failed")?
    };
    let _guard = DesktopGuard(desktop);

    let mut needed = 0u32;
    unsafe {
        let _ = GetUserObjectInformationW(HANDLE(desktop.0), UOI_NAME, None, 0, Some(&mut needed));
    }

    if needed == 0 {
        return Ok(false);
    }

    let mut buffer = vec![0u16; needed as usize / 2];
    unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            needed,
            Some(&mut needed),
        )
        .context("GetUserObjectInformationW failed")?;
    }

    let name = String::from_utf16_lossy(&buffer)
        .trim_end_matches('\0')
        .to_string();

    Ok(!name.eq_ignore_ascii_case("Default"))
}

fn is_browser_process(process_name: &str) -> bool {
    matches!(
        process_name.to_ascii_lowercase().as_str(),
        "chrome.exe" | "msedge.exe" | "firefox.exe" | "brave.exe"
    )
}

struct HandleGuard(windows::Win32::Foundation::HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct DesktopGuard(HDESK);

impl Drop for DesktopGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.0);
        }
    }
}
