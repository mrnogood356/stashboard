import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, OnDestroy, Signal, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AppearanceResponse,
  AppearanceSettings,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  sameAppearance,
} from './appearance.types';
import { applyAppearanceToDocument } from './theme-dom';
import { APPEARANCE_CACHE_KEY, AppearanceCache, buildAppearanceCache } from './theme-tokens';
import { ThemeDefinition, darkThemeOrDefault, lightThemeOrDefault } from './themes';

export type ThemeMode = 'light' | 'dark';

const API = '/api/appearance';
/** The header toggle's choice from before themes were saved on the server. */
const LEGACY_STORAGE_KEY = 'sp-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The app's look: which theme, accent, corner radius, density, text size and
 * custom CSS. Saved on the server (Settings → Appearance) so every device
 * matches, and cached on the device so the next load paints it straight away
 * (public/theme-boot.js).
 */
@Injectable({
  providedIn: 'root',
})
export class ThemeService implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly http = inject(HttpClient);

  /** What's on screen now: the saved settings, or a preview in Settings → Appearance. */
  private readonly settingsState = signal<AppearanceSettings>(DEFAULT_APPEARANCE);
  /** What the server holds (or the defaults until it has answered). */
  private readonly savedState = signal<AppearanceSettings>(DEFAULT_APPEARANCE);
  private readonly systemDark = signal(false);
  private readonly loadedState = signal(false);
  private mediaQuery: MediaQueryList | null = null;
  private readonly onSystemChange = (event: MediaQueryListEvent) => {
    this.systemDark.set(event.matches);
    if (this.settingsState().mode === 'system') {
      this.apply();
    }
  };

  readonly settings: Signal<AppearanceSettings> = this.settingsState.asReadonly();
  readonly saved: Signal<AppearanceSettings> = this.savedState.asReadonly();
  /** True once the server's settings have arrived. */
  readonly loaded: Signal<boolean> = this.loadedState.asReadonly();
  readonly systemPrefersDark: Signal<boolean> = this.systemDark.asReadonly();

  /** Light or dark right now (System resolved against the device). */
  readonly theme: Signal<ThemeMode> = computed(() => {
    const mode = this.settingsState().mode;
    if (mode === 'system') {
      return this.systemDark() ? 'dark' : 'light';
    }
    return mode;
  });

  readonly activeTheme: Signal<ThemeDefinition> = computed(() =>
    this.theme() === 'dark'
      ? darkThemeOrDefault(this.settingsState().darkTheme)
      : lightThemeOrDefault(this.settingsState().lightTheme),
  );

  constructor() {
    this.watchSystemScheme();
    const cached = this.readCache();
    const initial = cached?.settings ?? this.legacySettings() ?? DEFAULT_APPEARANCE;
    const normalized = normalizeAppearance(initial);
    this.settingsState.set(normalized);
    this.savedState.set(normalized);
    this.apply();
    if (cached) {
      // The cached colours may be from an older palette; the next reload paints today's.
      this.writeCache(normalized);
    }
  }

  ngOnDestroy(): void {
    this.mediaQuery?.removeEventListener?.('change', this.onSystemChange);
  }

  /** Fetches the saved appearance and applies it. Failures keep what's on screen. */
  async syncFromServer(): Promise<void> {
    try {
      const response = await firstValueFrom(this.http.get<AppearanceResponse>(API));
      let settings = normalizeAppearance(response);
      if (!response.updatedAt) {
        // Never saved: keep a light/dark choice made with the old toggle on this device.
        const legacy = this.legacySettings();
        if (legacy) {
          settings = { ...settings, mode: legacy.mode };
        }
      }
      this.adopt(settings);
      this.loadedState.set(true);
    } catch {
      // Signed out or offline: the cached look stays.
    }
  }

  /** Shows settings without saving them (Settings → Appearance while editing). */
  preview(settings: AppearanceSettings): void {
    this.settingsState.set(normalizeAppearance(settings));
    this.apply();
  }

  /** Puts the saved settings back on screen, dropping a preview. */
  revertPreview(): void {
    if (!sameAppearance(this.settingsState(), this.savedState())) {
      this.settingsState.set(this.savedState());
      this.apply();
    }
  }

  async save(settings: AppearanceSettings): Promise<AppearanceSettings> {
    const normalized = normalizeAppearance(settings);
    const response = await firstValueFrom(this.http.put<AppearanceResponse>(API, normalized));
    const saved = normalizeAppearance(response);
    this.adopt(saved);
    this.clearLegacy();
    return saved;
  }

  async resetToDefaults(): Promise<AppearanceSettings> {
    const response = await firstValueFrom(this.http.delete<AppearanceResponse>(API));
    const saved = normalizeAppearance(response);
    this.adopt(saved);
    this.clearLegacy();
    return saved;
  }

  /** Header toggle: switches between the chosen light and dark themes, and saves it. */
  toggleTheme(): void {
    this.setTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  setTheme(mode: ThemeMode): void {
    const next: AppearanceSettings = { ...this.savedState(), mode };
    // Keep an unsaved preview's other changes on screen, just flipped.
    this.settingsState.update((current) => ({ ...current, mode }));
    this.savedState.set(next);
    this.apply();
    this.writeCache(next);
    void firstValueFrom(this.http.put<AppearanceResponse>(API, next))
      .then(() => this.clearLegacy())
      .catch(() => undefined);
  }

  private adopt(settings: AppearanceSettings): void {
    this.savedState.set(settings);
    this.settingsState.set(settings);
    this.apply();
    this.writeCache(settings);
  }

  private apply(): void {
    applyAppearanceToDocument(this.document, this.settingsState(), this.theme());
  }

  private watchSystemScheme(): void {
    const view = this.document.defaultView;
    if (!view || typeof view.matchMedia !== 'function') {
      return;
    }
    this.mediaQuery = view.matchMedia(DARK_QUERY);
    this.systemDark.set(!!this.mediaQuery?.matches);
    this.mediaQuery?.addEventListener?.('change', this.onSystemChange);
  }

  private storage(): Storage | null {
    try {
      return this.document.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private readCache(): AppearanceCache | null {
    try {
      const raw = this.storage()?.getItem(APPEARANCE_CACHE_KEY);
      const parsed = raw ? (JSON.parse(raw) as AppearanceCache) : null;
      return parsed?.v === 1 && parsed.settings ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeCache(settings: AppearanceSettings): void {
    try {
      this.storage()?.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(buildAppearanceCache(settings)));
    } catch {
      // Private mode or full storage: the theme still applies, it just isn't remembered.
    }
  }

  private legacySettings(): AppearanceSettings | null {
    try {
      const value = this.storage()?.getItem(LEGACY_STORAGE_KEY);
      return value === 'light' || value === 'dark' ? { ...DEFAULT_APPEARANCE, mode: value } : null;
    } catch {
      return null;
    }
  }

  private clearLegacy(): void {
    try {
      this.storage()?.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
