//! Windows-specific helpers for reading foreground/visible windows and user presence.

use anyhow::{Context, Result};
use common::PresenceState;
use serde::Serialize;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
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
    EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

pub const VISIBLE_WINDOW_MIN_RATIO: f64 = 0.05;

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

#[derive(Debug, Clone, Serialize)]
pub struct VisibleWindowSnapshot {
    pub hwnd: isize,
    pub process_id: u32,
    pub session_id: u32,
    pub process_name: String,
    pub exe_path: String,
    pub window_title: Option<String>,
    pub visible_area_ratio: f64,
}

impl VisibleWindowSnapshot {
    pub fn key(&self) -> String {
        format!("{}:{}", self.hwnd, self.process_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl ScreenRect {
    fn from_rect(rect: RECT) -> Option<Self> {
        Self::new(rect.left, rect.top, rect.right, rect.bottom)
    }

    fn new(left: i32, top: i32, right: i32, bottom: i32) -> Option<Self> {
        if right <= left || bottom <= top {
            return None;
        }

        Some(Self {
            left,
            top,
            right,
            bottom,
        })
    }

    fn area(self) -> i64 {
        i64::from(self.right - self.left) * i64::from(self.bottom - self.top)
    }

    fn intersect(self, other: Self) -> Option<Self> {
        Self::new(
            self.left.max(other.left),
            self.top.max(other.top),
            self.right.min(other.right),
            self.bottom.min(other.bottom),
        )
    }
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

pub fn capture_foreground_window(
    include_window_title: bool,
) -> Result<Option<ForegroundWindowSnapshot>> {
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
    let window_title = if include_window_title {
        read_window_title(hwnd)
    } else {
        None
    };

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

pub fn capture_visible_windows(include_window_title: bool) -> Result<Vec<VisibleWindowSnapshot>> {
    if is_workstation_locked()? {
        return Ok(Vec::new());
    }

    let virtual_screen = virtual_screen_rect();
    let mut covered_rects = Vec::new();
    let mut snapshots = Vec::new();

    for hwnd in enumerate_top_level_windows()? {
        if !is_visible_window_candidate(hwnd) {
            continue;
        }

        let Some(window_rect) = window_rect(hwnd) else {
            continue;
        };
        let Some(clipped_rect) = window_rect.intersect(virtual_screen) else {
            continue;
        };

        let visible_area = visible_area_after_occlusion(clipped_rect, &covered_rects);
        covered_rects.push(clipped_rect);

        let total_area = clipped_rect.area();
        if total_area <= 0 {
            continue;
        }

        let visible_area_ratio = visible_area as f64 / total_area as f64;
        if visible_area_ratio <= VISIBLE_WINDOW_MIN_RATIO {
            continue;
        }

        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        if process_id == 0 {
            continue;
        }

        let Ok(exe_path) = read_process_path(process_id) else {
            continue;
        };
        let process_name = Path::new(&exe_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown.exe")
            .to_string();
        let session_id = read_session_id(process_id).unwrap_or_default();
        let window_title = if include_window_title {
            read_window_title(hwnd)
        } else {
            None
        };

        snapshots.push(VisibleWindowSnapshot {
            hwnd: hwnd.0 as isize,
            process_id,
            session_id,
            process_name,
            exe_path,
            window_title,
            visible_area_ratio,
        });
    }

    Ok(snapshots)
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

fn enumerate_top_level_windows() -> Result<Vec<HWND>> {
    unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        windows.push(hwnd);
        true.into()
    }

    let mut windows = Vec::new();
    unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM((&mut windows as *mut Vec<HWND>) as isize),
        )
        .context("EnumWindows failed")?;
    }

    Ok(windows)
}

fn is_visible_window_candidate(hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }

    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return false;
    }

    if unsafe { IsIconic(hwnd).as_bool() } {
        return false;
    }

    if is_tool_window(hwnd) || is_dwm_cloaked(hwnd) {
        return false;
    }

    true
}

fn is_tool_window(hwnd: HWND) -> bool {
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    (ex_style & WS_EX_TOOLWINDOW.0 as isize) != 0
}

fn is_dwm_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };

