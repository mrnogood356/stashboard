import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppearanceSettings, DEFAULT_APPEARANCE } from '../../core/theme/appearance.types';
import { ThemeService } from '../../core/theme/theme.service';
import { darkThemeOrDefault, lightThemeOrDefault } from '../../core/theme/themes';
import { SettingsAppearancePageComponent } from './settings-appearance-page.component';

describe('SettingsAppearancePageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(initial: Partial<AppearanceSettings> = {}) {
    const saved = signal<AppearanceSettings>({ ...DEFAULT_APPEARANCE, ...initial });
    const shown = signal<AppearanceSettings>(saved());
    const systemPrefersDark = signal(false);
    const mode = computed(() => {
      const m = shown().mode;
      return m === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : m;
    });
    const theme = {
      saved,
      settings: shown,
      systemPrefersDark,
      theme: mode,
      activeTheme: computed(() =>
        mode() === 'dark'
          ? darkThemeOrDefault(shown().darkTheme)
          : lightThemeOrDefault(shown().lightTheme),
      ),
      syncFromServer: vi.fn().mockResolvedValue(undefined),
      preview: vi.fn((next: AppearanceSettings) => shown.set(next)),
      revertPreview: vi.fn(() => shown.set(saved())),
      save: vi.fn((next: AppearanceSettings) => {
        saved.set(next);
        shown.set(next);
        return Promise.resolve(next);
      }),
      resetToDefaults: vi.fn(() => {
        saved.set(DEFAULT_APPEARANCE);
        shown.set(DEFAULT_APPEARANCE);
        return Promise.resolve(DEFAULT_APPEARANCE);
      }),
    };
    await TestBed.configureTestingModule({
      imports: [SettingsAppearancePageComponent],
      providers: [{ provide: ThemeService, useValue: theme }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsAppearancePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const click = (testId: string) => {
      (el.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
      fixture.detectChanges();
    };
    return { fixture, theme, el, click };
  }

  it('loads the saved appearance and shows every built-in theme', async () => {
    const { theme, el } = await render({ darkTheme: 'nord' });
    expect(theme.syncFromServer).toHaveBeenCalled();
    const cards = el.querySelectorAll('.theme-card');
    expect(cards.length).toBe(19);
    expect(el.querySelector('[data-testid="theme-nord"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(el.querySelector('[data-testid="theme-oled"]')?.textContent).toContain('OLED Black');
  });

  it('previews a picked theme straight away and only saves on Save', async () => {
    const { theme, el, click } = await render({ mode: 'light' });
    click('theme-oled');
    expect(theme.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ darkTheme: 'oled', mode: 'dark' }),
    );
    expect(theme.save).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Previewing unsaved changes.');

    click('appearance-save');
    await Promise.resolve();
    expect(theme.save).toHaveBeenCalledWith(
      expect.objectContaining({ darkTheme: 'oled', mode: 'dark' }),
    );
  });

  it('keeps System mode when picking a theme, only changing that slot', async () => {
    const { theme, click } = await render({ mode: 'system' });
    click('theme-catppuccin-latte');
    expect(theme.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ lightTheme: 'catppuccin-latte', mode: 'system' }),
    );
  });

  it('changes mode, radius, density and text size', async () => {
    const { theme, click } = await render();
    click('mode-dark');
    click('radius-sharp');
    click('density-compact');
    click('font-large');
    expect(theme.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'dark',
        radius: 'sharp',
        density: 'compact',
        fontScale: 'large',
      }),
    );
  });

  it('takes a typed hex accent once it is complete, and reports its contrast', async () => {
    const { fixture, theme, el } = await render();
    const input = el.querySelector('[data-testid="accent-hex"]') as HTMLInputElement;
    input.value = 'ff9f0';
    input.dispatchEvent(new Event('input'));
    expect(theme.preview).not.toHaveBeenCalled();

    input.value = 'FF9F0A';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(theme.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ accentColor: '#ff9f0a' }),
    );
    // Orange on a white card is below 3:1, so the page says it was adjusted.
    expect(el.querySelector('[data-testid="accent-contrast"]')?.textContent).toContain(
      'stays readable',
    );

    (el.querySelector('[data-testid="accent-default"]') as HTMLButtonElement).click();
    expect(theme.preview).toHaveBeenLastCalledWith(expect.objectContaining({ accentColor: null }));
  });

  it('caps custom CSS at the limit', async () => {
    const { theme, el } = await render();
    const textarea = el.querySelector('[data-testid="custom-css"]') as HTMLTextAreaElement;
    textarea.value = 'a'.repeat(25_000);
    textarea.dispatchEvent(new Event('input'));
    const last = theme.preview.mock.lastCall?.[0] as AppearanceSettings;
    expect(last.customCss.length).toBe(20_000);
  });

  it('puts the saved look back when leaving without saving', async () => {
    const { fixture, theme, click } = await render();
    click('theme-dracula');
    fixture.destroy();
    expect(theme.revertPreview).toHaveBeenCalled();
  });

  it('resets to the defaults', async () => {
    const { theme, click, el, fixture } = await render({ darkTheme: 'plex', radius: 'round' });
    click('appearance-reset');
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(theme.resetToDefaults).toHaveBeenCalled();
    expect(el.textContent).toContain('Back to the default look.');
  });
});
