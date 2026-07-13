//! Local-day calculations backed by the Windows dynamic time-zone database.

use crate::windows::WindowsTimeZone;
use anyhow::Result;
use time::{Date, OffsetDateTime, PrimitiveDateTime, UtcOffset};

#[derive(Clone)]
pub enum TimeZoneContext {
    Fixed(UtcOffset),
    Windows(Box<WindowsTimeZone>),
}

impl TimeZoneContext {
    pub fn current_windows() -> Result<Self> {
        Ok(Self::Windows(Box::new(WindowsTimeZone::current()?)))
    }

    pub fn id(&self) -> String {
        match self {
            Self::Fixed(offset) => format!("fixed:{offset}"),
            Self::Windows(timezone) => timezone.id().to_string(),
        }
    }

    pub fn local_datetime(&self, utc: OffsetDateTime) -> Result<PrimitiveDateTime> {
        match self {
            Self::Fixed(offset) => {
                let local = utc.to_offset(*offset);
                Ok(PrimitiveDateTime::new(local.date(), local.time()))
            }
            Self::Windows(timezone) => timezone.local_datetime(utc),
        }
    }

    pub fn local_date(&self, utc: OffsetDateTime) -> Result<Date> {
        Ok(self.local_datetime(utc)?.date())
    }

    pub fn offset_at(&self, utc: OffsetDateTime) -> Result<UtcOffset> {
        match self {
            Self::Fixed(offset) => Ok(*offset),
            Self::Windows(timezone) => timezone.offset_at(utc),
        }
    }

    pub fn day_bounds(&self, date: Date) -> Result<(OffsetDateTime, OffsetDateTime)> {
        match self {
            Self::Fixed(offset) => {
                let start = PrimitiveDateTime::new(date, time::Time::MIDNIGHT)
                    .assume_offset(*offset)
                    .to_offset(UtcOffset::UTC);
                let end = PrimitiveDateTime::new(
                    date.next_day()
                        .ok_or_else(|| anyhow::anyhow!("local date overflow"))?,
                    time::Time::MIDNIGHT,
                )
                .assume_offset(*offset)
                .to_offset(UtcOffset::UTC);
                Ok((start, end))
            }
            Self::Windows(timezone) => timezone.day_bounds(date),
        }
    }
}

impl From<UtcOffset> for TimeZoneContext {
    fn from(value: UtcOffset) -> Self {
        Self::Fixed(value)
    }
}

impl From<WindowsTimeZone> for TimeZoneContext {
    fn from(value: WindowsTimeZone) -> Self {
        Self::Windows(Box::new(value))
    }
}
