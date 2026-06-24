//! Windows-specific helpers for reading foreground/visible windows and user presence.

use anyhow::{Context, Result};
use common::PresenceState;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK, WTSFreeMemory,
    WTSINFOEXW, WTSQuerySessionInformationW, WTSSessionInfoEx,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SMTO_ABORTIFHUNG,
    SendMessageTimeoutW, WM_GETTEXT, WM_GETTEXTLENGTH, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

pub const VISIBLE_WINDOW_MIN_RATIO: f64 = 0.05;
pub const VISIBLE_WINDOW_MIN_SCREEN_RATIO: f64 = 0.25;
const WINDOW_TEXT_TIMEOUT_MS: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessInfo {
    process_name: String,
    exe_path: Option<String>,
}

struct ProcessInfoCache {
    names_by_pid: BTreeMap<u32, String>,
    cache_by_pid: BTreeMap<u32, ProcessInfo>,
}

impl ProcessInfoCache {
    fn new(names_by_pid: BTreeMap<u32, String>) -> Self {
        Self {
            names_by_pid,
            cache_by_pid: BTreeMap::new(),
        }
    }

    fn resolve<F>(&mut self, process_id: u32, mut read_path: F) -> Option<ProcessInfo>
    where
        F: FnMut(u32) -> Result<String>,
    {
        if let Some(info) = self.cache_by_pid.get(&process_id) {
            return Some(info.clone());
        }

        let exe_path = read_path(process_id).ok();
        let process_name = exe_path
            .as_deref()
            .and_then(process_name_from_path)
            .or_else(|| self.names_by_pid.get(&process_id).cloned())?;
        let info = ProcessInfo {
            process_name,
            exe_path,
        };
        self.cache_by_pid.insert(process_id, info.clone());
        Some(info)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ForegroundWindowSnapshot {
    pub hwnd: isize,
    pub process_id: u32,
    pub session_id: u32,
    pub process_name: String,
    pub exe_path: Option<String>,
    pub window_title: Option<String>,
    pub is_browser: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VisibleWindowSnapshot {
    pub hwnd: isize,
    pub process_id: u32,
    pub session_id: u32,
    pub process_name: String,
    pub exe_path: Option<String>,
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
    /// Fingerprint used to decide whether the foreground focus segment should
    /// be touched (same window) or replaced (different window).
    ///
    /// Uses `hwnd:process_id` only — NOT `window_title`. This prevents
    /// dynamic title changes (e.g. switching files in VS Code, switching
    /// browser tabs) from fragmenting a single focus session into many
    /// tiny segments. The window title is still captured and stored as
    /// segment metadata; it just doesn't trigger segment switches.
    pub fn fingerprint(&self) -> String {
        format!("{}:{}", self.hwnd, self.process_id)
    }
}

pub fn capture_foreground_window(
    include_window_title: bool,
) -> Result<Option<ForegroundWindowSnapshot>> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(None);
    }

    if !is_foreground_window_trackable(hwnd)? {
        return Ok(None);
    }

    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return Ok(None);
    }

    let process_info = read_process_info(process_id);
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
        process_name: process_info.process_name.clone(),
        exe_path: process_info.exe_path,
        window_title,
        is_browser: is_browser_process(&process_info.process_name),
    }))
}

pub fn capture_visible_windows(include_window_title: bool) -> Result<Vec<VisibleWindowSnapshot>> {
    if is_workstation_locked()? {
        return Ok(Vec::new());
    }

    let virtual_screen = virtual_screen_rect();
    let monitor_rects = monitor_rects();
    let process_names = read_process_names_by_pid().unwrap_or_default();
    let mut process_cache = ProcessInfoCache::new(process_names);
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
        if !is_large_enough_visible_window(clipped_rect, visible_area, &monitor_rects) {
            continue;
        }

        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        if process_id == 0 {
            continue;
        }

        let Some(process_info) = process_cache.resolve(process_id, read_process_path) else {
            continue;
        };
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
            process_name: process_info.process_name,
            exe_path: process_info.exe_path,
            window_title,
            visible_area_ratio,
        });
    }

    Ok(snapshots)
}

fn is_foreground_window_trackable(hwnd: HWND) -> Result<bool> {
    if is_workstation_locked()? {
        return Ok(false);
    }

    if !is_visible_window_candidate(hwnd) {
        return Ok(false);
    }

    let virtual_screen = virtual_screen_rect();
    let Some(clipped_rect) = window_rect(hwnd).and_then(|rect| rect.intersect(virtual_screen))
    else {
        return Ok(false);
    };

    let mut covered_rects = Vec::new();
    let mut found_foreground = false;
    for candidate in enumerate_top_level_windows()? {
        if candidate == hwnd {
            found_foreground = true;
            break;
        }

        if !is_visible_window_candidate(candidate) {
            continue;
        }
        if let Some(cover_rect) =
            window_rect(candidate).and_then(|rect| rect.intersect(virtual_screen))
        {
            covered_rects.push(cover_rect);
        }
    }

    if !found_foreground {
        return Ok(false);
    }

    let visible_area = visible_area_after_occlusion(clipped_rect, &covered_rects);
    Ok(foreground_visible_ratio_is_trackable(
        clipped_rect,
        visible_area,
    ))
}

