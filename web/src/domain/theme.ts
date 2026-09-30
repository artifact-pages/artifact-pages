export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function resolveTheme(mode: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  return mode === 'system' ? systemTheme : mode
}

export function themeModeIcon(mode: ThemeMode): 'sun' | 'moon' | 'monitor' {
  if (mode === 'system') return 'monitor'
  return mode === 'dark' ? 'moon' : 'sun'
}
