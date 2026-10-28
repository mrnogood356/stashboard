import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationService } from 'primeng/api';
import { DownloadHandoffApiService } from '../../core/api/download-handoff.service';
import { HealthService } from '../../core/api/health.service';
import { HealthStatusResponse } from '../../core/api/health.types';
import { IntegrationsService } from '../../core/api/integrations.service';
import { IntegrationResponse } from '../../core/api/integrations.types';
import { OrganizerApiService } from '../../core/api/organizer.service';
import { RuntimeHealthService } from '../../core/api/runtime-health.service';
import { SetupService } from '../../core/api/setup.service';
import { SetupStatusResponse } from '../../core/api/setup.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SettingsIntegrationsPageComponent } from './settings-integrations-page.component';

function buildHealthStatus(): HealthStatusResponse {
  return {
    status: 'ok',
    database: 'ok',
    service: 'sp-api',
    version: 'test',
  };
}

function buildIntegration(
  overrides: Partial<IntegrationResponse> & Pick<IntegrationResponse, 'type'>,
): IntegrationResponse {
  const status = overrides.status ?? 'CONFIGURED';
  return {
    type: overrides.type,
    enabled: overrides.enabled ?? true,
    status,
    name: 'name' in overrides ? (overrides.name ?? null) : null,
    baseUrl: 'baseUrl' in overrides ? (overrides.baseUrl ?? null) : 'http://service.local',
    hasApiKey: overrides.hasApiKey ?? true,
    lastHealthyAt:
      'lastHealthyAt' in overrides
        ? (overrides.lastHealthyAt ?? null)
        : status === 'CONFIGURED'
          ? '2026-04-01T00:00:00.000Z'
          : null,
    lastErrorAt: 'lastErrorAt' in overrides ? (overrides.lastErrorAt ?? null) : null,
    lastErrorMessage: 'lastErrorMessage' in overrides ? (overrides.lastErrorMessage ?? null) : null,
  };
}