pub fn detect_presence(idle_threshold: Duration) -> Result<PresenceState> {
    if is_workstation_locked()? {
        return Ok(PresenceState::Locked);
    }

    let idle_for = read_idle_duration()?;

    // When the foreground window is a known media player or a fullscreen
    // browser (likely playing video), the user may not move the mouse for a
    // long time even though they are actively watching. In that case we widen
    // the idle threshold to 30 minutes so video playback isn't miscounted as
    // idle. This is a heuristic — it can't detect audio-only playback or
    // non-fullscreen video — but it catches the most common false-positive.
    let effective_threshold = if is_foreground_media_or_fullscreen_browser()? {
        idle_threshold.max(Duration::from_secs(30 * 60))
    } else {
        idle_threshold
    };

    if idle_for >= effective_threshold {
        Ok(PresenceState::Idle)
    } else {
        Ok(PresenceState::Active)
    }
}

/// Returns true if the current foreground window is a known media player
/// process OR a browser window in fullscreen mode (likely playing video).
fn is_foreground_media_or_fullscreen_browser() -> Result<bool> {
    let snapshot = match capture_foreground_window(false)? {
        Some(snapshot) => snapshot,
        None => return Ok(false),
    };

    if is_media_player_process(&snapshot.process_name) {
        return Ok(true);
    }

    // Browser in fullscreen — likely video playback or presentation.
    // We already suppress health reminders in fullscreen; here we also
    // relax idle detection for the same condition.
    if snapshot.is_browser && is_foreground_fullscreen()? {
        return Ok(true);
    }

    Ok(false)
}

/// Known media player process names. The user is likely watching content
/// and not moving the mouse, so idle detection should be relaxed.
fn is_media_player_process(process_name: &str) -> bool {
    matches!(
        process_name.to_ascii_lowercase().as_str(),
        "vlc.exe"
            | "mpc-hc64.exe"
            | "mpc-hc.exe"
            | "potplayermini64.exe"
            | "potplayermini.exe"
            | "mpv.exe"
            | "wmplayer.exe"
            | "foobar2000.exe"
            | "spotify.exe"
            | "music.exe"
            | "qqmusic.exe"
            | "cloudmusic.exe"
            | "kugou.exe"
    )
}

/// Checks if the current foreground window covers the entire area of its
/// dominant monitor (i.e. is in fullscreen mode). Used by the health reminder
/// to suppress toasts during presentations and fullscreen media playback.
pub fn is_foreground_fullscreen() -> Result<bool> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(false);
    }

    if !is_visible_window_candidate(hwnd) || unsafe { IsIconic(hwnd).as_bool() } {
        return Ok(false);
    }

    let Some(window_rect) = window_rect(hwnd) else {
        return Ok(false);
    };

    let monitor_rects = monitor_rects();
    let Some(monitor_rect) = dominant_monitor_for_window(window_rect, &monitor_rects) else {
        return Ok(false);
    };

    // Treat as fullscreen if the window covers at least 98% of the monitor
    // area. A small tolerance handles edge cases like auto-hide taskbars.
    let window_area = window_rect
        .intersect(monitor_rect)
        .map(|r| r.area())
        .unwrap_or(0);
    let monitor_area = monitor_rect.area();
    if monitor_area <= 0 {
        return Ok(false);
    }

    Ok(window_area as f64 / monitor_area as f64 >= 0.98)
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

fn monitor_rects() -> Vec<ScreenRect> {
    unsafe extern "system" fn collect_monitor(
        _monitor: HMONITOR,
        _hdc: HDC,
        rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        if rect.is_null() {
            return true.into();
        }

        let monitors = unsafe { &mut *(lparam.0 as *mut Vec<ScreenRect>) };
        if let Some(monitor_rect) = ScreenRect::from_rect(unsafe { *rect }) {
            monitors.push(monitor_rect);
        }
        true.into()
    }

    let mut monitors = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM((&mut monitors as *mut Vec<ScreenRect>) as isize),
        )
    };

    if ok.as_bool() && !monitors.is_empty() {
        monitors
    } else {
        vec![virtual_screen_rect()]
    }
}

