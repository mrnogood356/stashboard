import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import {
  AppearanceSettings,
  CUSTOM_CSS_MAX_LENGTH,
  DENSITY_OPTIONS,
  MATERIAL_OPTIONS,
  FONT_SCALE_OPTIONS,
  MODE_OPTIONS,
  RADIUS_OPTIONS,
  sameAppearance,
} from '../../core/theme/appearance.types';
import { contrastRatio, isHexColor } from '../../core/theme/color-contrast';
import { UI_CONTRAST, accentTokens } from '../../core/theme/theme-tokens';
import { ThemeService } from '../../core/theme/theme.service';
import {
  ACCENT_SWATCHES,
  DARK_THEMES,
  LIGHT_THEMES,
  ThemeDefinition,
  darkThemeOrDefault,
  lightThemeOrDefault,
} from '../../core/theme/themes';

type Message = { kind: 'ok' | 'error'; text: string };

/**
 * Settings → Appearance. Every change shows straight away; Save keeps it on
 * the server so the phone app and the desktop match. Leaving without saving
 * puts the saved look back.
 */
@Component({
  selector: 'app-settings-appearance-page',
  templateUrl: './settings-appearance-page.component.html',
  styleUrls: ['./settings-appearance-page.component.scss', './settings-shared.scss'],
})
export class SettingsAppearancePageComponent implements OnInit, OnDestroy {
  protected readonly theme = inject(ThemeService);

  protected readonly lightThemes = LIGHT_THEMES;
  protected readonly darkThemes = DARK_THEMES;
  protected readonly swatches = ACCENT_SWATCHES;
  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly radiusOptions = RADIUS_OPTIONS;
  protected readonly densityOptions = DENSITY_OPTIONS;
  protected readonly materialOptions = MATERIAL_OPTIONS;
  protected readonly fontScaleOptions = FONT_SCALE_OPTIONS;
  protected readonly customCssMax = CUSTOM_CSS_MAX_LENGTH;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly message = signal<Message | null>(null);
  protected readonly draft = signal<AppearanceSettings>(this.theme.saved());
  /** Open when CSS is saved; then it stays as you leave it, even if you clear the box. */
  protected readonly cssOpen = signal(this.theme.saved().customCss.length > 0);
  /** What's typed in the hex field, which may be half-typed. */
  protected readonly hexInput = signal('');

  protected readonly dirty = computed(() => !sameAppearance(this.draft(), this.theme.saved()));
  protected readonly activeTheme = this.theme.activeTheme;

  protected readonly accentInUse = computed(
    () => this.draft().accentColor ?? this.activeTheme().palette.accent,
  );

  /** How the accent reads on the current theme's cards, and whether it was nudged. */
  protected readonly accentReport = computed(() => {
    const theme = this.activeTheme();
    const picked = this.accentInUse();
    const shown = accentTokens(picked, theme.palette.surface1, theme.scheme)['--accent'];
    return {
      ratio: contrastRatio(picked, theme.palette.surface1),
      adjusted: shown.toLowerCase() !== picked.toLowerCase(),
      minimum: UI_CONTRAST,
    };
  });

  async ngOnInit(): Promise<void> {
    await this.theme.syncFromServer();
    this.draft.set(this.theme.saved());
    this.hexInput.set(this.draft().accentColor ?? '');
    this.cssOpen.set(this.draft().customCss.length > 0);
    this.loading.set(false);
  }

  ngOnDestroy(): void {
    this.theme.revertPreview();
  }

  protected update(patch: Partial<AppearanceSettings>): void {
    this.draft.update((current) => ({ ...current, ...patch }));
    this.message.set(null);
    this.theme.preview(this.draft());
  }

  protected pickTheme(theme: ThemeDefinition): void {
    const mode = this.draft().mode;
    if (theme.scheme === 'light') {
      // Show it now: in fixed dark mode a light theme would otherwise stay hidden.
      this.update({ lightTheme: theme.id, mode: mode === 'system' ? 'system' : 'light' });
    } else {
      this.update({ darkTheme: theme.id, mode: mode === 'system' ? 'system' : 'dark' });
    }
  }

  protected isSelected(theme: ThemeDefinition): boolean {
    const draft = this.draft();
    return theme.scheme === 'light'
      ? lightThemeOrDefault(draft.lightTheme).id === theme.id
      : darkThemeOrDefault(draft.darkTheme).id === theme.id;
  }

  protected isShowing(theme: ThemeDefinition): boolean {
    return this.activeTheme().id === theme.id;
  }

  /** Mini preview colours: the theme's palette with the chosen accent. */
  protected previewAccent(theme: ThemeDefinition): string {
    const accent = this.draft().accentColor ?? theme.palette.accent;
    return accentTokens(accent, theme.palette.surface1, theme.scheme)['--accent'];
  }

  protected pickAccent(value: string | null): void {
    this.hexInput.set(value ?? '');
    this.update({ accentColor: value ? value.toLowerCase() : null });
  }

  protected onColorInput(event: Event): void {
    this.pickAccent((event.target as HTMLInputElement).value);
  }

  protected onHexInput(event: Event): void {
    let value = (event.target as HTMLInputElement).value.trim();
    if (value && !value.startsWith('#')) {
      value = `#${value}`;
    }
    this.hexInput.set(value);
    if (isHexColor(value)) {
      this.update({ accentColor: value.toLowerCase() });
    }
  }

  protected onCustomCssInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value.slice(0, CUSTOM_CSS_MAX_LENGTH);
    this.update({ customCss: value });
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    this.message.set(null);
    try {
      const saved = await this.theme.save(this.draft());
      this.draft.set(saved);
      this.message.set({ kind: 'ok', text: 'Saved. Your other devices pick it up next time.' });
    } catch {
      this.message.set({ kind: 'error', text: "Couldn't save the appearance. Try again." });
    } finally {
      this.saving.set(false);
    }
  }

  protected discard(): void {
    this.theme.revertPreview();
    this.draft.set(this.theme.saved());
    this.hexInput.set(this.draft().accentColor ?? '');
    this.message.set(null);
  }

  protected async resetToDefaults(): Promise<void> {
    this.saving.set(true);
    this.message.set(null);
    try {
      const saved = await this.theme.resetToDefaults();
      this.draft.set(saved);
      this.hexInput.set('');
      this.message.set({ kind: 'ok', text: 'Back to the default look.' });
    } catch {
      this.message.set({ kind: 'error', text: "Couldn't reset the appearance. Try again." });
    } finally {
      this.saving.set(false);
    }
  }
}