function textContent(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function buildSettingsIntegrations(): IntegrationResponse[] {
  return [
    buildIntegration({ type: 'STASH' }),
    buildIntegration({ type: 'WHISPARR' }),
    buildIntegration({
      type: 'STASHDB',
      enabled: true,
      baseUrl: 'http://stashdb.local/graphql',
    }),
  ];
}

function buildSettingsSetupStatus(): SetupStatusResponse {
  return {
    setupComplete: true,
    required: { stash: true, catalog: true, whisparr: true },
    catalogProvider: 'STASHDB',
  };
}

describe('SettingsIntegrationsPageComponent', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  function buildOrganizerApi(overrides: Record<string, unknown> = {}) {
    return {
      settings: vi
        .fn()
        .mockReturnValue(of({ whisparrPathFrom: '/data', whisparrPathTo: '/mnt/user/media' })),
      update: vi.fn(),
      detectWhisparrPath: vi.fn(),
      checkWhisparrPath: vi.fn(),
      ...overrides,
    };
  }

  async function renderPage(
    integrations: IntegrationResponse[],
    setupStatus: SetupStatusResponse,
    organizerApi: ReturnType<typeof buildOrganizerApi> = buildOrganizerApi(),
  ) {
    const integrationsService = {
      getIntegrations: vi.fn().mockReturnValue(of(integrations)),
      updateIntegration: vi.fn(),
      testIntegration: vi.fn(),
      resetIntegration: vi.fn(),
      resetAllIntegrations: vi.fn(),
    };
    const setupService = {
      getStatus: vi.fn().mockReturnValue(of(setupStatus)),
    };
    const healthService = {
      getStatus: vi.fn().mockReturnValue(of(buildHealthStatus())),
    };
    const runtimeHealthService = {
      requestRefresh: vi.fn(),
    };
    const notifications = {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const confirmationService = {
      confirm: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [SettingsIntegrationsPageComponent],
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        {
          provide: IntegrationsService,
          useValue: integrationsService,
        },
        {
          provide: SetupService,
          useValue: setupService,
        },
        {
          provide: HealthService,
          useValue: healthService,
        },
        {
          provide: RuntimeHealthService,
          useValue: runtimeHealthService,
        },
        {
          provide: ConfirmationService,
          useValue: confirmationService,
        },
        {
          provide: AppNotificationsService,
          useValue: notifications,
        },
        {
          provide: OrganizerApiService,
          useValue: organizerApi,
        },
        {
          provide: DownloadHandoffApiService,
          useValue: {
            settings: vi.fn().mockReturnValue(
              of({
                enabled: false,
                category: 'stashboard',
                destination: null,
                sabPathFrom: null,
                sabPathTo: null,
                importMode: 'move',
                dropIns: false,
                dropInFolder: null,
                sabnzbdReady: false,
                libraryRoots: [],
              }),
            ),
            recent: vi.fn().mockReturnValue(of([])),
            dropIns: vi.fn().mockReturnValue(of([])),
            update: vi.fn(),
            ignore: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(SettingsIntegrationsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return {
      fixture,
      component: fixture.componentInstance as any,
      integrationsService,
      setupService,
      runtimeHealthService,
      notifications,
      confirmationService,
      organizerApi,
    };
  }

  function overview(fixture: { nativeElement: HTMLElement }): HTMLElement {
    const element = fixture.nativeElement.querySelector('.settings-overview') as HTMLElement | null;
    expect(element).toBeTruthy();
    return element as HTMLElement;
  }

  function checklistItemByTitle(
    fixture: { nativeElement: HTMLElement },
    title: string,
  ): HTMLElement {
    const items = Array.from(
      fixture.nativeElement.querySelectorAll('.checklist-item') as NodeListOf<HTMLElement>,
    );
    const item = items.find((candidate) => textContent(candidate.querySelector('h3')) === title);
    expect(item).toBeTruthy();
    return item as HTMLElement;
  }

  function panelByTitle(fixture: { nativeElement: HTMLElement }, title: string): HTMLElement {
    const panels = Array.from(
      fixture.nativeElement.querySelectorAll('.service-panel') as NodeListOf<HTMLElement>,
    );
    const panel = panels.find((candidate) => textContent(candidate.querySelector('h2')) === title);
    expect(panel).toBeTruthy();
    return panel as HTMLElement;
  }

  function integrationResetButton(panel: HTMLElement): HTMLButtonElement {
    const button = panel.querySelector('.danger-card button') as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  function integrationActionButtons(panel: HTMLElement): HTMLButtonElement[] {
    const buttons = Array.from(
      panel.querySelectorAll('.actions button') as NodeListOf<HTMLButtonElement>,
    );
    expect(buttons).toHaveLength(2);
    return buttons;
  }

  function globalResetButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    const button = fixture.nativeElement.querySelector(
      '.global-danger button',
    ) as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it('shows a one-line readiness summary when all required services are ready', async () => {
    const { fixture, component } = await renderPage(
      [
        buildIntegration({ type: 'STASH' }),
        buildIntegration({ type: 'WHISPARR' }),
        buildIntegration({
          type: 'STASHDB',
          enabled: true,
          baseUrl: 'http://stashdb.local/graphql',
        }),
        buildIntegration({
          type: 'FANSDB',
          status: 'NOT_CONFIGURED',
          enabled: false,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
      ],
      {
        setupComplete: true,
        required: { stash: true, catalog: true, whisparr: true },
        catalogProvider: 'STASHDB',
      },
    );

    expect(component.serviceTabs()).toEqual([
      'STASH',
      'WHISPARR',
      'STASHDB',
      'FANSDB',
      'PROWLARR',
      'SABNZBD',
    ]);
    expect(textContent(overview(fixture))).toContain('3 of 3 required services ready');
    // With everything ready the per-service checks are left to the rows below.
    expect(fixture.nativeElement.querySelector('.checklist-item')).toBeNull();
    expect(component.catalogProviderHelp('STASHDB')).toBe(
      'StashDB is the catalog provider configured for this Stashboard instance. Reset catalog setup before changing provider type.',
    );
    expect(component.showEnabledToggle('STASHDB')).toBe(false);

    // The other provider is offered for browsing only and isn't a required service.
    expect(component.sectionLabel('FANSDB')).toBe('Optional browse provider');
    expect(component.catalogProviderHelp('FANSDB')).toContain('Requests keep using StashDB');
    expect(component.readinessSummary('FANSDB')).toBe(
      'FansDB is not added. Enter its URL and API key, then Save & Test to browse it.',
    );
    expect(component.dangerTitle('FANSDB')).toBe('Remove FansDB');
  });

  it('shows a repair summary and readiness checklist state when a required integration is unhealthy', async () => {
    const { fixture } = await renderPage(
      [
        buildIntegration({ type: 'STASH' }),
        buildIntegration({
          type: 'WHISPARR',
          status: 'ERROR',
          baseUrl: 'http://whisparr.local',
          lastHealthyAt: null,
          lastErrorAt: '2026-04-01T01:00:00.000Z',
          lastErrorMessage: 'bad credentials',
        }),
        buildIntegration({
          type: 'STASHDB',
          enabled: true,
          baseUrl: 'http://stashdb.local/graphql',
        }),
      ],
      {
        setupComplete: false,
        required: { stash: true, catalog: true, whisparr: false },
        catalogProvider: 'STASHDB',
      },
    );

    expect(textContent(overview(fixture))).toContain('2 of 3 required services ready');
    expect(textContent(overview(fixture))).toContain('Whisparr needs repair.');
    expect(textContent(overview(fixture))).toContain('Needs attention: Whisparr needs repair.');

    const whisparrChecklist = checklistItemByTitle(fixture, 'Whisparr');
    expect(textContent(whisparrChecklist)).toContain('Test Failed');
    expect(textContent(whisparrChecklist)).toContain('Whisparr needs repair.');

    const panel = panelByTitle(fixture, 'Whisparr');
    expect(textContent(panel)).toContain('Test Failed');
    expect(textContent(panel)).toContain(
      'Repair Whisparr connection details if needed, then Save & Test again to restore readiness.',
    );
    expect(textContent(panel)).toContain('bad credentials');

    // The failed service opens on load; refreshing health leaves the open row alone.
    const head = (title: string) =>
      panelByTitle(fixture, title).querySelector('button.card-head') as HTMLButtonElement;
    expect(head('Whisparr').getAttribute('aria-expanded')).toBe('true');
    head('Stash').click();
    fixture.detectChanges();
    expect(head('Stash').getAttribute('aria-expanded')).toBe('true');

    const refresh = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => textContent(button) === 'Refresh health') as HTMLButtonElement;
    refresh.click();
    fixture.detectChanges();
    expect(head('Stash').getAttribute('aria-expanded')).toBe('true');
    expect(head('Whisparr').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the chosen catalog provider locked and separates repair from reset guidance', async () => {
    const { fixture, component } = await renderPage(
      [
        buildIntegration({ type: 'STASH' }),
        buildIntegration({ type: 'WHISPARR' }),
        buildIntegration({
          type: 'FANSDB',
          status: 'ERROR',
          enabled: true,
          baseUrl: 'http://fansdb.local/graphql',
          lastHealthyAt: null,
          lastErrorMessage: 'forbidden',
        }),
        buildIntegration({
          type: 'STASHDB',
          status: 'NOT_CONFIGURED',
          enabled: false,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
      ],
      {
        setupComplete: false,
        required: { stash: true, catalog: false, whisparr: true },
        catalogProvider: 'FANSDB',
      },
    );

    expect(component.serviceTabs()).toEqual([
      'STASH',
      'WHISPARR',
      'FANSDB',
      'STASHDB',
      'PROWLARR',
      'SABNZBD',
    ]);
    expect(textContent(overview(fixture))).toContain('FansDB needs repair.');
    expect(textContent(overview(fixture))).toContain('FansDB chosen');

    const panel = panelByTitle(fixture, 'FansDB');
    expect(textContent(panel)).toContain('Test Failed');
    expect(textContent(panel)).toContain(
      "FansDB remains this instance's catalog provider even while unhealthy. Repair it here and Save & Test again. Reset catalog setup only if you need to switch providers.",
    );
    expect(textContent(panel)).toContain('Reset catalog setup');
  });

  it('hides catalog tabs when no provider is configured and points the user back to setup', async () => {
    const { fixture, component } = await renderPage(
      [
        buildIntegration({ type: 'STASH' }),
        buildIntegration({ type: 'WHISPARR' }),
        buildIntegration({
          type: 'STASHDB',
          status: 'NOT_CONFIGURED',
          enabled: false,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
        buildIntegration({
          type: 'FANSDB',
          status: 'NOT_CONFIGURED',
          enabled: false,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
      ],
      {
        setupComplete: false,
        required: { stash: true, catalog: false, whisparr: true },
        catalogProvider: null,
      },
    );

    expect(component.serviceTabs()).toEqual(['STASH', 'WHISPARR', 'PROWLARR', 'SABNZBD']);
    expect(component.configuredCatalogProviderLabel()).toBeNull();
    expect(textContent(overview(fixture))).toContain('No catalog provider is locked');
    expect(textContent(checklistItemByTitle(fixture, 'Catalog provider'))).toContain('Not Saved');
  });

  it('uses Save & Test as the primary repair action in Settings', async () => {
    const initialIntegrations = [
      buildIntegration({ type: 'STASH' }),
      buildIntegration({
        type: 'WHISPARR',
        status: 'NOT_CONFIGURED',
        baseUrl: null,
        hasApiKey: false,
        lastHealthyAt: null,
      }),
      buildIntegration({
        type: 'STASHDB',
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ];
    const {
      fixture,
      component,
      integrationsService,
      setupService,
      runtimeHealthService,
      notifications,
    } = await renderPage(initialIntegrations, {
      setupComplete: false,
      required: { stash: true, catalog: true, whisparr: false },
      catalogProvider: 'STASHDB',
    });

    const savedIntegration = buildIntegration({
      type: 'WHISPARR',
      status: 'NOT_CONFIGURED',
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      hasApiKey: true,
      lastHealthyAt: null,
    });
    const testedIntegration = buildIntegration({
      type: 'WHISPARR',
      status: 'CONFIGURED',
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      hasApiKey: true,
      lastHealthyAt: '2026-04-01T03:00:00.000Z',
    });

    integrationsService.updateIntegration.mockReturnValue(of(savedIntegration));
    integrationsService.testIntegration.mockReturnValue(of(testedIntegration));
    integrationsService.getIntegrations.mockReturnValueOnce(
      of([
        buildIntegration({ type: 'STASH' }),
        testedIntegration,
        buildIntegration({
          type: 'STASHDB',
          baseUrl: 'http://stashdb.local/graphql',
        }),
      ]),
    );
    setupService.getStatus.mockReturnValueOnce(
      of({
        setupComplete: true,
        required: { stash: true, catalog: true, whisparr: true },
        catalogProvider: 'STASHDB',
      }),
    );

    component.formFor('WHISPARR').patchValue({
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      apiKey: 'token-123',
      enabled: true,
    });

    const panel = panelByTitle(fixture, 'Whisparr');
    const buttons = Array.from(
      panel.querySelectorAll('.card-body button') as NodeListOf<HTMLButtonElement>,
    );
    expect(buttons.map((button) => textContent(button)).slice(0, 2)).toEqual([
      'Save & Test',
      'Save only',
    ]);

    const saveAndTestButton = buttons.find((button) => textContent(button) === 'Save & Test');
    expect(saveAndTestButton).toBeTruthy();

    saveAndTestButton?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(integrationsService.updateIntegration).toHaveBeenCalledWith('WHISPARR', {
      enabled: true,
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      apiKey: 'token-123',
    });
    expect(integrationsService.testIntegration).toHaveBeenCalledWith('WHISPARR', {
      enabled: true,
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      apiKey: 'token-123',
    });
    expect(runtimeHealthService.requestRefresh).toHaveBeenCalledTimes(1);
    expect(notifications.success).toHaveBeenCalledWith('Whisparr is ready.');
    expect(textContent(panelByTitle(fixture, 'Whisparr'))).toContain('Ready');
    expect(textContent(panelByTitle(fixture, 'Whisparr'))).toContain('Whisparr is ready.');
  });

  it('requests a runtime-health refresh after a successful integration reset', async () => {
    const { component, integrationsService, runtimeHealthService } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    integrationsService.resetIntegration.mockReturnValue(
      of(
        buildIntegration({
          type: 'WHISPARR',
          status: 'NOT_CONFIGURED',
          enabled: true,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
      ),
    );
    integrationsService.getIntegrations.mockReturnValueOnce(
      of([
        buildIntegration({ type: 'STASH' }),
        buildIntegration({
          type: 'WHISPARR',
          status: 'NOT_CONFIGURED',
          enabled: true,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
        buildIntegration({
          type: 'STASHDB',
          baseUrl: 'http://stashdb.local/graphql',
        }),
      ]),
    );
    component.resetIntegration('WHISPARR');

    expect(runtimeHealthService.requestRefresh).toHaveBeenCalledTimes(1);
  });

  it('requests a runtime-health refresh after reset-all completes', async () => {
    const { component, integrationsService, runtimeHealthService } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    integrationsService.resetAllIntegrations.mockReturnValue(
      of([
        buildIntegration({
          type: 'FANSDB',
          status: 'NOT_CONFIGURED',
          enabled: true,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
        buildIntegration({
          type: 'STASH',
          status: 'NOT_CONFIGURED',
          enabled: true,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
        buildIntegration({
          type: 'STASHDB',
          status: 'NOT_CONFIGURED',
          enabled: true,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
        buildIntegration({
          type: 'WHISPARR',
          status: 'NOT_CONFIGURED',
          enabled: true,
          baseUrl: null,
          hasApiKey: false,
          lastHealthyAt: null,
        }),
      ]),
    );

    component.resetAllIntegrations();

    expect(runtimeHealthService.requestRefresh).toHaveBeenCalledTimes(1);
  });

  it('serializes page mutations while save is running on another integration, then re-enables actions', async () => {
    const { fixture, component, integrationsService, confirmationService } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    const saveSubject = new Subject<IntegrationResponse>();
    integrationsService.updateIntegration.mockReturnValue(saveSubject);

    component.formFor('WHISPARR').patchValue({
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      apiKey: 'token-123',
      enabled: true,
    });

    component.saveIntegration('WHISPARR');
    fixture.detectChanges();

    const whisparrPanel = panelByTitle(fixture, 'Whisparr');
    const stashPanel = panelByTitle(fixture, 'Stash');

    expect(textContent(integrationActionButtons(whisparrPanel)[1])).toBe('Saving...');
    expect(integrationActionButtons(stashPanel).map((button) => button.disabled)).toEqual([
      true,
      true,
    ]);
    expect(integrationResetButton(stashPanel).disabled).toBe(true);
    expect(globalResetButton(fixture).disabled).toBe(true);

    component.saveIntegration('STASH');
    component.saveAndTestIntegration('STASH');
    component.resetIntegration('STASH');
    component.requestIntegrationReset('STASH');
    component.requestResetAll();
    component.resetAllIntegrations();

    expect(integrationsService.updateIntegration).toHaveBeenCalledTimes(1);
    expect(integrationsService.testIntegration).not.toHaveBeenCalled();
    expect(integrationsService.resetIntegration).not.toHaveBeenCalled();
    expect(integrationsService.resetAllIntegrations).not.toHaveBeenCalled();
    expect(confirmationService.confirm).not.toHaveBeenCalled();

    saveSubject.next(
      buildIntegration({
        type: 'WHISPARR',
        name: 'Remote Whisparr',
        baseUrl: 'http://whisparr.local',
        hasApiKey: true,
      }),
    );
    saveSubject.complete();

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      integrationActionButtons(panelByTitle(fixture, 'Stash')).map((button) => button.disabled),
    ).toEqual([false, false]);
    expect(integrationResetButton(panelByTitle(fixture, 'Stash')).disabled).toBe(false);
    expect(globalResetButton(fixture).disabled).toBe(false);
  });

  it('serializes page mutations while Save & Test is running on another integration', async () => {
    const { fixture, component, integrationsService, confirmationService } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    const updateSubject = new Subject<IntegrationResponse>();
    integrationsService.updateIntegration.mockReturnValue(updateSubject);
    integrationsService.testIntegration.mockReturnValue(
      of(
        buildIntegration({
          type: 'WHISPARR',
          name: 'Remote Whisparr',
          baseUrl: 'http://whisparr.local',
          hasApiKey: true,
        }),
      ),
    );

    component.formFor('WHISPARR').patchValue({
      name: 'Remote Whisparr',
      baseUrl: 'http://whisparr.local',
      apiKey: 'token-123',
      enabled: true,
    });

    component.saveAndTestIntegration('WHISPARR');
    fixture.detectChanges();

    const whisparrPanel = panelByTitle(fixture, 'Whisparr');
    const stashPanel = panelByTitle(fixture, 'Stash');

    expect(textContent(integrationActionButtons(whisparrPanel)[0])).toBe('Saving & testing...');
    expect(integrationActionButtons(stashPanel).map((button) => button.disabled)).toEqual([
      true,
      true,
    ]);
    expect(integrationResetButton(stashPanel).disabled).toBe(true);
    expect(globalResetButton(fixture).disabled).toBe(true);

    component.requestIntegrationReset('STASH');
    component.requestResetAll();
    expect(confirmationService.confirm).not.toHaveBeenCalled();

    updateSubject.next(
      buildIntegration({
        type: 'WHISPARR',
        status: 'NOT_CONFIGURED',
        name: 'Remote Whisparr',
        baseUrl: 'http://whisparr.local',
        hasApiKey: true,
        lastHealthyAt: null,
      }),
    );
    updateSubject.complete();

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      integrationActionButtons(panelByTitle(fixture, 'Stash')).map((button) => button.disabled),
    ).toEqual([false, false]);
    expect(integrationResetButton(panelByTitle(fixture, 'Stash')).disabled).toBe(false);
    expect(globalResetButton(fixture).disabled).toBe(false);
  });

  it('shows a resetting state and serializes other panels while reset is running', async () => {
    const { fixture, component, integrationsService, confirmationService } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    const resetSubject = new Subject<void>();
    integrationsService.resetIntegration.mockReturnValue(resetSubject);

    component.resetIntegration('WHISPARR');
    fixture.detectChanges();

    const whisparrPanel = panelByTitle(fixture, 'Whisparr');
    const stashPanel = panelByTitle(fixture, 'Stash');

    expect(integrationActionButtons(whisparrPanel).map((button) => button.disabled)).toEqual([
      true,
      true,
    ]);
    expect(textContent(integrationResetButton(whisparrPanel))).toBe('Resetting...');
    expect(integrationResetButton(whisparrPanel).disabled).toBe(true);
    expect(integrationActionButtons(stashPanel).map((button) => button.disabled)).toEqual([
      true,
      true,
    ]);
    expect(integrationResetButton(stashPanel).disabled).toBe(true);
    expect(globalResetButton(fixture).disabled).toBe(true);

    component.saveIntegration('STASH');
    component.saveAndTestIntegration('STASH');
    component.requestIntegrationReset('STASH');
    component.requestResetAll();
    component.resetAllIntegrations();

    expect(integrationsService.updateIntegration).not.toHaveBeenCalled();
    expect(integrationsService.testIntegration).not.toHaveBeenCalled();
    expect(integrationsService.resetAllIntegrations).not.toHaveBeenCalled();
    expect(confirmationService.confirm).not.toHaveBeenCalled();

    resetSubject.next();
    resetSubject.complete();

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      integrationActionButtons(panelByTitle(fixture, 'Stash')).map((button) => button.disabled),
    ).toEqual([false, false]);
    expect(integrationResetButton(panelByTitle(fixture, 'Stash')).disabled).toBe(false);
    expect(globalResetButton(fixture).disabled).toBe(false);
    expect(textContent(integrationResetButton(panelByTitle(fixture, 'Whisparr')))).toBe(
      'Reset Whisparr Integration',
    );
  });

  it('says the settings were saved when only the page refresh or the test fails afterwards', async () => {
    const { component, integrationsService, setupService, notifications } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );
    integrationsService.updateIntegration.mockReturnValue(
      of(buildIntegration({ type: 'WHISPARR' })),
    );
    setupService.getStatus.mockReturnValue(throwError(() => new Error('offline')));

    component.saveIntegration('WHISPARR');

    expect(notifications.error).not.toHaveBeenCalled();
    expect(notifications.success).toHaveBeenCalledWith(
      'Whisparr settings were saved. Reload the page to see their status.',
    );

    integrationsService.testIntegration.mockReturnValue(throwError(() => new Error('timeout')));
    component.saveAndTestIntegration('WHISPARR');

    expect(notifications.error).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Whisparr settings were saved, but the test couldn't run/),
    );
  });

  describe('Whisparr folder mapping', () => {
    function mappingSection(fixture: { nativeElement: HTMLElement }): HTMLElement {
      const panel = panelByTitle(fixture, 'Whisparr');
      const section = panel.querySelector('.mapping-section') as HTMLElement | null;
      expect(section).toBeTruthy();
      return section as HTMLElement;
    }

    function mappingInputs(section: HTMLElement): [HTMLInputElement, HTMLInputElement] {
      const inputs = Array.from(section.querySelectorAll('input')) as HTMLInputElement[];
      expect(inputs).toHaveLength(2);
      return [inputs[0], inputs[1]];
    }

    function mappingButton(section: HTMLElement, text: string): HTMLButtonElement {
      const found = Array.from(section.querySelectorAll('button')).find((entry) =>
        entry.textContent?.includes(text),
      );
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    }

    it('shows the current mapping on the Whisparr card only', async () => {
      const { fixture, organizerApi } = await renderPage(
        buildSettingsIntegrations(),
        buildSettingsSetupStatus(),
      );

      expect(organizerApi.settings).toHaveBeenCalledTimes(1);
      const section = mappingSection(fixture);
      expect(section.id).toBe('whisparr-folder-mapping');
      expect(textContent(section)).toContain('Folder mapping');
      expect(textContent(section)).toContain(
        'Whisparr and Stash may see your files under different paths',
      );
      const [from, to] = mappingInputs(section);
      expect(from.value).toBe('/data');
      expect(to.value).toBe('/mnt/user/media');
      expect(panelByTitle(fixture, 'Stash').querySelector('.mapping-section')).toBeNull();
      // The service's own Save & Test actions are unchanged.
      expect(integrationActionButtons(panelByTitle(fixture, 'Whisparr'))).toHaveLength(2);
    });

    it('saves the mapping, then checks Whisparr can see a file with it', async () => {
      const organizerApi = buildOrganizerApi({
        update: vi
          .fn()
          .mockReturnValue(of({ whisparrPathFrom: '/stash', whisparrPathTo: '/media' })),
        checkWhisparrPath: vi.fn().mockReturnValue(
          of({
            ok: true,
            stashPath: '/stash/a.mp4',
            whisparrPath: '/media/a.mp4',
            message: 'Whisparr can see your files.',
          }),
        ),
      });
      const { fixture } = await renderPage(
        buildSettingsIntegrations(),
        buildSettingsSetupStatus(),
        organizerApi,
      );
      const section = mappingSection(fixture);
      const [from, to] = mappingInputs(section);
      from.value = ' /stash ';
      from.dispatchEvent(new Event('input'));
      to.value = '/media';
      to.dispatchEvent(new Event('input'));

      mappingButton(section, 'Save and check').click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(organizerApi.update).toHaveBeenCalledWith({
        whisparrPathFrom: '/stash',
        whisparrPathTo: '/media',
      });
      expect(organizerApi.checkWhisparrPath).toHaveBeenCalledTimes(1);
      expect(textContent(section)).toContain('Whisparr can see your files.');
      expect(textContent(section)).toContain('/media/a.mp4');
    });

    it('shows why the check failed when Whisparr cannot be reached', async () => {
      const organizerApi = buildOrganizerApi({
        update: vi.fn().mockReturnValue(of({ whisparrPathFrom: '/data', whisparrPathTo: '' })),
        checkWhisparrPath: vi
          .fn()
          .mockReturnValue(throwError(() => ({ error: { message: 'Whisparr is offline.' } }))),
      });
      const { fixture } = await renderPage(
        buildSettingsIntegrations(),
        buildSettingsSetupStatus(),
        organizerApi,
      );
      const section = mappingSection(fixture);

      mappingButton(section, 'Save and check').click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(textContent(section)).toContain('Whisparr is offline.');
      expect(mappingButton(section, 'Save and check').disabled).toBe(false);
    });

    it('fills both fields when Find it for me finds the folder', async () => {
      const organizerApi = buildOrganizerApi({
        settings: vi.fn().mockReturnValue(of({ whisparrPathFrom: '', whisparrPathTo: '' })),
        detectWhisparrPath: vi.fn().mockReturnValue(
          of({
            found: true,
            from: '/data',
            to: '/mnt/user/media',
            example: '/mnt/user/media/scene.mp4',
            message: 'Found it. Saved.',
          }),
        ),
      });
      const { fixture } = await renderPage(
        buildSettingsIntegrations(),
        buildSettingsSetupStatus(),
        organizerApi,
      );
      const section = mappingSection(fixture);
      expect(mappingInputs(section).map((input) => input.value)).toEqual(['', '']);

      mappingButton(section, 'Find it for me').click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(organizerApi.detectWhisparrPath).toHaveBeenCalledTimes(1);
      expect(mappingInputs(section).map((input) => input.value)).toEqual([
        '/data',
        '/mnt/user/media',
      ]);
      expect(textContent(section)).toContain('Found it. Saved.');
      expect(textContent(section)).toContain('/mnt/user/media/scene.mp4');
    });

    it('leaves the fields alone when Find it for me comes up empty', async () => {
      const organizerApi = buildOrganizerApi({
        detectWhisparrPath: vi.fn().mockReturnValue(
          of({
            found: false,
            from: '',
            to: '',
            example: null,
            message: 'Couldn’t find a shared file.',
          }),
        ),
      });
      const { fixture } = await renderPage(
        buildSettingsIntegrations(),
        buildSettingsSetupStatus(),
        organizerApi,
      );
      const section = mappingSection(fixture);

      mappingButton(section, 'Find it for me').click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(mappingInputs(section).map((input) => input.value)).toEqual([
        '/data',
        '/mnt/user/media',
      ]);
      expect(textContent(section)).toContain('Couldn’t find a shared file.');
    });
  });

  it('offers Prowlarr as an optional service that never counts against readiness', async () => {
    const { fixture, component, integrationsService } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    expect(textContent(overview(fixture))).toContain('3 of 3 required services ready');
    expect(component.sectionLabel('PROWLARR')).toBe('Optional service');
    expect(component.catalogProviderHelp('PROWLARR')).toContain('Find downloads');
    expect(component.readinessSummary('PROWLARR')).toBe(
      'Prowlarr is not added. Enter its URL and API key, then Save & Test to find downloads with it.',
    );
    expect(component.showEnabledToggle('PROWLARR')).toBe(true);

    const panel = panelByTitle(fixture, 'Prowlarr');
    expect(textContent(panel)).toContain('Optional service');

    integrationsService.updateIntegration.mockReturnValue(
      of(buildIntegration({ type: 'PROWLARR', status: 'NOT_CONFIGURED', lastHealthyAt: null })),
    );
    integrationsService.testIntegration.mockReturnValue(
      of(buildIntegration({ type: 'PROWLARR', baseUrl: 'http://prowlarr.local:9696' })),
    );
    component.formFor('PROWLARR').patchValue({
      baseUrl: 'http://prowlarr.local:9696',
      apiKey: 'p-key',
    });
    component.saveAndTestIntegration('PROWLARR');
    await fixture.whenStable();

    expect(integrationsService.updateIntegration).toHaveBeenCalledWith('PROWLARR', {
      enabled: true,
      name: undefined,
      baseUrl: 'http://prowlarr.local:9696',
      apiKey: 'p-key',
    });
    expect(integrationsService.testIntegration).toHaveBeenCalledWith(
      'PROWLARR',
      expect.objectContaining({ baseUrl: 'http://prowlarr.local:9696' }),
    );
  });

  it('shows SABnzbd as an optional service with Finished downloads under it', async () => {
    const { fixture, component } = await renderPage(
      buildSettingsIntegrations(),
      buildSettingsSetupStatus(),
    );

    expect(textContent(overview(fixture))).toContain('3 of 3 required services ready');
    expect(component.sectionLabel('SABNZBD')).toBe('Optional service');
    expect(component.catalogProviderHelp('SABNZBD')).toContain('“stashboard” category');
    expect(component.readinessSummary('SABNZBD')).toBe(
      'SABnzbd is not added. Enter its URL and API key, then Save & Test.',
    );

    const panel = panelByTitle(fixture, 'SABnzbd');
    expect(textContent(panel)).toContain('Optional service');
    expect(panel?.querySelector('app-finished-downloads')).not.toBeNull();
    expect(textContent(panel)).toContain('Save & Test SABnzbd above first.');
  });
});