fn is_large_enough_visible_window(
    clipped_rect: ScreenRect,
    visible_area: i64,
    monitor_rects: &[ScreenRect],
) -> bool {
    if visible_area <= 0 {
        return false;
    }

    let Some(monitor_rect) = dominant_monitor_for_window(clipped_rect, monitor_rects) else {
        return false;
    };
    let monitor_area = monitor_rect.area();
    if monitor_area <= 0 {
        return false;
    }

    visible_area as f64 / monitor_area as f64 >= VISIBLE_WINDOW_MIN_SCREEN_RATIO
}

fn dominant_monitor_for_window(
    clipped_rect: ScreenRect,
    monitor_rects: &[ScreenRect],
) -> Option<ScreenRect> {
    monitor_rects
        .iter()
        .filter_map(|monitor_rect| {
            let overlap_area = clipped_rect.intersect(*monitor_rect)?.area();
            Some((*monitor_rect, overlap_area))
        })
        .max_by_key(|(_, overlap_area)| *overlap_area)
        .map(|(monitor_rect, _)| monitor_rect)
}

fn foreground_visible_ratio_is_trackable(clipped_rect: ScreenRect, visible_area: i64) -> bool {
    let total_area = clipped_rect.area();
    if total_area <= 0 || visible_area <= 0 {
        return false;
    }

    visible_area as f64 / total_area as f64 > VISIBLE_WINDOW_MIN_RATIO
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
pub fn read_idle_duration() -> Result<Duration> {
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
    let mut length_result = 0usize;
    let length_status = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXTLENGTH,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            WINDOW_TEXT_TIMEOUT_MS,
            Some(&mut length_result),
        )
    };
    if length_status.0 == 0 || length_result == 0 {
        return None;
    }

    let mut buffer = vec![0u16; length_result.saturating_add(1)];
    let mut written_result = 0usize;
    let text_status = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            WPARAM(buffer.len()),
            LPARAM(buffer.as_mut_ptr() as isize),
            SMTO_ABORTIFHUNG,
            WINDOW_TEXT_TIMEOUT_MS,
            Some(&mut written_result),
        )
    };
    if text_status.0 == 0 || written_result == 0 {
        return None;
    }

    let written = written_result.min(buffer.len().saturating_sub(1));
    let title = String::from_utf16_lossy(&buffer[..written])
        .trim()
        .to_string();
    if title.is_empty() { None } else { Some(title) }
}

fn read_process_info(process_id: u32) -> ProcessInfo {
    let exe_path = read_process_path(process_id).ok();
    let process_name = exe_path
        .as_deref()
        .and_then(process_name_from_path)
        .or_else(|| {
            read_process_names_by_pid()
                .ok()
                .and_then(|names| names.get(&process_id).cloned())
        })
        .unwrap_or_else(|| "unknown.exe".to_string());

    ProcessInfo {
        process_name,
        exe_path,
    }
}

fn read_process_names_by_pid() -> Result<BTreeMap<u32, String>> {
    let snapshot = unsafe {
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .context("CreateToolhelp32Snapshot failed")?
    };
    let _guard = HandleGuard(snapshot);

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    unsafe {
        Process32FirstW(snapshot, &mut entry).context("Process32FirstW failed")?;
    }

    let mut process_names = BTreeMap::new();
    loop {
        let end = entry
            .szExeFile
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..end])
            .trim()
            .to_string();
        if !name.is_empty() {
            process_names.insert(entry.th32ProcessID, name);
        }

        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }

    Ok(process_names)
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

