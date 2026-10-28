import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, finalize, forkJoin, map, switchMap, tap } from 'rxjs';
import { ConfirmationService } from 'primeng/api';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { ProgressSpinner } from 'primeng/progressspinner';
import { HealthService } from '../../core/api/health.service';
import { HealthStatusResponse } from '../../core/api/health.types';
import { IntegrationsService } from '../../core/api/integrations.service';
import { OrganizerApiService, WhisparrPathCheck } from '../../core/api/organizer.service';
import {
  CatalogProviderType,
  IntegrationResponse,
  IntegrationType,
  ReadinessState,
  hasSavedIntegrationConfig,
  integrationLabel,
  integrationReadinessState,
  isCatalogProviderType,
} from '../../core/api/integrations.types';
import { RuntimeHealthService } from '../../core/api/runtime-health.service';
import { SetupService } from '../../core/api/setup.service';
import { SetupStatusStore } from '../../core/api/setup-status.store';
import { SetupStatusResponse } from '../../core/api/setup.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { FinishedDownloadsComponent } from '../../shared/finished-downloads/finished-downloads.component';
import {
  IntegrationRepairPanelComponent,
  IntegrationRepairPanelMessage,
} from '../../shared/integration-repair-panel/integration-repair-panel.component';
import {
  IntegrationActionState,
  IntegrationForm,
  buildIntegrationPayload,
  createActionStateRecord,
  createEmptyIntegrationsRecord,
  createIntegrationForm,
  defaultEnabledValue,
  describeMutationError,
  formatOptionalDateTime,
  mapIntegrationsByType,
  patchActionState,
} from '../../shared/integration-repair/integration-repair.utils';

