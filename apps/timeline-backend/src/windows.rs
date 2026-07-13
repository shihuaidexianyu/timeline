//! Windows-specific helpers for reading foreground window and user presence.

use anyhow::{Context, Result, anyhow};
use common::PresenceState;
use serde::Serialize;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use std::time::Duration;
use time::{Date, OffsetDateTime, PrimitiveDateTime, UtcOffset};
use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_ITEMS, HANDLE, HWND, SYSTEMTIME};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW, HDESK,
    OpenInputDesktop, UOI_NAME,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::System::Time::{
    DYNAMIC_TIME_ZONE_INFORMATION, EnumDynamicTimeZoneInformation, GetDynamicTimeZoneInformation,
    SystemTimeToTzSpecificLocalTimeEx, TIME_ZONE_ID_INVALID, TzSpecificLocalTimeToSystemTimeEx,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible,
};
use windows::core::PWSTR;

#[derive(Debug, Clone)]
pub struct WindowsTimeZone {
    id: String,
    info: DYNAMIC_TIME_ZONE_INFORMATION,
}

impl WindowsTimeZone {
    pub fn current() -> Result<Self> {
        let mut info = DYNAMIC_TIME_ZONE_INFORMATION::default();
        let result = unsafe { GetDynamicTimeZoneInformation(&mut info) };
        if result == TIME_ZONE_ID_INVALID {
            return Err(anyhow!("GetDynamicTimeZoneInformation failed"));
        }
        let id_len = info
            .TimeZoneKeyName
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(info.TimeZoneKeyName.len());
        let id = String::from_utf16_lossy(&info.TimeZoneKeyName[..id_len]);
        if id.is_empty() {
            return Err(anyhow!("Windows returned an empty time-zone ID"));
        }
        Self::from_id(&id).or(Ok(Self { id, info }))
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn from_id(id: &str) -> Result<Self> {
        let mut index = 0;
        loop {
            let mut info = DYNAMIC_TIME_ZONE_INFORMATION::default();
            let result = unsafe { EnumDynamicTimeZoneInformation(index, &mut info) };
            if result == ERROR_NO_MORE_ITEMS.0 {
                return Err(anyhow!("unknown Windows time-zone ID: {id}"));
            }
            if result != 0 {
                return Err(anyhow!(
                    "EnumDynamicTimeZoneInformation failed with code {result}"
                ));
            }
            let name_len = info
                .TimeZoneKeyName
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(info.TimeZoneKeyName.len());
            let candidate = String::from_utf16_lossy(&info.TimeZoneKeyName[..name_len]);
            if candidate.eq_ignore_ascii_case(id) {
                return Ok(Self {
                    id: candidate,
                    info,
                });
            }
            index = index.saturating_add(1);
        }
    }

    pub fn local_datetime(&self, utc: OffsetDateTime) -> Result<PrimitiveDateTime> {
        let utc = utc.to_offset(UtcOffset::UTC);
        let utc_system =
            system_time_from_primitive(PrimitiveDateTime::new(utc.date(), utc.time()))?;
        let mut local_system = SYSTEMTIME::default();
        unsafe {
            SystemTimeToTzSpecificLocalTimeEx(
                Some(&self.info as *const _),
                &utc_system,
                &mut local_system,
            )?;
        }
        primitive_from_system_time(local_system)
    }

    pub fn offset_at(&self, utc: OffsetDateTime) -> Result<UtcOffset> {
        let utc = utc.to_offset(UtcOffset::UTC);
        let utc_primitive = PrimitiveDateTime::new(utc.date(), utc.time());
        let seconds = (self.local_datetime(utc)? - utc_primitive).whole_seconds();
        UtcOffset::from_whole_seconds(
            i32::try_from(seconds).context("Windows time-zone offset exceeds i32")?,
        )
        .context("Windows returned an invalid UTC offset")
    }

    pub fn day_bounds(&self, date: Date) -> Result<(OffsetDateTime, OffsetDateTime)> {
        let next_date = date
            .next_day()
            .ok_or_else(|| anyhow!("local date overflow"))?;
        Ok((
            self.local_midnight_to_utc(date)?,
            self.local_midnight_to_utc(next_date)?,
        ))
    }

    fn local_midnight_to_utc(&self, date: Date) -> Result<OffsetDateTime> {
        let local_system =
            system_time_from_primitive(PrimitiveDateTime::new(date, time::Time::MIDNIGHT))?;
        let mut utc_system = SYSTEMTIME::default();
        unsafe {
            TzSpecificLocalTimeToSystemTimeEx(
                Some(&self.info as *const _),
                &local_system,
                &mut utc_system,
            )?;
        }
        Ok(primitive_from_system_time(utc_system)?.assume_utc())
    }
}

fn system_time_from_primitive(value: PrimitiveDateTime) -> Result<SYSTEMTIME> {
    Ok(SYSTEMTIME {
        wYear: u16::try_from(value.year()).context("year is outside SYSTEMTIME range")?,
        wMonth: value.month() as u16,
        wDayOfWeek: 0,
        wDay: u16::from(value.day()),
        wHour: u16::from(value.hour()),
        wMinute: u16::from(value.minute()),
        wSecond: u16::from(value.second()),
        wMilliseconds: value.millisecond(),
    })
}

fn primitive_from_system_time(value: SYSTEMTIME) -> Result<PrimitiveDateTime> {
    let month =
        time::Month::try_from(u8::try_from(value.wMonth).context("SYSTEMTIME month exceeds u8")?)?;
    let date = Date::from_calendar_date(
        i32::from(value.wYear),
        month,
        u8::try_from(value.wDay).context("SYSTEMTIME day exceeds u8")?,
    )?;
    let time = time::Time::from_hms_milli(
        u8::try_from(value.wHour).context("SYSTEMTIME hour exceeds u8")?,
        u8::try_from(value.wMinute).context("SYSTEMTIME minute exceeds u8")?,
        u8::try_from(value.wSecond).context("SYSTEMTIME second exceeds u8")?,
        value.wMilliseconds,
    )?;
    Ok(PrimitiveDateTime::new(date, time))
}

#[cfg(test)]
mod timezone_tests {
    use super::WindowsTimeZone;
    use time::{Date, Month};

    #[test]
    fn windows_dynamic_timezone_handles_23_and_25_hour_days() {
        let timezone =
            WindowsTimeZone::from_id("Pacific Standard Time").expect("load Pacific Standard Time");
        let spring = Date::from_calendar_date(2026, Month::March, 8).expect("spring date");
        let fall = Date::from_calendar_date(2026, Month::November, 1).expect("fall date");
        let (spring_start, spring_end) = timezone.day_bounds(spring).expect("spring bounds");
        let (fall_start, fall_end) = timezone.day_bounds(fall).expect("fall bounds");

        assert_eq!((spring_end - spring_start).whole_hours(), 23);
        assert_eq!((fall_end - fall_start).whole_hours(), 25);
        assert_eq!(timezone.id(), "Pacific Standard Time");
    }
}

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
