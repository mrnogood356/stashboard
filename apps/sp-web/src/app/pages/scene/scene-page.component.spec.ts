import { HiddenContentService } from '../../core/api/hidden-content.service';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { ReleasesApiService } from '../../core/api/releases.service';
import { DiagnosticsApiService } from '../../core/api/diagnostics.service';
import { SceneTimeline, TimelineApiService } from '../../core/api/timeline.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneDetails } from '../../core/api/discover.types';
import { ScenePageComponent } from './scene-page.component';

function buildScene(overrides: Partial<SceneDetails> = {}): SceneDetails {
  return {
    id: 'scene-1',
    title: 'Scene Title',
    description: 'Scene description',
    imageUrl: 'http://cdn.local/image.jpg',
    images: [],
    studioId: 'studio-1',
    studioIsFavorite: false,
    studio: 'Studio',
    studioImageUrl: 'http://cdn.local/studio.jpg',
    studioUrl: 'http://studio.local',
    releaseDate: '2026-03-01',
    duration: 600,
    tags: [],
    performers: [],
    sourceUrls: [],
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    stash: null,
    whisparr: null,
    ...overrides,
  };
}

describe('ScenePageComponent', () => {
  async function renderScene(scene: SceneDetails, prowlarrConfigured = false) {
    const discoverService = {
      getSceneDetails: vi.fn().mockReturnValue(of(scene)),
    };
    const releasesApi = {
      prowlarrStatus: vi.fn().mockReturnValue(of({ prowlarr: { configured: prowlarrConfigured } })),
      searchProwlarr: vi.fn().mockReturnValue(of({ releases: [] })),
      ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
      search: vi.fn().mockReturnValue(of({ movieId: 1, releases: [] })),
    };
    const diagnosticsApi = {
      catalogScene: vi.fn().mockReturnValue(of(null)),
      localScene: vi.fn(),
    };
    const timelineApi = {
      scene: vi.fn().mockReturnValue(
        of({
          stashId: scene.id,
          route: 'whisparr',
          now: 'Download failed',
          unknown: [],
          checkedAt: '2026-10-21T12:00:00.000Z',
          steps: [
            {
              step: 'downloading',
              label: 'Downloading',
              at: null,
              status: 'failed',
              detail: 'Whisparr says: Unpacking failed',
              progress: null,
              action: { kind: 'pick-release', label: 'Pick another release' },
            },
          ],
        } satisfies SceneTimeline),
      ),
    };
    const activatedRoute = {
      paramMap: of(convertToParamMap({ stashId: scene.id })),
      queryParamMap: of(convertToParamMap({})),
      snapshot: {
        paramMap: convertToParamMap({ stashId: scene.id }),
      },
    };

    await TestBed.configureTestingModule({
      imports: [ScenePageComponent],
      providers: [
        provideRouter([]),
        {
          provide: HiddenContentService,
          useValue: {
            ensureLoaded: vi.fn(),
            isHidden: vi.fn(() => false),
            hide: vi.fn(),
            unhide: vi.fn(),
          },
        },
        {
          provide: DiscoverService,
          useValue: discoverService,
        },
        { provide: ReleasesApiService, useValue: releasesApi },
        { provide: DiagnosticsApiService, useValue: diagnosticsApi },
        { provide: TimelineApiService, useValue: timelineApi },
        {
          provide: AppNotificationsService,
          useValue: {
            success: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: activatedRoute,
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ScenePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return { fixture, discoverService, releasesApi, diagnosticsApi, timelineApi };
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows failed guidance, keeps the Whisparr link, and hides the request button for failed scenes', async () => {
    const scene = buildScene({
      status: { state: 'FAILED' },
      whisparr: {
        exists: true,
        viewUrl: 'http://whisparr.local/movie/scene-1',
      },
    });

    const { fixture, discoverService } = await renderScene(scene);
    const text = fixture.nativeElement.textContent;

    expect(discoverService.getSceneDetails).toHaveBeenCalledWith('scene-1');
    expect(text).toContain('Resolve or retry this download in Whisparr.');
    expect(text).not.toContain('Retry in Whisparr');
    expect(fixture.nativeElement.querySelector('.request-button')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('a[href="http://whisparr.local/movie/scene-1"]')
        ?.textContent,
    ).toContain('View in Whisparr');
  });

  it('has a collapsed “Why is it like this?” panel for the catalog scene', async () => {
    const { fixture, diagnosticsApi } = await renderScene(buildScene());
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLButtonElement>('app-scene-evidence .evidence-toggle');

    expect(toggle?.textContent).toContain('Why is it like this?');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(diagnosticsApi.catalogScene).not.toHaveBeenCalled();

    toggle!.click();
    expect(diagnosticsApi.catalogScene).toHaveBeenCalledWith('scene-1');
  });

  it('tells a requested scene’s timeline, linked to the raw facts', async () => {
    const scene = buildScene({
      status: { state: 'FAILED' },
      whisparr: { exists: true, viewUrl: 'http://whisparr.local/movie/scene-1' },
    });
    const { fixture, timelineApi, diagnosticsApi } = await renderScene(scene);
    const root = fixture.nativeElement as HTMLElement;

    expect(timelineApi.scene).toHaveBeenCalledWith('scene-1');
    expect(root.querySelector('app-scene-timeline')?.textContent).toContain(
      'Whisparr says: Unpacking failed',
    );

    // "Details" opens "Why is it like this?".
    root.querySelector<HTMLButtonElement>('app-scene-timeline .timeline-link')!.click();
    fixture.detectChanges();
    expect(diagnosticsApi.catalogScene).toHaveBeenCalledWith('scene-1');
    expect(
      root.querySelector('app-scene-evidence .evidence-toggle')?.getAttribute('aria-expanded'),
    ).toBe('true');

    // "Pick another release" opens the release picker.
    root.querySelector<HTMLButtonElement>('[data-testid="timeline-action-pick-release"]')!.click();
    fixture.detectChanges();
    expect(root.querySelector('app-release-picker [role="dialog"]')).not.toBeNull();
  });

  it('has no timeline for a scene that was never requested', async () => {
    const { fixture, timelineApi } = await renderScene(buildScene());

    expect(fixture.nativeElement.querySelector('app-scene-timeline')).toBeNull();
    expect(timelineApi.scene).not.toHaveBeenCalled();
  });

  it('keeps the normal request CTA for NOT_REQUESTED scenes', async () => {
    const { fixture } = await renderScene(buildScene());

    expect(fixture.nativeElement.textContent).toContain('Request in Whisparr');
  });

  it('opens the studio on the catalog from its name and its logo', async () => {
    const { fixture } = await renderScene(buildScene());
    const root = fixture.nativeElement as HTMLElement;

    const name = root.querySelector<HTMLAnchorElement>('[data-testid="scene-studio-link"]');
    expect(name?.textContent?.trim()).toBe('Studio');
    // The scene's catalog goes along, so a FansDB scene opens its FansDB studio.
    expect(name?.getAttribute('href')).toBe('/studio/studio-1?provider=STASHDB');
    expect(root.querySelector('a.studio-logo-overlay')?.getAttribute('href')).toBe(
      '/studio/studio-1?provider=STASHDB',
    );
    // The scene on the studio's own site is still a tap away.
    expect(root.querySelector('[data-testid="scene-studio-site"]')?.getAttribute('href')).toBe(
      'http://studio.local',
    );
  });

  it('offers Play in the built-in player when the scene is in Stash', async () => {
    const scene = buildScene({
      status: { state: 'AVAILABLE' },
      stash: {
        exists: true,
        hasMultipleCopies: false,
        copies: [
          {
            id: '77',
            viewUrl: 'http://stash.local/scenes/77',
            width: 1920,
            height: 1080,
            label: '1080p',
          },
        ],
      },
    });

    const { fixture } = await renderScene(scene);
    const play = fixture.nativeElement.querySelector(
      '.scene-play-button',
    ) as HTMLAnchorElement | null;

    expect(play?.textContent).toContain('Play');
    expect(play?.getAttribute('href')).toContain('/watch/77');
    expect(fixture.nativeElement.querySelector('.request-button')).toBeNull();
  });

  it('does not offer Play for scenes that are not in Stash', async () => {
    const { fixture } = await renderScene(buildScene());
    expect(fixture.nativeElement.querySelector('.scene-play-button')).toBeNull();
  });

  it('offers Find downloads for a FansDB scene when Prowlarr is set up', async () => {
    const scene = buildScene({ source: 'FANSDB', requestable: false });
    const { fixture, releasesApi } = await renderScene(scene, true);
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.request-button')).toBeNull();
    expect(root.querySelector('.prowlarr-hint')).toBeNull();
    const button = root.querySelector('.find-downloads-button') as HTMLButtonElement;
    expect(button.textContent).toContain('Find downloads');

    button.click();
    fixture.detectChanges();

    expect(releasesApi.searchProwlarr).toHaveBeenCalledWith('scene-1', 'FANSDB', '');
    expect(root.textContent).toContain('Find downloads');
  });

  it('points to Settings when Prowlarr isn’t set up', async () => {
    const scene = buildScene({ source: 'FANSDB', requestable: false });
    const { fixture } = await renderScene(scene, false);
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.find-downloads-button')).toBeNull();
    const hint = root.querySelector('.prowlarr-hint');
    expect(hint?.textContent).toContain('Whisparr can’t request this scene.');
    expect(hint?.querySelector('a')?.getAttribute('href')).toBe('/settings/integrations');
  });

  it('leaves Find downloads off for scenes Whisparr can request or that are in the library', async () => {
    const requestable = await renderScene(buildScene(), true);
    expect(requestable.fixture.nativeElement.querySelector('.find-downloads-button')).toBeNull();
    expect(requestable.fixture.nativeElement.querySelector('.prowlarr-hint')).toBeNull();
    TestBed.resetTestingModule();

    const inLibrary = await renderScene(
      buildScene({ source: 'FANSDB', requestable: false, status: { state: 'AVAILABLE' } }),
      true,
    );
    expect(inLibrary.fixture.nativeElement.querySelector('.find-downloads-button')).toBeNull();
  });

  it('shows the scene opened last, and doesn’t reload for a query change alone', async () => {
    const answers: Record<string, Subject<SceneDetails>> = {
      'scene-1': new Subject(),
      'scene-2': new Subject(),
    };
    const discoverService = {
      getSceneDetails: vi.fn((id: string) => answers[id]),
    };
    const params = new BehaviorSubject(convertToParamMap({ stashId: 'scene-1' }));
    const query = new BehaviorSubject(convertToParamMap({}));
    await TestBed.configureTestingModule({
      imports: [ScenePageComponent],
      providers: [
        provideRouter([]),
        {
          provide: HiddenContentService,
          useValue: {
            ensureLoaded: vi.fn(),
            isHidden: vi.fn(() => false),
            hide: vi.fn(),
            unhide: vi.fn(),
          },
        },
        { provide: DiscoverService, useValue: discoverService },
        {
          provide: AppNotificationsService,
          useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: params,
            queryParamMap: query,
            snapshot: { paramMap: convertToParamMap({ stashId: 'scene-1' }) },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScenePageComponent);
    fixture.detectChanges();

    params.next(convertToParamMap({ stashId: 'scene-2' }));
    answers['scene-2'].next(buildScene({ id: 'scene-2', title: 'Second Scene' }));
    answers['scene-2'].complete();
    answers['scene-1'].next(buildScene({ id: 'scene-1', title: 'First Scene' }));
    answers['scene-1'].complete();
    query.next(convertToParamMap({ returnTo: '/home' }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Second Scene');
    expect(text).not.toContain('First Scene');
    expect(discoverService.getSceneDetails).toHaveBeenCalledTimes(2);
  });
});