@Component({
  selector: 'app-settings-integrations-page',
  imports: [
    ButtonDirective,
    Message,
    ProgressSpinner,
    IntegrationRepairPanelComponent,
    FinishedDownloadsComponent,
  ],
  templateUrl: './settings-integrations-page.component.html',
  styleUrls: ['./settings-integrations-page.component.scss', './settings-shared.scss'],
})
export class SettingsIntegrationsPageComponent implements OnInit {
  private readonly integrationsService = inject(IntegrationsService);
  private readonly setupService = inject(SetupService);
  private readonly setupStatusStore = inject(SetupStatusStore);
  private readonly healthService = inject(HealthService);
  private readonly runtimeHealthService = inject(RuntimeHealthService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly router = inject(Router);
  private readonly organizerApi = inject(OrganizerApiService);

  /** Anchor for links that open the Whisparr folder mapping directly. */
  protected readonly mappingAnchor = WHISPARR_MAPPING_ANCHOR;
  protected readonly mappingFrom = signal('');
  protected readonly mappingTo = signal('');
  protected readonly mappingLoaded = signal(false);
  protected readonly mappingLoadError = signal(false);
  protected readonly mappingCheck = signal<WhisparrPathCheck | null>(null);
  protected readonly checkingMapping = signal(false);
  protected readonly detectingMapping = signal(false);

  /** The one service whose details are open; the rest show as rows. */
  protected readonly openType = signal<IntegrationType | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly health = signal<HealthStatusResponse | null>(null);
  protected readonly setupStatus = signal<SetupStatusResponse | null>(null);
  protected readonly healthError = signal<string | null>(null);
  protected readonly refreshingHealth = signal(false);
  protected readonly resettingAll = signal(false);

  private readonly allServiceTypes: IntegrationType[] = [
    'STASH',
    'WHISPARR',
    'STASHDB',
    'FANSDB',
    'PROWLARR',
    'SABNZBD',
  ];

  protected readonly serviceTypes = computed<IntegrationType[]>(() => {
    const catalogProvider = this.catalogProvider();
    if (!catalogProvider) {
      return ['STASH', 'WHISPARR', 'PROWLARR', 'SABNZBD'];
    }
    // Once a provider is chosen, the other one can be added for browsing only.
    const browseProvider: IntegrationType = catalogProvider === 'STASHDB' ? 'FANSDB' : 'STASHDB';
    return ['STASH', 'WHISPARR', catalogProvider, browseProvider, 'PROWLARR', 'SABNZBD'];
  });
  protected readonly serviceTabs = this.serviceTypes;

  protected readonly checklistItems = computed<SettingsChecklistItem[]>(() => [
    this.catalogChecklistItem(),
    this.requiredChecklistItem('STASH'),
    this.requiredChecklistItem('WHISPARR'),
  ]);

  protected readonly readyCount = computed(
    () => this.checklistItems().filter((item) => item.ready).length,
  );

  protected readonly progressSummary = computed(
    () => `${this.readyCount()} of ${this.checklistItems().length} required services ready`,
  );

  protected readonly allRequiredReady = computed(
    () => this.readyCount() === this.checklistItems().length,
  );

  protected readonly forms: Record<IntegrationType, IntegrationForm> = {
    STASH: createIntegrationForm(),
    WHISPARR: createIntegrationForm(),
    PROWLARR: createIntegrationForm(),
    SABNZBD: createIntegrationForm(),
    STASHDB: createIntegrationForm(),
    FANSDB: createIntegrationForm(),
  };

  protected readonly integrations = signal<Record<IntegrationType, IntegrationResponse | null>>(
    createEmptyIntegrationsRecord(),
  );

  protected readonly saveState =
    signal<Record<IntegrationType, IntegrationActionState>>(createActionStateRecord());

  protected readonly saveAndTestState =
    signal<Record<IntegrationType, IntegrationActionState>>(createActionStateRecord());

  protected readonly resetState =
    signal<Record<IntegrationType, IntegrationActionState>>(createActionStateRecord());

  ngOnInit(): void {
    this.loadSettingsData();
    this.loadMapping();
  }

  protected mappingBusy(): boolean {
    return this.checkingMapping() || this.detectingMapping();
  }

  /** Saves the Whisparr folder mapping, then checks Whisparr can see a real file with it. */
  protected saveMapping(): void {
    this.checkingMapping.set(true);
    this.mappingCheck.set(null);
    this.organizerApi
      .update({
        whisparrPathFrom: this.mappingFrom().trim(),
        whisparrPathTo: this.mappingTo().trim(),
      })
      .pipe(
        tap((saved) => {
          this.mappingFrom.set(saved.whisparrPathFrom ?? '');
          this.mappingTo.set(saved.whisparrPathTo ?? '');
        }),
      )
      .subscribe({
        next: () => {
          this.organizerApi.checkWhisparrPath().subscribe({
            next: (check) => {
              this.checkingMapping.set(false);
              this.mappingCheck.set(check);
            },
            error: (error: { error?: { message?: string } }) => {
              this.checkingMapping.set(false);
              this.mappingCheck.set(failedPathCheck(error, 'Couldn’t reach Whisparr.'));
            },
          });
        },
        error: (error: { error?: { message?: string } }) => {
          this.checkingMapping.set(false);
          this.notifications.error('Couldn’t save', error?.error?.message ?? 'Try again.');
        },
      });
  }

  /** Lets Stashboard work out where Whisparr sees your media, and fills in both fields. */
  protected detectMapping(): void {
    this.detectingMapping.set(true);
    this.mappingCheck.set(null);
    this.organizerApi.detectWhisparrPath().subscribe({
      next: (result) => {
        this.detectingMapping.set(false);
        this.mappingCheck.set({
          ok: result.found,
          stashPath: null,
          whisparrPath: result.example,
          message: result.message,
        });
        if (result.found) {
          this.mappingFrom.set(result.from);
          this.mappingTo.set(result.to);
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.detectingMapping.set(false);
        this.mappingCheck.set(failedPathCheck(error, 'Couldn’t reach Whisparr.'));
      },
    });
  }

  private loadMapping(): void {
    this.organizerApi.settings().subscribe({
      next: (settings) => {
        this.mappingFrom.set(settings.whisparrPathFrom ?? '');
        this.mappingTo.set(settings.whisparrPathTo ?? '');
        this.mappingLoaded.set(true);
      },
      error: () => this.mappingLoadError.set(true),
    });
  }

  /** Opened from a "Change in Settings" link: bring the folder mapping into view. */
  private scrollToMappingIfLinked(): void {
    if (this.router.parseUrl(this.router.url).fragment !== WHISPARR_MAPPING_ANCHOR) {
      // Opened normally: the first service that needs fixing is open.
      this.openType.set(
        this.serviceTypes().find((type) => this.readinessState(type) === 'TEST_FAILED') ?? null,
      );
      return;
    }
    this.openType.set('WHISPARR');
    setTimeout(() => {
      document.getElementById(WHISPARR_MAPPING_ANCHOR)?.scrollIntoView?.({ block: 'start' });
    });
  }

  protected labelFor(type: IntegrationType): string {
    return integrationLabel(type);
  }

  protected isCatalogProvider(type: IntegrationType): boolean {
    return isCatalogProviderType(type);
  }

  /** The non-chosen catalog provider, which can be added for browsing only. */
  protected isBrowseProvider(type: IntegrationType): boolean {
    const catalogProvider = this.catalogProvider();
    return this.isCatalogProvider(type) && !!catalogProvider && catalogProvider !== type;
  }

  /** The chosen catalog provider that this instance is locked to. */
  private isInstanceCatalogProvider(type: IntegrationType): boolean {
    return this.isCatalogProvider(type) && !this.isBrowseProvider(type);
  }

  protected showEnabledToggle(type: IntegrationType): boolean {
    return !this.isCatalogProvider(type);
  }

  protected sectionLabel(type: IntegrationType): string {
    if (this.isBrowseProvider(type)) {
      return 'Optional browse provider';
    }

    if (this.isCatalogProvider(type)) {
      return this.catalogProvider() === type ? 'Chosen catalog provider' : 'Catalog provider';
    }

    return this.isOptionalService(type) ? 'Optional service' : 'Required service';
  }

  /** Prowlarr and SABnzbd: nothing else depends on them, so they never block readiness. */
  protected isOptionalService(type: IntegrationType): boolean {
    return type === 'PROWLARR' || type === 'SABNZBD';
  }

  protected integrationHealthLead(): string {
    return this.nextRepairSummary() ?? 'Every required service has passed readiness checks.';
  }

  protected repairWarning(): string | null {
    if (this.allRequiredReady()) {
      return null;
    }

    const nextStep = this.nextRepairSummary();
    return nextStep ? `Needs attention: ${nextStep}` : null;
  }

  protected configuredCatalogProviderLabel(): string | null {
    const catalogProvider = this.catalogProvider();
    return catalogProvider ? this.labelFor(catalogProvider) : null;
  }

  protected catalogProviderHelp(type: IntegrationType): string | null {
    if (type === 'SABNZBD') {
      return 'Optional. With SABnzbd and Finished downloads turned on below, Find downloads sends usenet releases to SABnzbd in a category of their own, and Stashboard moves each finished video into your library and links it to its scene. First add a “stashboard” category in SABnzbd (Settings → Categories) with its own folder. Use the address you open SABnzbd at (like http://192.168.1.10:8080) and the API key from its Settings → General.';
    }

    if (this.isOptionalService(type)) {
      return 'Optional. With Prowlarr, scenes Whisparr can’t request (FansDB scenes, for one) get a Find downloads button that searches your Prowlarr indexers and sends the release you pick to Prowlarr’s download client. Use the address you open Prowlarr at (like http://192.168.1.10:9696) and the API key from its Settings → General.';
    }

    const catalogProvider = this.catalogProvider();
    if (this.isBrowseProvider(type) && catalogProvider) {
      return `Optional. Add ${this.labelFor(type)} to browse it next to ${this.labelFor(catalogProvider)} on the Scenes, Performers and Studios pages. Requests keep using ${this.labelFor(catalogProvider)}, and ${this.labelFor(type)} scenes show library status but can't be requested.`;
    }

    if (!this.isCatalogProvider(type) || catalogProvider !== type) {
      return null;
    }

    switch (this.readinessState(type)) {
      case 'NOT_SAVED':
      case 'SAVED':
        return `${this.labelFor(type)} remains this instance's catalog provider while it is not ready. Save & Test it here. Reset catalog setup only if you need to switch providers.`;
      case 'TEST_FAILED':
        return `${this.labelFor(type)} remains this instance's catalog provider even while unhealthy. Repair it here and Save & Test again. Reset catalog setup only if you need to switch providers.`;
      case 'READY':
        return `${this.labelFor(type)} is the catalog provider configured for this Stashboard instance. Reset catalog setup before changing provider type.`;
    }
  }

  protected formFor(type: IntegrationType): IntegrationForm {
    return this.forms[type];
  }

  protected readinessState(type: IntegrationType): ReadinessState {
    return integrationReadinessState(this.integrations()[type]);
  }

  protected readinessSummary(type: IntegrationType): string {
    const integration = this.integrations()[type];
    const label = this.labelFor(type);
    const state = this.readinessState(type);

    if (this.isBrowseProvider(type)) {
      switch (state) {
        case 'NOT_SAVED':
          return `${label} is not added. Enter its URL and API key, then Save & Test to browse it.`;
        case 'SAVED':
          return `${label} is saved but needs a successful Save & Test before it can be browsed.`;
        case 'TEST_FAILED':
          return `${label} failed its last test. Fix the details and Save & Test again.`;
        case 'READY':
          return `${label} is ready to browse.`;
      }
    }

    if (this.isCatalogProvider(type)) {
      switch (state) {
        case 'NOT_SAVED':
          return `${label} is still the chosen catalog provider for this instance, but its saved details are missing. Save & Test to repair it, or reset catalog setup to switch providers.`;
        case 'SAVED':
          return `${label} is still the chosen catalog provider, but it needs a successful test before this instance is ready again.`;
        case 'TEST_FAILED':
          return `${label} is still the chosen catalog provider. Repair the connection details and Save & Test again, or reset catalog setup to switch providers.`;
        case 'READY':
          return `${label} is chosen, locked, and ready for this instance.`;
      }
    }

    if (type === 'SABNZBD') {
      switch (state) {
        case 'NOT_SAVED':
          return `${label} is not added. Enter its URL and API key, then Save & Test.`;
        case 'SAVED':
          return integration && !integration.enabled
            ? `${label} is saved but turned off, so downloads go through Prowlarr as before.`
            : `${label} is saved but needs a successful Save & Test.`;
        case 'TEST_FAILED':
          return `${label} failed its last test. Fix the details and Save & Test again.`;
        case 'READY':
          return `${label} is ready. Turn on Finished downloads below to use it.`;
      }
    }

    if (this.isOptionalService(type)) {
      switch (state) {
        case 'NOT_SAVED':
          return `${label} is not added. Enter its URL and API key, then Save & Test to find downloads with it.`;
        case 'SAVED':
          return integration && !integration.enabled
            ? `${label} is saved but turned off, so Find downloads is hidden.`
            : `${label} is saved but needs a successful Save & Test before you can find downloads with it.`;
        case 'TEST_FAILED':
          return `${label} failed its last test. Fix the details and Save & Test again.`;
        case 'READY':
          return `${label} is ready. Scenes Whisparr can’t request show Find downloads.`;
      }
    }

    switch (state) {
      case 'NOT_SAVED':
        return `Enter ${label} connection details, then Save & Test to restore readiness.`;
      case 'SAVED':
        if (integration && !integration.enabled) {
          return `${label} is saved but disabled. Enable it, then Save & Test to restore readiness.`;
        }

        return `${label} is saved but not ready yet. Save & Test to verify connectivity.`;
      case 'TEST_FAILED':
        return `Repair ${label} connection details if needed, then Save & Test again to restore readiness.`;
      case 'READY':
        return `${label} is connected and ready. Use Save & Test after any changes to keep it healthy.`;
    }
  }

  protected hasStoredApiKey(type: IntegrationType): boolean {
    return this.integrations()[type]?.hasApiKey ?? false;
  }

  protected isSaving(type: IntegrationType): boolean {
    return this.saveState()[type].running;
  }

  protected isSaveAndTesting(type: IntegrationType): boolean {
    return this.saveAndTestState()[type].running;
  }

  protected isResetting(type: IntegrationType): boolean {
    return this.resetState()[type].running;
  }

  protected isBusy(type: IntegrationType): boolean {
    return this.isSaving(type) || this.isSaveAndTesting(type) || this.isResetting(type);
  }

  protected pageMutationRunning(): boolean {
    return this.resettingAll() || this.allServiceTypes.some((type) => this.isBusy(type));
  }

  protected messagesFor(type: IntegrationType): IntegrationRepairPanelMessage[] {
    const messages: IntegrationRepairPanelMessage[] = [];
    const saveAndTestState = this.saveAndTestState()[type];
    const saveState = this.saveState()[type];
    const resetState = this.resetState()[type];

    if (saveAndTestState.success) {
      messages.push({ severity: 'success', text: saveAndTestState.success });
    }
    if (saveAndTestState.error) {
      messages.push({ severity: 'error', text: saveAndTestState.error });
    }
    if (saveState.success) {
      messages.push({ severity: 'success', text: saveState.success });
    }
    if (saveState.error) {
      messages.push({ severity: 'error', text: saveState.error });
    }
    if (resetState.success) {
      messages.push({ severity: 'success', text: resetState.success });
    }
    if (resetState.error) {
      messages.push({ severity: 'error', text: resetState.error });
    }

    return messages;
  }

  protected dangerTitle(type: IntegrationType): string {
    if (this.isBrowseProvider(type)) {
      return `Remove ${this.labelFor(type)}`;
    }
    return this.isCatalogProvider(type)
      ? 'Reset catalog setup'
      : `Reset ${this.labelFor(type)} integration`;
  }

  protected dangerSummary(type: IntegrationType): string {
    if (this.isBrowseProvider(type)) {
      return `Stop browsing ${this.labelFor(type)}. Your chosen catalog provider is not affected.`;
    }
    if (type === 'SABNZBD') {
      return `Stop sending downloads to ${this.labelFor(type)}. Find downloads goes back to Prowlarr’s download client.`;
    }
    if (this.isOptionalService(type)) {
      return `Stop finding downloads with ${this.labelFor(type)}. Nothing else is affected.`;
    }
    return this.isCatalogProvider(type)
      ? 'Clear the locked catalog provider choice for this instance and return to setup if you need a different provider.'
      : 'Clear the saved configuration and readiness history for this integration.';
  }

  protected resetActionLabel(type: IntegrationType): string {
    if (this.isResetting(type)) {
      return 'Resetting...';
    }

    if (this.isBrowseProvider(type)) {
      return `Remove ${this.labelFor(type)}`;
    }
    return this.isCatalogProvider(type)
      ? 'Reset catalog setup'
      : `Reset ${this.labelFor(type)} Integration`;
  }

  protected requestIntegrationReset(type: IntegrationType): void {
    if (this.pageMutationRunning()) {
      return;
    }

    const isCatalogProvider = this.isInstanceCatalogProvider(type);
    this.confirmationService.confirm({
      key: 'app-destructive',
      header: isCatalogProvider
        ? 'Reset Catalog Setup?'
        : `Reset ${this.labelFor(type)} Integration?`,
      message: isCatalogProvider
        ? `Resetting ${this.labelFor(type)} clears this instance's catalog provider choice. Return to setup to choose StashDB or FansDB again.`
        : 'Reset this integration and clear saved configuration?',
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel',
      rejectButtonStyleClass: 'p-button-text',
      acceptLabel: isCatalogProvider ? 'Reset catalog setup' : 'Confirm reset',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.resetIntegration(type);
      },
    });
  }

  protected requestResetAll(): void {
    if (this.pageMutationRunning()) {
      return;
    }

    this.confirmationService.confirm({
      key: 'app-destructive',
      header: 'Reset All Integrations?',
      message:
        'Resetting all integrations clears Stash, Whisparr, and the catalog provider choice for this instance.',
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel',
      rejectButtonStyleClass: 'p-button-text',
      acceptLabel: 'Confirm reset all',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.resetAllIntegrations();
      },
    });
  }

