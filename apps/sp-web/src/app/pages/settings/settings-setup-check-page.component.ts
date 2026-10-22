import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  SetupCheck,
  SetupCheckApiService,
  SetupCheckStatus,
} from '../../core/api/setup-check.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const STATUS_LABEL: Record<SetupCheckStatus, string> = {
  ok: 'Good',
  warn: 'Worth a look',
  fail: 'Needs fixing',
  skip: 'Not checked',
};

const STATUS_ICON: Record<SetupCheckStatus, string> = {
  ok: 'pi pi-check-circle',
  warn: 'pi pi-exclamation-triangle',
  fail: 'pi pi-times-circle',
  skip: 'pi pi-minus-circle',
};

/** Looks over the whole setup and says what to change, fixing what it safely can. */
@Component({
  selector: 'app-settings-setup-check-page',
  imports: [RouterLink],
  templateUrl: './settings-setup-check-page.component.html',
  styleUrls: ['./settings-setup-check-page.component.scss', './settings-shared.scss'],
})
export class SettingsSetupCheckPageComponent implements OnInit {
  private readonly api = inject(SetupCheckApiService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly checks = signal<SetupCheck[] | null>(null);
  protected readonly checkedAt = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fixing = signal<string | null>(null);
  protected readonly open = signal<ReadonlySet<string>>(new Set());

  protected readonly counts = computed(() => {
    const checks = this.checks() ?? [];
    const count = (status: SetupCheckStatus) =>
      checks.filter((check) => check.status === status).length;
    return { fail: count('fail'), warn: count('warn') };
  });

  protected readonly headline = computed(() => {
    const { fail, warn } = this.counts();
    if (fail > 0) {
      return fail === 1 ? '1 thing needs fixing' : `${fail} things need fixing`;
    }
    if (warn > 0) {
      return warn === 1 ? '1 thing is worth a look' : `${warn} things are worth a look`;
    }
    return 'Everything looks good';
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.run().subscribe({
      next: (result) => {
        this.checks.set(result.checks);
        this.checkedAt.set(result.checkedAt);
        // Open what needs attention, so the how-to is right there.
        this.open.set(
          new Set(
            result.checks
              .filter((check) => check.status === 'fail' && check.detail)
              .map((check) => check.id),
          ),
        );
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Couldn’t run the setup check. Try again in a moment.');
      },
    });
  }

  protected toggle(id: string): void {
    const next = new Set(this.open());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.open.set(next);
  }

  protected applyFix(check: SetupCheck): void {
    if (!check.fix || this.fixing()) {
      return;
    }
    this.fixing.set(check.id);
    this.api.fix(check.fix.action).subscribe({
      next: (result) => {
        this.fixing.set(null);
        this.notifications.success('Fixed', result.message);
        this.load();
      },
      error: (error) => {
        this.fixing.set(null);
        this.notifications.error(
          'Couldn’t fix it',
          error?.error?.message ?? 'Try again in a moment.',
        );
      },
    });
  }

  protected statusLabel(status: SetupCheckStatus): string {
    return STATUS_LABEL[status];
  }

  protected statusIcon(status: SetupCheckStatus): string {
    return STATUS_ICON[status];
  }

  protected time(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}