    result.is_ok() && cloaked != 0
}

fn window_rect(hwnd: HWND) -> Option<ScreenRect> {
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).ok()?;
    }

    ScreenRect::from_rect(rect)
}

fn virtual_screen_rect() -> ScreenRect {
    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };

    ScreenRect::new(left, top, left + width, top + height).unwrap_or(ScreenRect {
        left: 0,
        top: 0,
        right: 1,
        bottom: 1,
    })
}

fn visible_area_after_occlusion(rect: ScreenRect, covered_rects: &[ScreenRect]) -> i64 {
    let mut visible_parts = vec![rect];

    for cover in covered_rects {
        let mut next_parts = Vec::new();
        for part in visible_parts {
            next_parts.extend(subtract_rect(part, *cover));
        }
        visible_parts = next_parts;

        if visible_parts.is_empty() {
            return 0;
        }
    }

    visible_parts.into_iter().map(ScreenRect::area).sum()
}

fn subtract_rect(source: ScreenRect, cover: ScreenRect) -> Vec<ScreenRect> {
    let Some(overlap) = source.intersect(cover) else {
        return vec![source];
    };

    let mut pieces = Vec::with_capacity(4);

    if let Some(top) = ScreenRect::new(source.left, source.top, source.right, overlap.top) {
        pieces.push(top);
    }
    if let Some(bottom) = ScreenRect::new(source.left, overlap.bottom, source.right, source.bottom)
    {
        pieces.push(bottom);
    }
    if let Some(left) = ScreenRect::new(source.left, overlap.top, overlap.left, overlap.bottom) {
        pieces.push(left);
    }
    if let Some(right) = ScreenRect::new(overlap.right, overlap.top, source.right, overlap.bottom) {
        pieces.push(right);
    }

    pieces
}

/// Reads how long since the last keyboard/mouse input using Win32 tick counts.
/// `GetLastInputInfo` returns the tick count (ms since boot) of the last input event;
/// we subtract it from the current tick count to get the idle duration.
/// `saturating_sub` prevents underflow if the tick counter wraps (>584 billion ms / ~185 years).
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

/// Detects whether the Windows workstation is locked by checking the name of
/// the active input desktop. When the machine is locked, Windows switches to the
/// "Winlogon" desktop; the normal interactive desktop is named "Default".
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

#[cfg(test)]
mod tests {
    use super::{ScreenRect, visible_area_after_occlusion};

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> ScreenRect {
        ScreenRect::new(left, top, right, bottom).expect("valid rect")
    }

    #[test]
    fn visible_area_keeps_side_by_side_windows_fully_visible() {
        let left = rect(0, 0, 100, 100);
        let right = rect(100, 0, 200, 100);

        assert_eq!(visible_area_after_occlusion(left, &[right]), 10_000);
    }

    #[test]
    fn visible_area_removes_fully_covered_window() {
        let lower = rect(0, 0, 100, 100);
        let upper = rect(0, 0, 100, 100);

        assert_eq!(visible_area_after_occlusion(lower, &[upper]), 0);
    }

    #[test]
    fn visible_area_subtracts_partial_occlusion() {
        let lower = rect(0, 0, 100, 100);
        let upper = rect(50, 0, 100, 100);

        assert_eq!(visible_area_after_occlusion(lower, &[upper]), 5_000);
    }

    #[test]
    fn visible_area_handles_multiple_overlapping_covers() {
        let lower = rect(0, 0, 100, 100);
        let upper_left = rect(0, 0, 50, 50);
        let upper_right = rect(50, 0, 100, 100);

        assert_eq!(
            visible_area_after_occlusion(lower, &[upper_left, upper_right]),
            2_500
        );
    }
}

/// RAII wrapper that closes a Win32 HANDLE on drop.
/// Close errors are intentionally ignored — the handle may already be invalid,
/// and there's no meaningful recovery action during cleanup.
struct HandleGuard(windows::Win32::Foundation::HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// RAII wrapper that closes a Win32 desktop handle on drop (same rationale as HandleGuard).
struct DesktopGuard(HDESK);

impl Drop for DesktopGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.0);
        }
    }
}