  protected saveIntegration(type: IntegrationType): void {
    if (this.pageMutationRunning()) {
      return;
    }

    const payload = buildIntegrationPayload(type, this.forms[type]);
    patchActionState(this.saveState, type, {
      running: true,
      success: null,
      error: null,
    });
    patchActionState(this.saveAndTestState, type, { success: null, error: null });
    patchActionState(this.resetState, type, { success: null, error: null });

    // A failure after this point is about refreshing the page, not saving.
    let saved = false;
    this.integrationsService
      .updateIntegration(type, payload)
      .pipe(
        tap(() => (saved = true)),
        switchMap((integration) =>
          this.refreshSettingsState().pipe(map((snapshot) => ({ integration, ...snapshot }))),
        ),
        finalize(() => {
          patchActionState(this.saveState, type, { running: false });
        }),
      )
      .subscribe({
        next: ({ integration, setupStatus, integrations }) => {
          this.syncSettingsState(setupStatus, integrations);
          this.runtimeHealthService.requestRefresh();
          const message = this.describeSaveSuccess(type, integration);
          this.notifications.success(message);
          patchActionState(this.saveState, type, {
            success: message,
            error: null,
          });
        },
        error: (error: unknown) => {
          if (saved) {
            const message = `${this.labelFor(type)} settings were saved. Reload the page to see their status.`;
            this.notifications.success(message);
            patchActionState(this.saveState, type, { success: message, error: null });
            return;
          }
          const message = describeMutationError(
            error,
            `Failed to save ${this.labelFor(type)} settings.`,
          );
          this.notifications.error(message);
          patchActionState(this.saveState, type, {
            success: null,
            error: message,
          });
        },
      });
  }