fn process_name_from_path(exe_path: &str) -> Option<String> {
    Path::new(exe_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_session_id(process_id: u32) -> Result<u32> {
    let mut session_id = 0u32;
    unsafe {
        ProcessIdToSessionId(process_id, &mut session_id as *mut u32)
            .context("ProcessIdToSessionId failed")?;
    }

    Ok(session_id)
}

/// Detects whether the current Windows session is locked from Terminal Services
/// session metadata. This avoids querying the input desktop, which can block in
/// GUI agent processes on some machines.
pub fn is_workstation_locked() -> Result<bool> {
    let session_id = read_session_id(std::process::id())?;
    let mut buffer = PWSTR::null();
    let mut bytes_returned = 0u32;
    unsafe {
        WTSQuerySessionInformationW(
            None,
            session_id,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes_returned,
        )
        .context("WTSQuerySessionInformationW failed")?;
    }
    let _guard = WtsMemoryGuard(buffer);

    if buffer.is_null() || bytes_returned < std::mem::size_of::<WTSINFOEXW>() as u32 {
        return Ok(false);
    }

    let info = unsafe { &*(buffer.0.cast::<WTSINFOEXW>()) };
    let session_flags = unsafe { info.Data.WTSInfoExLevel1.SessionFlags };
    Ok(session_lock_state(session_flags).unwrap_or(false))
}

fn session_lock_state(session_flags: i32) -> Option<bool> {
    if session_flags == WTS_SESSIONSTATE_LOCK as i32 {
        return Some(true);
    }
    if session_flags == WTS_SESSIONSTATE_UNLOCK as i32 {
        return Some(false);
    }
    None
}

fn is_browser_process(process_name: &str) -> bool {
    matches!(
        process_name.to_ascii_lowercase().as_str(),
        "chrome.exe"
            | "msedge.exe"
            | "firefox.exe"
            | "brave.exe"
            | "vivaldi.exe"
            | "opera.exe"
            | "arc.exe"
            | "thorium.exe"
            | "duckduckgo.exe"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        ProcessInfoCache, ScreenRect, foreground_visible_ratio_is_trackable,
        is_large_enough_visible_window, session_lock_state, visible_area_after_occlusion,
    };
    use std::collections::BTreeMap;

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

    #[test]
    fn visible_window_filter_rejects_small_fully_visible_windows() {
        let screen = rect(0, 0, 100, 100);
        let window = rect(0, 0, 40, 40);

        assert!(!is_large_enough_visible_window(window, 1_600, &[screen]));
    }

    #[test]
    fn visible_window_filter_accepts_half_screen_windows() {
        let screen = rect(0, 0, 100, 100);
        let window = rect(0, 0, 50, 100);

        assert!(is_large_enough_visible_window(window, 5_000, &[screen]));
    }

    #[test]
    fn visible_window_filter_uses_containing_monitor_not_virtual_desktop() {
        let left_monitor = rect(0, 0, 100, 100);
        let right_monitor = rect(100, 0, 200, 100);
        let window = rect(100, 0, 150, 100);

        assert!(is_large_enough_visible_window(
            window,
            5_000,
            &[left_monitor, right_monitor]
        ));
    }

    #[test]
    fn foreground_filter_accepts_small_visible_dialogs() {
        let dialog = rect(0, 0, 20, 20);

        assert!(foreground_visible_ratio_is_trackable(dialog, dialog.area()));
    }

    #[test]
    fn foreground_filter_rejects_mostly_occluded_windows() {
        let window = rect(0, 0, 100, 100);
        let visible_area = 500;

        assert!(!foreground_visible_ratio_is_trackable(window, visible_area));
    }

    #[test]
    fn session_lock_state_maps_known_wts_flags() {
        assert_eq!(session_lock_state(0), Some(true));
        assert_eq!(session_lock_state(1), Some(false));
        assert_eq!(session_lock_state(-1), None);
    }

    #[test]
    fn process_info_cache_keeps_exe_path_and_reads_each_pid_once() {
        let mut names = BTreeMap::new();
        names.insert(42, "code.exe".to_string());
        let mut cache = ProcessInfoCache::new(names);
        let mut path_reads = 0;

        let first = cache
            .resolve(42, |_| {
                path_reads += 1;
                Ok(r"C:\Apps\code.exe".to_string())
            })
            .expect("first lookup");
        let second = cache
            .resolve(42, |_| {
                path_reads += 1;
                Ok(r"C:\Apps\code.exe".to_string())
            })
            .expect("second lookup");

        assert_eq!(path_reads, 1);
        assert_eq!(first.process_name, "code.exe");
        assert_eq!(first.exe_path.as_deref(), Some(r"C:\Apps\code.exe"));
        assert_eq!(second.exe_path.as_deref(), Some(r"C:\Apps\code.exe"));
    }

    #[test]
    fn process_info_cache_derives_name_from_path_when_snapshot_name_is_missing() {
        let mut cache = ProcessInfoCache::new(BTreeMap::new());

        let info = cache
            .resolve(7, |_| Ok(r"C:\Program Files\App\weixin.exe".to_string()))
            .expect("lookup from path");

        assert_eq!(info.process_name, "weixin.exe");
        assert_eq!(
            info.exe_path.as_deref(),
            Some(r"C:\Program Files\App\weixin.exe")
        );
    }

    #[test]
    fn media_player_detection_recognizes_known_players() {
        use super::is_media_player_process;
        assert!(is_media_player_process("vlc.exe"));
        assert!(is_media_player_process("VLC.EXE"));
        assert!(is_media_player_process("PotPlayerMini64.exe"));
        assert!(is_media_player_process("spotify.exe"));
        assert!(!is_media_player_process("code.exe"));
        assert!(!is_media_player_process("msedge.exe"));
    }
}

/// RAII wrapper that closes a Win32 HANDLE on drop.
/// Close errors are intentionally ignored — the handle may already be invalid,
/// and there's no meaningful recovery action during cleanup.
struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// RAII wrapper that frees WTS memory on drop (same rationale as HandleGuard).
struct WtsMemoryGuard(PWSTR);

impl Drop for WtsMemoryGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                WTSFreeMemory(self.0.0.cast());
            }
        }
    }
}
