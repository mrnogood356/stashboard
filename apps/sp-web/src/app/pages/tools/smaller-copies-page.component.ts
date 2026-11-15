import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  SmallerCopies,
  SmallerCopiesApiService,
  SmallerCopySettings,
} from '../../core/api/smaller-copies.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const OUTCOMES: Record<string, string> = {
  grabbed: 'Grabbed',
  found: 'Match waiting',
  'none-found': 'Nothing yet',
  'no-catalog-id': 'Not matched',
  failed: 'Search failed',
  replaced: 'Replaced',
  'kept-both': 'Kept both',
};

export type BetterCopiesTab = 'overview' | 'matches' | 'rules';
export type BetterCopiesPreset = 'save-space' | 'better-quality' | 'both';

type PresetRules = Pick<
  SmallerCopySettings,
  | 'replaceHigher'
  | 'upgradeLower'
  | 'maxGbPerHour'
  | 'minSavingsPercent'
  | 'minNewGbPerHour'
  | 'codec'
  | 'prefer'
>;

/**
 * What each preset means. "Heavy" at 1080p is over about 6 GB an hour; a new
 * copy under 1.5 GB an hour is usually a starved re-encode.
 */
export const PRESETS: Record<
  BetterCopiesPreset,
  { label: string; detail: string; rules: PresetRules }
> = {
  'save-space': {
    label: 'Save space',
    detail: 'Swap 4K and heavy files for a lighter copy that looks the same.',
    rules: {
      replaceHigher: true,
      upgradeLower: false,
      maxGbPerHour: 6,
      minSavingsPercent: 25,
      minNewGbPerHour: 1.5,
      codec: 'prefer-efficient',
      prefer: 'largest',
    },
  },
  'better-quality': {
    label: 'Better quality',
    detail: 'Swap low-resolution files for one at your resolution, even if bigger.',
    rules: {
      replaceHigher: false,
      upgradeLower: true,
      maxGbPerHour: null,
      minSavingsPercent: 0,
      minNewGbPerHour: 2,
      codec: 'any',
      prefer: 'largest',
    },
  },
  both: {
    label: 'Both',
    detail: 'Lighter copies of heavy files, and better ones of low-resolution files.',
    rules: {
      replaceHigher: true,
      upgradeLower: true,
      maxGbPerHour: 6,
      minSavingsPercent: 25,
      minNewGbPerHour: 1.5,
      codec: 'prefer-efficient',
      prefer: 'largest',
    },
  },
};

/**
 * Library tools → Better copies: finds a better copy of a scene (smaller, or
 * higher quality, as the rules say), grabs it, and swaps it in once Stash
 * has it and it checks out. Overview of what it's doing, the matches waiting
 * for you, and the rules, as three tabs.
 */