  protected saveAndTestIntegration(type: IntegrationType): void {
    if (this.pageMutationRunning()) {
      return;
    }

    const payload = buildIntegrationPayload(type, this.forms[type]);
    patchActionState(this.saveAndTestState, type, {
      running: true,
      success: null,
      error: null,
    });
    patchActionState(this.saveState, type, { success: null, error: null });
    patchActionState(this.resetState, type, { success: null, error: null });

    // A failure after this point is about the test (or refreshing), not saving.
    let saved = false;
    this.integrationsService
      .updateIntegration(type, payload)
      .pipe(
        tap(() => (saved = true)),
        switchMap(() => this.integrationsService.testIntegration(type, payload)),
        switchMap((integration) =>
          this.refreshSettingsState().pipe(map((snapshot) => ({ integration, ...snapshot }))),
        ),
        finalize(() => {
          patchActionState(this.saveAndTestState, type, { running: false });
        }),
      )
      .subscribe({
        next: ({ integration, setupStatus, integrations }) => {
          this.syncSettingsState(setupStatus, integrations);
          this.runtimeHealthService.requestRefresh();

          if (integration.status === 'CONFIGURED') {
            const message = `${this.labelFor(type)} is ready.`;
            this.notifications.success(message);
            patchActionState(this.saveAndTestState, type, {
              success: message,
              error: null,
            });
            return;
          }

          const message = `${this.labelFor(type)} settings were saved, but the test failed.`;
          this.notifications.error(message);
          patchActionState(this.saveAndTestState, type, {
            success: null,
            error: message,
          });
        },
        error: (error: unknown) => {
          const message = saved
            ? `${this.labelFor(type)} settings were saved, but the test couldn't run: ${describeMutationError(error, 'try again.')}`
            : describeMutationError(error, `Failed to save and test ${this.labelFor(type)}.`);
          this.notifications.error(message);
          patchActionState(this.saveAndTestState, type, {
            success: null,
            error: message,
          });
        },
      });
  }

