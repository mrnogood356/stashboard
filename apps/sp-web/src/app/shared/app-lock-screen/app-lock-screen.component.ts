import { Component, ElementRef, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from '../../core/api/auth.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import { reportToServer } from '../../core/logging/client-log';

const PIN_MAX = 8;

/** Full-screen lock: PIN keypad, plus Face ID when it's set up and on HTTPS. */
@Component({
  selector: 'app-lock-screen',
  templateUrl: './app-lock-screen.component.html',
  styleUrl: './app-lock-screen.component.scss',
  host: {
    '(document:keydown)': 'onKey($event)',
  },
})
export class AppLockScreenComponent {
  protected readonly appLock = inject(AppLockService);
  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The page behind the lock, made unreachable (Tab, screen readers) while locked. */
  private madeInert: HTMLElement[] = [];

  @ViewChild('panel') private panelRef?: ElementRef<HTMLElement>;

  protected readonly pin = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly shake = signal(false);
  protected readonly dots = computed(() =>
    Array.from({ length: Math.max(4, this.pin().length) }, (_, i) => i < this.pin().length),
  );
  protected readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  private faceIdTried = false;

  constructor() {
    // Offer Face ID straight away when the lock appears.
    effect(() => {
      if (this.appLock.locked() && this.appLock.faceIdReady() && !this.faceIdTried) {
        this.faceIdTried = true;
        setTimeout(() => void this.useFaceId(true), 150);
      }
      if (!this.appLock.locked()) {
        this.faceIdTried = false;
        this.pin.set('');
        this.error.set(null);
      }
    });
    effect(() => this.setPageInert(this.appLock.locked()));
  }

  private setPageInert(locked: boolean): void {
    this.madeInert.forEach((element) => (element.inert = false));
    this.madeInert = [];
    if (!locked) {
      return;
    }
    const siblings = Array.from(this.host.nativeElement.parentElement?.children ?? []);
    this.madeInert = siblings.filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== this.host.nativeElement && !element.inert,
    );
    this.madeInert.forEach((element) => (element.inert = true));
  }

  protected press(digit: string): void {
    if (this.busy() || this.pin().length >= PIN_MAX) {
      return;
    }
    this.error.set(null);
    this.pin.update((value) => value + digit);
  }

  protected backspace(): void {
    this.pin.update((value) => value.slice(0, -1));
  }

  protected async submit(): Promise<void> {
    if (this.pin().length < 4 || this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.appLock.unlockWithPin(this.pin());
    } catch (error) {
      this.error.set(this.appLock.describeError(error));
      reportToServer('warn', `Unlock with PIN failed: ${this.error()}`, error);
      this.pin.set('');
      this.shake.set(true);
      setTimeout(() => this.shake.set(false), 450);
      navigator.vibrate?.(80);
    } finally {
      this.busy.set(false);
    }
  }

  protected async useFaceId(automatic = false): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.appLock.unlockWithFaceId();
    } catch (error) {
      // An automatic prompt that iOS blocked (no tap yet) shouldn't look like an error.
      if (!automatic) {
        this.error.set(this.appLock.describeError(error));
      }
      reportToServer(
        automatic ? 'info' : 'warn',
        `Unlock with Face ID failed${automatic ? ' (automatic prompt)' : ''}: ${this.appLock.describeError(error)}`,
        error,
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected logOut(): void {
    this.auth.logout().subscribe({
      complete: () => window.location.assign('/login'),
      error: () => window.location.assign('/login'),
    });
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.appLock.locked()) {
      return;
    }
    if (/^\d$/.test(event.key)) {
      this.press(event.key);
    } else if (event.key === 'Backspace') {
      this.backspace();
    } else if (event.key === 'Enter') {
      // Enter on a focused button ("Log out instead", Face ID) presses that button.
      if (event.target instanceof HTMLButtonElement) {
        return;
      }
      void this.submit();
    } else {
      return;
    }
    event.preventDefault();
  }
}
