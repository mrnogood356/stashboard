import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/api/auth.service';
import { HealthService } from '../../core/api/health.service';
import { PASSKEY_SUPPORT } from './passkey-support';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss',
})
export class LoginPageComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly healthService = inject(HealthService);
  private readonly router = inject(Router);
  private readonly passkeySupport = inject(PASSKEY_SUPPORT);

  protected readonly submitting = signal(false);
  protected readonly passkeyBusy = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly showPassword = signal(false);
  protected readonly version = signal<string | null>(null);
  /** Set when signing in found no admin account, though the status said otherwise. */
  private readonly bootstrapFound = signal(false);

  /** Face ID only where it can work: a passkey exists and this browser and site allow it. */
  protected readonly showPasskey = computed(
    () => this.authService.status()?.passkeySignIn === true && this.passkeySupport(),
  );
  protected readonly bootstrapRequired = computed(
    () => this.bootstrapFound() || this.authService.status()?.bootstrapRequired === true,
  );
  protected readonly busy = computed(() => this.submitting() || this.passkeyBusy());

  protected readonly form = new FormGroup({
    username: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(3), Validators.maxLength(64)],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    rememberMe: new FormControl(true, { nonNullable: true }),
  });

  ngOnInit(): void {
    // The route guard has normally just asked; this covers it failing.
    if (!this.authService.status()) {
      this.authService.refreshStatus().subscribe({ error: () => undefined });
    }
    this.healthService.getStatus().subscribe({
      next: (status) => this.version.set(status.version || null),
      error: () => undefined,
    });
  }

  protected togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  protected submit(): void {
    this.errorMessage.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.errorMessage.set(describeInvalidForm(this.form));
      return;
    }

    this.submitting.set(true);
    this.authService.login(this.form.getRawValue()).subscribe({
      next: () => {
        this.submitting.set(false);
        void this.router.navigateByUrl('/');
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        if (error instanceof HttpErrorResponse && error.status === 409) {
          this.bootstrapFound.set(true);
        }
        this.errorMessage.set(describeLoginError(error));
      },
    });
  }

  protected async signInWithPasskey(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.errorMessage.set(null);
    this.passkeyBusy.set(true);
    try {
      await this.authService.loginWithPasskey(this.form.controls.rememberMe.value);
      void this.router.navigateByUrl('/');
    } catch (error) {
      this.errorMessage.set(describePasskeyError(error));
    } finally {
      this.passkeyBusy.set(false);
    }
  }
}

function describeInvalidForm(form: LoginPageComponent['form']): string {
  const { username, password } = form.controls;
  if (username.invalid) {
    return username.value.trim() ? 'Usernames are 3 to 64 characters.' : 'Enter your username.';
  }
  return password.invalid ? 'Enter your password.' : 'Check the details and try again.';
}

function describeLoginError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 401) {
      return 'Invalid username or password.';
    }

    if (error.status === 429) {
      return readApiMessage(error) ?? 'Too many login attempts. Wait a minute and try again.';
    }

    if (error.status === 409) {
      return 'No admin account exists yet. Complete first-run bootstrap instead.';
    }

    if (error.status === 0) {
      return "Couldn't reach Stashboard. Check your connection and try again.";
    }

    return readApiMessage(error) ?? 'Failed to sign in.';
  }

  return 'Failed to sign in.';
}

function describePasskeyError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 429) {
      return readApiMessage(error) ?? 'Too many tries. Wait a minute and try again.';
    }
    if (error.status === 401 || error.status === 403) {
      return "Face ID didn't match a passkey for this Stashboard. Sign in with your password.";
    }
    if (error.status === 0) {
      return "Couldn't reach Stashboard. Check your connection and try again.";
    }
    return readApiMessage(error) ?? 'Face ID sign-in failed. Sign in with your password.';
  }

  // The browser's own errors: cancelled, timed out, or no passkey on this device.
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'Face ID was cancelled or timed out.';
  }
  return 'Face ID sign-in failed. Sign in with your password.';
}

function readApiMessage(error: HttpErrorResponse): string | null {
  const message = (error.error as { message?: unknown } | null)?.message;
  if (Array.isArray(message) && message.length > 0) {
    return typeof message[0] === 'string' ? message[0] : null;
  }

  return typeof message === 'string' ? message : null;
}