  protected resetIntegration(type: IntegrationType): void {
    if (this.pageMutationRunning()) {
      return;
    }

    patchActionState(this.resetState, type, {
      running: true,
      success: null,
      error: null,
    });
    const resetsCatalogSetup = this.isInstanceCatalogProvider(type);

    this.integrationsService
      .resetIntegration(type)
      .pipe(
        switchMap(() => this.refreshSettingsState()),
        finalize(() => {
          patchActionState(this.resetState, type, { running: false });
        }),
      )
      .subscribe({
        next: ({ setupStatus, integrations }) => {
          this.syncSettingsState(setupStatus, integrations);
          this.runtimeHealthService.requestRefresh();
          if (resetsCatalogSetup) {
            this.notifications.info('Catalog setup was reset');
            void this.router.navigateByUrl('/setup');
          } else {
            this.notifications.info(`${this.labelFor(type)} integration reset`);
          }
          patchActionState(this.resetState, type, {
            success: resetsCatalogSetup
              ? 'Catalog setup has been reset.'
              : `${this.labelFor(type)} has been reset.`,
            error: null,
          });
        },
        error: (error: unknown) => {
          const message = describeMutationError(error, `Failed to reset ${this.labelFor(type)}.`);
          this.notifications.error(message);
          patchActionState(this.resetState, type, {
            success: null,
            error: message,
          });
        },
      });
  }