@Component({
  selector: 'app-better-copies-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './smaller-copies-page.component.html',
  styleUrls: ['./tools-shared.scss', './smaller-copies-page.component.scss'],
})
export class SmallerCopiesPageComponent implements OnInit {
  private readonly api = inject(SmallerCopiesApiService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly data = signal<SmallerCopies | null>(null);
  protected readonly error = signal(false);
  protected readonly saving = signal(false);
  protected readonly searching = signal(false);
  /** Scenes with a grab on its way; each button stays off until its own answer. */
  protected readonly grabbing = signal<ReadonlySet<string>>(new Set());
  /** The form's copy, saved with Save. */
  protected form: SmallerCopySettings | null = null;
  protected studios = '';
  protected readonly hours = Array.from({ length: 24 }, (_, hour) => hour);
  protected readonly tab = signal<BetterCopiesTab>('overview');
  protected readonly presets = Object.entries(PRESETS).map(([id, preset]) => ({
    id: id as BetterCopiesPreset,
    ...preset,
  }));
  /** The preset the rules match now; null when fine-tuned past them. */
  protected readonly preset = signal<BetterCopiesPreset | null>(null);
  /** Matches waiting for you to grab. */
  protected readonly matches = computed(() =>
    (this.data()?.recent ?? []).filter((row) => row.canGrab),
  );
  /** Everything else it did lately. */
  protected readonly activity = computed(() =>
    (this.data()?.recent ?? []).filter((row) => !row.canGrab),
  );

  ngOnInit(): void {
    this.api.status().subscribe({
      next: (data) => this.show(data),
      error: () => this.error.set(true),
    });
  }

  protected pickPreset(id: BetterCopiesPreset): void {
    if (!this.form) {
      return;
    }
    this.form = { ...this.form, ...PRESETS[id].rules };
    this.preset.set(id);
  }

  /** After a rule is changed by hand: which preset it still matches, if any. */
  protected rulesChanged(): void {
    this.preset.set(this.form ? presetOf(this.form) : null);
  }

  /** The on/off switch saves at once; the rest waits for Save. */
  protected toggleEnabled(enabled: boolean): void {
    const data = this.data();
    if (!data) {
      return;
    }
    if (this.form) {
      this.form = { ...this.form, enabled };
    }
    this.persist(
      { ...data.settings, enabled },
      enabled ? 'Better copies is on.' : 'Better copies is off.',
    );
  }

  protected hourLabel(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  protected outcomeLabel(outcome: string): string {
    return OUTCOMES[outcome] ?? outcome;
  }

  protected gb(bytes: number | null): string {
    return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '';
  }

  /** The running total, or nothing before the first replacement. */
  protected savedText(saved: SmallerCopies['saved'] | undefined): string {
    if (!saved || saved.scenes <= 0) {
      return '';
    }
    const scenes = `${saved.scenes} scene${saved.scenes === 1 ? '' : 's'}`;
    const size = (bytes: number) =>
      bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(2)} TB` : this.gb(bytes) || '0 GB';
    return saved.bytes >= 0
      ? `Given back ${size(saved.bytes)} so far, across ${scenes} replaced.`
      : `${scenes} replaced so far, using ${size(-saved.bytes)} more than before (upgrades are bigger).`;
  }

  protected when(iso: string | null): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
  }

  protected save(): void {
    if (!this.form) {
      return;
    }
    const settings: SmallerCopySettings = {
      ...this.form,
      studioNames: this.studios
        .split(/\n|,/)
        .map((name) => name.trim())
        .filter(Boolean),
    };
    this.persist(settings, 'Better copies uses the new rules.');
  }

  private persist(settings: SmallerCopySettings, done: string): void {
    this.saving.set(true);
    this.api.save(settings).subscribe({
      next: (data) => {
        this.saving.set(false);
        this.show(data);
        this.notifications.success('Saved', data.blocked ?? done);
      },
      error: () => {
        this.saving.set(false);
        this.notifications.error("Couldn't save that", 'Check the numbers and try again.');
      },
    });
  }

  protected searchNow(): void {
    this.searching.set(true);
    this.api.searchNow().subscribe({
      next: (data) => {
        this.searching.set(false);
        this.data.set(data);
        if (data.notice) {
          this.notifications.info('Nothing searched', data.notice);
        }
      },
      error: () => {
        this.searching.set(false);
        this.notifications.error("Couldn't search", 'Try again in a moment.');
      },
    });
  }

  protected isGrabbing(stashSceneId: string): boolean {
    return this.grabbing().has(stashSceneId);
  }

  protected grab(stashSceneId: string): void {
    if (this.grabbing().has(stashSceneId)) {
      return;
    }
    const done = () =>
      this.grabbing.update((set) => {
        const next = new Set(set);
        next.delete(stashSceneId);
        return next;
      });
    this.grabbing.update((set) => new Set(set).add(stashSceneId));
    this.api.grab(stashSceneId).subscribe({
      next: (data) => {
        done();
        this.data.set(data);
        this.notifications.success('Grabbed', 'Sent to SABnzbd.');
      },
      error: (error: { error?: { message?: string } }) => {
        done();
        this.notifications.error(
          "Couldn't grab it",
          error.error?.message ?? 'Try again in a moment.',
        );
      },
    });
  }

  private show(data: SmallerCopies): void {
    this.data.set(data);
    this.form = { ...data.settings };
    this.studios = data.settings.studioNames.join('\n');
    this.preset.set(presetOf(data.settings));
  }
}

/** The preset these rules are, or null when they've been fine-tuned past all of them. */
export function presetOf(settings: SmallerCopySettings): BetterCopiesPreset | null {
  for (const [id, preset] of Object.entries(PRESETS)) {
    const same = (Object.keys(preset.rules) as Array<keyof PresetRules>).every(
      (key) => settings[key] === preset.rules[key],
    );
    if (same) {
      return id as BetterCopiesPreset;
    }
  }
  return null;
}
