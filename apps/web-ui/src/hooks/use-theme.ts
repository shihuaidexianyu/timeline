import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'timeline-theme'

function getSystemIsDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function getStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw
    }
  } catch {
    // ignore
  }
  return 'system'
}

function storeTheme(value: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // ignore
  }
}

function applyTheme(mode: ThemeMode) {
  const isDark = mode === 'dark' || (mode === 'system' && getSystemIsDark())
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme())
  const [systemIsDark, setSystemIsDark] = useState(() => getSystemIsDark())

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      setSystemIsDark(mq.matches)
      if (theme === 'system') {
        applyTheme('system')
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  function setTheme(next: ThemeMode) {
    storeTheme(next)
    setThemeState(next)
  }

  const resolvedTheme: 'light' | 'dark' =
    theme === 'dark' || (theme === 'system' && systemIsDark) ? 'dark' : 'light'
  return { theme, resolvedTheme, setTheme }
}