  protected resetAllIntegrations(): void {
    if (this.pageMutationRunning()) {
      return;
    }

    this.resettingAll.set(true);

    this.integrationsService
      .resetAllIntegrations()
      .pipe(
        switchMap((integrations) =>
          this.setupService.getStatus().pipe(
            map((setupStatus) => ({
              setupStatus,
              integrations,
            })),
          ),
        ),
        finalize(() => {
          this.resettingAll.set(false);
        }),
      )
      .subscribe({
        next: ({ setupStatus, integrations }) => {
          this.syncSettingsState(setupStatus, integrations);
          this.runtimeHealthService.requestRefresh();
          this.notifications.info('All integrations were reset to not configured');
          void this.router.navigateByUrl('/setup');
        },
        error: (error: unknown) => {
          this.notifications.error(
            describeMutationError(error, 'Failed to reset all integrations.'),
          );
        },
      });
  }

  protected refreshHealth(): void {
    this.refreshingHealth.set(true);
    this.healthError.set(null);

    forkJoin({
      integrations: this.integrationsService.getIntegrations(),
      health: this.healthService.getStatus(),
      setupStatus: this.setupService.getStatus(),
    })
      .pipe(
        finalize(() => {
          this.refreshingHealth.set(false);
        }),
      )
      .subscribe({
        next: ({ integrations, health, setupStatus }) => {
          this.syncSettingsState(setupStatus, integrations);
          this.health.set(health);
        },
        error: () => {
          this.healthError.set('Failed to refresh health data.');
        },
      });
  }

