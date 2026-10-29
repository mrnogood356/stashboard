import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { of } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { Message } from 'primeng/message';
import { RouterLink } from '@angular/router';
import { SetupCheckApiService } from '../../core/api/setup-check.service';
import { HealthService } from '../../core/api/health.service';
import { HealthStatusResponse } from '../../core/api/health.types';
import { integrationLabel } from '../../core/api/integrations.types';
import { SetupService } from '../../core/api/setup.service';
import { SetupStatusStore } from '../../core/api/setup-status.store';
import { SetupStatusResponse, summarizeDegradedSetupState } from '../../core/api/setup.types';
import { SETTINGS_SECTIONS, groupSettingsNav } from './settings-nav';

@Component({
  selector: 'app-settings-overview-page',
  imports: [SkeletonComponent, Message, RouterLink],
  templateUrl: './settings-overview-page.component.html',
  styleUrls: ['./settings-overview-page.component.scss', './settings-shared.scss'],
})
export class SettingsOverviewPageComponent implements OnInit {
  private readonly setupService = inject(SetupService);
  private readonly setupStatusStore = inject(SetupStatusStore);
  private readonly healthService = inject(HealthService);
  private readonly setupCheck = inject(SetupCheckApiService);

  /** How many setup checks failed, so the overview can point at them. */
  protected readonly sectionGroups = groupSettingsNav(SETTINGS_SECTIONS);
  protected readonly failingChecks = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly setupStatus = signal<SetupStatusResponse | null>(null);
  protected readonly health = signal<HealthStatusResponse | null>(null);

  protected readonly degradedState = computed(() =>
    summarizeDegradedSetupState(this.setupStatus()),
  );

  protected readonly readyCount = computed(() => {
    const status = this.setupStatus();
    if (!status) {
      return 0;
    }

    return (
      Number(status.required.catalog) +
      Number(status.required.stash) +
      Number(status.required.whisparr)
    );
  });

  protected readonly progressSummary = computed(() =>
    this.setupStatus()
      ? `${this.readyCount()} of 3 required services ready`
      : 'Required service status unavailable',
  );

  protected readonly catalogProviderLabel = computed(() => {
    const catalogProvider = this.setupStatus()?.catalogProvider;
    return catalogProvider ? integrationLabel(catalogProvider) : 'Not chosen';
  });

  protected readonly statusTone = computed<'good' | 'warn'>(() => {
    if (this.loadError() || !this.setupStatus()) {
      return 'warn';
    }

    return this.degradedState() ? 'warn' : 'good';
  });

  protected readonly statusLabel = computed(() =>
    this.loadError() || !this.setupStatus()
      ? 'Unavailable'
      : this.degradedState()
        ? 'Needs attention'
        : 'Healthy',
  );

  protected readonly statusLead = computed(() => {
    if (this.loadError() || !this.setupStatus()) {
      return 'Required service readiness could not be loaded right now.';
    }

    if (this.degradedState()) {
      return this.degradedState()!.message;
    }

    return 'Stash, Whisparr and the catalog are all connected.';
  });

  ngOnInit(): void {
    this.loadOverview();
    this.setupCheck
      .run()
      .pipe(catchError(() => of(null)))
      .subscribe((result) =>
        this.failingChecks.set(
          result?.checks.filter((check) => check.status === 'fail').length ?? 0,
        ),
      );
  }

  private loadOverview(): void {
    this.loading.set(true);
    this.loadError.set(null);

    this.setupService
      .getStatus()
      .pipe(
        catchError(() => of(null)),
        finalize(() => {
          this.loading.set(false);
        }),
      )
      .subscribe((setupStatus) => {
        if (!setupStatus) {
          this.loadError.set('Failed to load the latest integration readiness summary.');
          return;
        }

        this.setupStatus.set(setupStatus);
        this.setupStatusStore.sync(setupStatus);
      });

    this.healthService
      .getStatus()
      .pipe(catchError(() => of(null)))
      .subscribe((health) => {
        if (!health) {
          return;
        }

        this.health.set(health);
      });
  }
}
