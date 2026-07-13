export type ResolvedTheme = 'light' | 'dark'

/** Explicit ECharts palette. Keeping this pure makes theme changes deterministic. */
export function getEChartsThemeTokens(theme: ResolvedTheme) {
  return theme === 'dark'
    ? {
        panel: '#1e2028',
        border: '#2d3039',
        text: '#e8eaed',
        textSoft: '#9aa0ab',
        grid: 'rgba(154, 160, 171, 0.20)',
      }
    : {
        panel: '#ffffff',
        border: '#e2e5ea',
        text: '#1f2329',
        textSoft: '#5f6773',
        grid: 'rgba(125, 142, 165, 0.18)',
      }
}