  protected lastHealthyAt(type: IntegrationType): string | null {
    return formatOptionalDateTime(this.integrations()[type]?.lastHealthyAt ?? null);
  }

  protected lastErrorAt(type: IntegrationType): string | null {
    return formatOptionalDateTime(this.integrations()[type]?.lastErrorAt ?? null);
  }

  private loadSettingsData(): void {
    this.loading.set(true);
    this.loadError.set(null);

    forkJoin({
      integrations: this.integrationsService.getIntegrations(),
      health: this.healthService.getStatus(),
      setupStatus: this.setupService.getStatus(),
    })
      .pipe(
        finalize(() => {
          this.loading.set(false);
        }),
      )
      .subscribe({
        next: ({ integrations, health, setupStatus }) => {
          this.syncSettingsState(setupStatus, integrations);
          this.health.set(health);
          this.scrollToMappingIfLinked();
        },
        error: () => {
          this.loadError.set('Failed to load settings data from the API.');
        },
      });
  }

  private refreshSettingsState(): Observable<{
    setupStatus: SetupStatusResponse;
    integrations: IntegrationResponse[];
  }> {
    return forkJoin({
      setupStatus: this.setupService.getStatus(),
      integrations: this.integrationsService.getIntegrations(),
    });
  }

  private syncSettingsState(
    setupStatus: SetupStatusResponse,
    integrations: IntegrationResponse[],
  ): void {
    this.setupStatus.set(setupStatus);
    this.setupStatusStore.sync(setupStatus);
    this.applyIntegrations(integrations);
  }

  private applyIntegrations(integrations: IntegrationResponse[]): void {
    const byType = mapIntegrationsByType(integrations);
    this.integrations.set(byType);

    for (const type of this.allServiceTypes) {
      const integration = byType[type];
      this.forms[type].setValue({
        name: integration?.name ?? '',
        baseUrl: integration?.baseUrl ?? '',
        apiKey: '',
        clearApiKey: false,
        enabled: defaultEnabledValue(type, integration),
      });
    }
  }

  private catalogProvider(): CatalogProviderType | null {
    return this.setupStatus()?.catalogProvider ?? null;
  }

  private catalogProviderReady(): boolean {
    return this.setupStatus()?.required.catalog ?? false;
  }

  private requiredServiceReady(type: Extract<IntegrationType, 'STASH' | 'WHISPARR'>): boolean {
    const setupStatus = this.setupStatus();
    if (!setupStatus) {
      return false;
    }

    return type === 'STASH' ? setupStatus.required.stash : setupStatus.required.whisparr;
  }

