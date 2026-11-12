import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import {
  IDLE_OPTIONS,
  QuickHideService,
  QuickHideSettings,
} from '../../core/quick-hide/quick-hide.service';

export const LOCK_TIMEOUT_OPTIONS = [
  { value: 0, label: 'Immediately' },
  { value: 60, label: 'After 1 minute' },
  { value: 300, label: 'After 5 minutes' },
  { value: 900, label: 'After 15 minutes' },
  { value: 3600, label: 'After 1 hour' },
];

@Component({
  selector: 'app-settings-privacy-page',
  imports: [FormsModule],
  templateUrl: './settings-privacy-page.component.html',
  styleUrls: ['./settings-privacy-page.component.scss', './settings-shared.scss'],
})
export class SettingsPrivacyPageComponent implements OnInit {
  protected readonly appLock = inject(AppLockService);
  protected readonly timeoutOptions = LOCK_TIMEOUT_OPTIONS;
  protected readonly quickHide = inject(QuickHideService);
  protected readonly idleOptions = IDLE_OPTIONS;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly faceIdBusy = signal(false);
  protected readonly message = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);

  protected enabled = false;
  protected timeoutSeconds = 60;
  protected hideInSwitcher = true;
  protected pin = '';
  protected pinConfirm = '';
  protected currentPassword = '';
  /** What the server has, so the password and Save only show for a change. */
  private saved = { enabled: false, timeoutSeconds: 60, hideInSwitcher: true };

  protected readonly hasPin = computed(() => this.appLock.status()?.hasPin ?? false);
  protected readonly passkeys = computed(() => this.appLock.status()?.passkeys ?? []);
  protected readonly isHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:';

  /** The App Lock settings couldn't be read: nothing to compare a change with. */
  protected readonly loadFailed = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    const status = await this.appLock.refresh();
    this.loadFailed.set(!status);
    if (status) {
      this.enabled = status.enabled;
      this.timeoutSeconds = status.timeoutSeconds;
      this.hideInSwitcher = status.hideInSwitcher;
      this.saved = {
        enabled: status.enabled,
        timeoutSeconds: status.timeoutSeconds,
        hideInSwitcher: status.hideInSwitcher,
      };
    }
    this.loading.set(false);
  }

  protected setQuickHide(change: Partial<QuickHideSettings>): void {
    this.quickHide.save({ ...this.quickHide.settings(), ...change });
  }

  /** Something on the App Lock card differs from what's saved. */
  protected changed(): boolean {
    return (
      this.enabled !== this.saved.enabled ||
      this.timeoutSeconds !== this.saved.timeoutSeconds ||
      this.hideInSwitcher !== this.saved.hideInSwitcher ||
      !!this.pin ||
      !!this.pinConfirm
    );
  }

  protected pinNeeded(): boolean {
    return this.enabled && !this.hasPin();
  }

  protected validationError(): string | null {
    if (this.pin || this.pinConfirm || this.pinNeeded()) {
      if (!/^\d{4,8}$/.test(this.pin)) {
        return 'Use a PIN of 4 to 8 digits.';
      }
      if (this.pin !== this.pinConfirm) {
        return "The PINs don't match.";
      }
    }
    if (!this.currentPassword) {
      return 'Enter your account password to save.';
    }
    return null;
  }

  protected async save(): Promise<void> {
    const problem = this.validationError();
    if (problem) {
      this.message.set({ kind: 'error', text: problem });
      return;
    }
    this.saving.set(true);
    this.message.set(null);
    // What's sent is what's saved: a switch changed while this is on its way
    // stays a change, with Save still showing.
    const submitted = {
      enabled: this.enabled,
      timeoutSeconds: this.timeoutSeconds,
      hideInSwitcher: this.hideInSwitcher,
    };
    try {
      await this.appLock.saveSettings({
        ...submitted,
        pin: this.pin || undefined,
        currentPassword: this.currentPassword,
      });
      this.pin = '';
      this.pinConfirm = '';
      this.currentPassword = '';
      this.saved = submitted;
      this.message.set({
        kind: 'ok',
        text: submitted.enabled ? 'App Lock is on.' : 'Saved.',
      });
    } catch (error) {
      this.message.set({ kind: 'error', text: this.appLock.describeError(error) });
    } finally {
      this.saving.set(false);
    }
  }

  protected async setUpFaceId(): Promise<void> {
    this.faceIdBusy.set(true);
    this.message.set(null);
    try {
      await this.appLock.registerFaceId();
      this.message.set({ kind: 'ok', text: 'Face ID is set up for this device.' });
    } catch (error) {
      this.message.set({ kind: 'error', text: this.appLock.describeError(error) });
    } finally {
      this.faceIdBusy.set(false);
    }
  }

  protected async removeFaceId(id: string): Promise<void> {
    this.faceIdBusy.set(true);
    try {
      await this.appLock.removeFaceId(id);
    } catch (error) {
      this.message.set({ kind: 'error', text: this.appLock.describeError(error) });
    } finally {
      this.faceIdBusy.set(false);
    }
  }
}