  private nextRepairSummary(): string | null {
    const catalogProvider = this.catalogProvider();
    if (!catalogProvider) {
      return 'Catalog provider still needs setup.';
    }

    if (!this.catalogProviderReady()) {
      return this.blockingSummary(catalogProvider, true);
    }

    if (!this.requiredServiceReady('STASH')) {
      return this.blockingSummary('STASH', false);
    }

    if (!this.requiredServiceReady('WHISPARR')) {
      return this.blockingSummary('WHISPARR', false);
    }

    return null;
  }

  private blockingSummary(type: IntegrationType, isCatalogProvider: boolean): string {
    const label = this.labelFor(type);
    switch (this.readinessState(type)) {
      case 'NOT_SAVED':
        return isCatalogProvider
          ? `${label} still needs saved connection details.`
          : `${label} still needs connection details.`;
      case 'SAVED':
        return `${label} still needs Save & Test.`;
      case 'TEST_FAILED':
        return `${label} needs repair.`;
      case 'READY':
        return `${label} is ready.`;
    }
  }

  private catalogChecklistItem(): SettingsChecklistItem {
    const catalogProvider = this.catalogProvider();
    if (!catalogProvider) {
      return {
        key: 'CATALOG',
        title: 'Catalog provider',
        state: 'NOT_SAVED',
        ready: false,
        summary:
          'No catalog provider is locked right now. Return to setup to choose StashDB or FansDB.',
      };
    }

    const state = this.readinessState(catalogProvider);
    return {
      key: 'CATALOG',
      title: 'Catalog provider',
      state,
      ready: this.catalogProviderReady(),
      summary:
        state === 'READY'
          ? `${this.labelFor(catalogProvider)} chosen and ready.`
          : state === 'TEST_FAILED'
            ? `${this.labelFor(catalogProvider)} chosen, locked, and needs repair.`
            : state === 'NOT_SAVED'
              ? `${this.labelFor(catalogProvider)} stays locked, but its details need to be saved again.`
              : `${this.labelFor(catalogProvider)} chosen and locked. Save & Test is still required.`,
    };
  }

  private requiredChecklistItem(
    type: Extract<IntegrationType, 'STASH' | 'WHISPARR'>,
  ): SettingsChecklistItem {
    const state = this.readinessState(type);
    return {
      key: type,
      title: this.labelFor(type),
      state,
      ready: this.requiredServiceReady(type),
      summary: this.requiredChecklistSummary(type, state),
    };
  }

  private requiredChecklistSummary(
    type: Extract<IntegrationType, 'STASH' | 'WHISPARR'>,
    state: ReadinessState,
  ): string {
    const label = this.labelFor(type);
    const integration = this.integrations()[type];

    switch (state) {
      case 'NOT_SAVED':
        return `${label} still needs connection details.`;
      case 'SAVED':
        if (integration && !integration.enabled) {
          return `${label} is saved but disabled. Enable it, then Save & Test.`;
        }

        return `${label} is saved, but it still needs a passing test.`;
      case 'TEST_FAILED':
        return `${label} needs repair.`;
      case 'READY':
        return `${label} is ready.`;
    }
  }

  private describeSaveSuccess(type: IntegrationType, integration: IntegrationResponse): string {
    if (integration.status === 'ERROR') {
      return `${this.labelFor(type)} settings saved. Repair the connection details and run Save & Test again.`;
    }

    if (integrationReadinessState(integration) === 'READY') {
      return `${this.labelFor(type)} settings saved.`;
    }

    if (hasSavedIntegrationConfig(integration)) {
      return `${this.labelFor(type)} settings saved. Run Save & Test to verify readiness.`;
    }

    return `${this.labelFor(type)} settings saved.`;
  }
}

/** Fragment used by links into the Whisparr folder mapping. */
export const WHISPARR_MAPPING_ANCHOR = 'whisparr-folder-mapping';

function failedPathCheck(
  error: { error?: { message?: string } },
  fallback: string,
): WhisparrPathCheck {
  return {
    ok: false,
    stashPath: null,
    whisparrPath: null,
    message: error?.error?.message ?? fallback,
  };
}

interface SettingsChecklistItem {
  key: 'CATALOG' | 'STASH' | 'WHISPARR';
  title: string;
  state: ReadinessState;
  ready: boolean;
  summary: string;
}
