import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleasesApiService } from '../../core/api/releases.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { ReleasePickerComponent } from './release-picker.component';

const release = (guid: string, overrides: Record<string, unknown> = {}) => ({
  guid,
  indexerId: 1,
  indexer: 'Tracker',
  title: `Release ${guid}`,
  size: 2 * 1024 ** 3,
  quality: 'WEBDL-1080p',
  resolution: 1080,
  protocol: 'torrent',
  seeders: 10,
  leechers: 0,
  ageHours: 30,
  customFormatScore: 0,
  rejected: false,
  rejections: [],
  languages: [],
  infoUrl: null,
  downloadAllowed: true,
  ...overrides,
});

const noProwlarr = () => of({ prowlarr: { configured: false } });

describe('ReleasePickerComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers Prowlarr when Whisparr finds nothing, and downloads through it', async () => {
    const api = {
      search: vi.fn().mockReturnValue(of({ movieId: 1, releases: [] })),
      grab: vi.fn(),
      prowlarrStatus: vi.fn().mockReturnValue(of({ prowlarr: { configured: true } })),
      searchProwlarr: vi
        .fn()
        .mockReturnValue(of({ releases: [release('p', { indexer: 'NZBgeek' })], queries: [] })),
      grabProwlarr: vi.fn().mockReturnValue(of({ accepted: true, sentTo: 'sabnzbd' })),
      ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
    };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        provideRouter([]),
        { provide: ReleasesApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Nothing found');
    const fallback = root.querySelector(
      '[data-testid="release-search-prowlarr"]',
    ) as HTMLButtonElement;
    fallback.click();
    fixture.detectChanges();

    expect(api.searchProwlarr).toHaveBeenCalledWith('abc', 'STASHDB', '');
    expect(root.textContent).toContain('Find downloads');
    expect(root.textContent).toContain('Release p');
    (root.querySelector('.btn.download') as HTMLButtonElement).click();
    expect(api.grabProwlarr).toHaveBeenCalledWith(
      'abc',
      'STASHDB',
      expect.objectContaining({ guid: 'p' }),
    );
  });

  it('doesn’t offer Prowlarr when it isn’t set up', async () => {
    const api = {
      search: vi.fn().mockReturnValue(of({ movieId: 1, releases: [] })),
      grab: vi.fn(),
      prowlarrStatus: noProwlarr,
      ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
    };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        provideRouter([]),
        { provide: ReleasesApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="release-search-prowlarr"]',
      ),
    ).toBeNull();
  });

  it('lists releases, hides skipped ones, and downloads the chosen one', async () => {
    const api = {
      search: vi.fn().mockReturnValue(
        of({
          movieId: 1,
          releases: [release('a'), release('b', { rejected: true, rejections: ['Not wanted'] })],
        }),
      ),
      grab: vi.fn().mockReturnValue(of({ accepted: true })),
    };
    const notifications = { success: vi.fn(), error: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        {
          provide: ReleasesApiService,
          useValue: {
            ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
            prowlarrStatus: noProwlarr,
            ...api,
          },
        },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    const grabbed = vi.fn();
    fixture.componentInstance.grabbed.subscribe(grabbed);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(api.search).toHaveBeenCalledWith('abc');
    expect(root.textContent).toContain('Release a');
    expect(root.textContent).not.toContain('Release b');
    expect(root.textContent).toContain('Show 1 Whisparr would skip');

    (root.querySelector('.release') as HTMLButtonElement).click();
    fixture.detectChanges();
    const download = root.querySelector('.foot button') as HTMLButtonElement;
    expect(download.textContent).toContain('Download · 2.0 GB');
    download.click();
    expect(api.grab).toHaveBeenCalledWith(
      'abc',
      expect.objectContaining({ guid: 'a', indexerId: 1 }),
    );
    expect(grabbed).toHaveBeenCalled();
  });

  it('says why a search came back empty when Whisparr knows', async () => {
    const api = {
      search: vi.fn().mockReturnValue(
        of({
          movieId: 1,
          releases: [],
          notice: 'Whisparr paused 1 of 2 indexers after errors, until about 3:40 PM: NZBgeek.',
        }),
      ),
      grab: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        {
          provide: ReleasesApiService,
          useValue: {
            ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
            prowlarrStatus: noProwlarr,
            ...api,
          },
        },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('Nothing found');
    expect(text).toContain('Whisparr paused 1 of 2 indexers');
  });

  it('hides weak matches until asked and filters by name with a count', async () => {
    const api = {
      search: vi.fn().mockReturnValue(
        of({
          movieId: 1,
          releases: [
            release('good', {
              title: 'BrazzersExxtra.24.03.15.Jane.Doe.XXX.1080p',
              match: { strength: 'strong', matched: ['studio', 'date', 'performer'] },
            }),
            release('also', {
              title: 'Jane_Doe.Pool.Day.720p',
              match: { strength: 'partial', matched: ['performer'] },
            }),
            release('wrong', {
              title: 'Other.Studio.23.01.01.XXX.2160p',
              match: { strength: 'weak', matched: [] },
            }),
          ],
        }),
      ),
      grab: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        {
          provide: ReleasesApiService,
          useValue: {
            ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
            prowlarrStatus: noProwlarr,
            ...api,
          },
        },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const titles = () =>
      Array.from(root.querySelectorAll('.release-title')).map((el) => el.textContent?.trim());

    expect(titles()).toEqual([
      'BrazzersExxtra.24.03.15.Jane.Doe.XXX.1080p',
      'Jane_Doe.Pool.Day.720p',
    ]);
    expect(root.textContent).toContain('Good match');
    expect(root.textContent).toContain('Partial match');
    const toggle = root.querySelector('[data-testid="toggle-weak"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Show 1 weak match');

    toggle.click();
    fixture.detectChanges();
    expect(titles()).toContain('Other.Studio.23.01.01.XXX.2160p');
    expect(root.textContent).toContain('Nothing in the name matches this scene');

    const input = root.querySelector('.filter input') as HTMLInputElement;
    input.value = 'jane doe';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(titles()).toEqual([
      'BrazzersExxtra.24.03.15.Jane.Doe.XXX.1080p',
      'Jane_Doe.Pool.Day.720p',
    ]);
    expect(root.querySelector('.filter-count')?.textContent?.trim()).toBe('2 of 3');

    input.value = 'nothing here';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(titles()).toEqual([]);
    expect(root.textContent).toContain('No release names match “nothing here”');
  });

  it('says when every release looks like another scene', async () => {
    const api = {
      search: vi.fn().mockReturnValue(
        of({
          movieId: 1,
          releases: [release('wrong', { match: { strength: 'weak', matched: ['studio'] } })],
        }),
      ),
      grab: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        {
          provide: ReleasesApiService,
          useValue: {
            ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
            prowlarrStatus: noProwlarr,
            ...api,
          },
        },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Nothing found looks like this scene');
    (
      Array.from(root.querySelectorAll('.state .btn')).find((el) =>
        el.textContent?.includes('Show them anyway'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Release wrong');
    expect(root.textContent).toContain('Only matches studio; probably another scene');
  });

  describe('through Prowlarr', () => {
    async function renderProwlarr(api: Record<string, ReturnType<typeof vi.fn>>) {
      const notifications = { success: vi.fn(), error: vi.fn() };
      await TestBed.configureTestingModule({
        imports: [ReleasePickerComponent],
        providers: [
          provideRouter([]),
          {
            provide: ReleasesApiService,
            useValue: {
              ownedCopies: vi.fn().mockReturnValue(of({ copies: [] })),
              prowlarrStatus: noProwlarr,
              ...api,
            },
          },
          { provide: AppNotificationsService, useValue: notifications },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(ReleasePickerComponent);
      const grabbed = vi.fn();
      fixture.componentInstance.grabbed.subscribe(grabbed);
      fixture.componentRef.setInput('source', 'prowlarr');
      fixture.componentRef.setInput('provider', 'FANSDB');
      fixture.componentRef.setInput('stashId', 'fans-1');
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();
      return { fixture, root: fixture.nativeElement as HTMLElement, notifications, grabbed };
    }

    const prowlarrRelease = (guid: string, overrides: Record<string, unknown> = {}) =>
      release(guid, {
        quality: null,
        resolution: null,
        customFormatScore: null,
        indexerId: 7,
        ...overrides,
      });

    it('searches Prowlarr for the scene’s catalog and gives each release a Download button', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi.fn().mockReturnValue(
          of({
            releases: [
              prowlarrRelease('good', {
                title: 'Jane.Doe.24.03.15.Beach.Day',
                match: { strength: 'strong', matched: ['studio', 'date'] },
              }),
              prowlarrRelease('weak', {
                title: 'Someone.Else.Clip',
                match: { strength: 'weak', matched: [] },
              }),
            ],
          }),
        ),
        grabProwlarr: vi.fn().mockReturnValue(of({ accepted: true })),
      };
      const { fixture, root, notifications, grabbed } = await renderProwlarr(api);

      expect(api.searchProwlarr).toHaveBeenCalledWith('fans-1', 'FANSDB', '');
      expect(api.search).not.toHaveBeenCalled();
      expect(root.querySelector('h2')?.textContent).toContain('Find downloads');
      expect(root.textContent).toContain('Good match');
      expect(root.textContent).not.toContain('Someone.Else.Clip');
      expect(root.querySelector('.foot')).toBeNull();

      const buttons = Array.from(
        root.querySelectorAll('.release .download'),
      ) as HTMLButtonElement[];
      expect(buttons).toHaveLength(1);
      expect(buttons[0].getAttribute('aria-label')).toBe('Download Jane.Doe.24.03.15.Beach.Day');
      buttons[0].click();
      fixture.detectChanges();

      expect(api.grabProwlarr).toHaveBeenCalledWith(
        'fans-1',
        'FANSDB',
        expect.objectContaining({ guid: 'good', indexerId: 7, indexer: 'Tracker' }),
      );
      expect(notifications.success).toHaveBeenCalledWith(
        'Downloading',
        'Prowlarr sent it to its download client.',
      );
      expect(grabbed).toHaveBeenCalled();
    });

    it('says so when Finished downloads sent it to SABnzbd', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi.fn().mockReturnValue(of({ releases: [prowlarrRelease('a')] })),
        grabProwlarr: vi.fn().mockReturnValue(of({ accepted: true, sentTo: 'sabnzbd' })),
      };
      const { fixture, root, notifications } = await renderProwlarr(api);

      (root.querySelector('.release .download') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(notifications.success).toHaveBeenCalledWith(
        'Downloading',
        'SABnzbd is downloading it. Stashboard moves it into your library when it’s done.',
      );
    });

    it('says why a download didn’t go through and keeps the list open', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi.fn().mockReturnValue(of({ releases: [prowlarrRelease('a')] })),
        grabProwlarr: vi
          .fn()
          .mockReturnValue(
            throwError(() => ({ error: { message: 'Prowlarr has no download client.' } })),
          ),
      };
      const { fixture, root, notifications, grabbed } = await renderProwlarr(api);

      (root.querySelector('.release .download') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(notifications.error).toHaveBeenCalledWith(
        'Couldn’t download that one',
        'Prowlarr has no download client.',
      );
      expect(grabbed).not.toHaveBeenCalled();
      expect(root.querySelector('.release .download')).not.toBeNull();
    });

    it('searches Prowlarr for your own words and shows everything it finds', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi
          .fn()
          .mockReturnValueOnce(of({ releases: [], queries: ['Jane Doe 24.03.15'] }))
          .mockReturnValue(
            of({
              releases: [
                prowlarrRelease('mine', {
                  title: 'OnlyFans.Jane.Doe.Clip',
                  match: { strength: 'weak', matched: [] },
                }),
              ],
              queries: ['onlyfans jane doe'],
            }),
          ),
        grabProwlarr: vi.fn(),
      };
      const { fixture, root } = await renderProwlarr(api);
      expect(root.textContent).toContain('Searched for Jane Doe 24.03.15.');

      const input = root.querySelector('.own-search input') as HTMLInputElement;
      input.value = ' onlyfans jane doe ';
      input.form!.dispatchEvent(new Event('submit'));
      fixture.detectChanges();

      expect(api.searchProwlarr).toHaveBeenLastCalledWith('fans-1', 'FANSDB', 'onlyfans jane doe');
      // A typed search shows weak matches too: the scene's details missed them.
      expect(root.textContent).toContain('OnlyFans.Jane.Doe.Clip');
      expect(root.textContent).toContain('Use the scene’s details again');
    });

    it('names Prowlarr when the search fails without a reason', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi.fn().mockReturnValue(throwError(() => ({}))),
        grabProwlarr: vi.fn(),
      };
      const { root } = await renderProwlarr(api);

      expect(root.textContent).toContain('Prowlarr didn’t answer.');
    });

    it('warns about a copy you already have before listing downloads', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi.fn().mockReturnValue(of({ releases: [prowlarrRelease('a')] })),
        grabProwlarr: vi.fn(),
        ownedCopies: vi.fn().mockReturnValue(
          of({
            copies: [
              {
                reason: 'LINKED',
                stashSceneId: '9',
                title: 'Beach Day',
                studio: null,
                date: null,
                path: '/library/beach.mp4',
                imageUrl: null,
                whisparrUrl: null,
              },
            ],
          }),
        ),
      };
      const { fixture, root } = await renderProwlarr(api);

      expect(api.ownedCopies).toHaveBeenCalledWith('fans-1', 'FANSDB');
      expect(root.textContent).toContain('You may already have this');
      expect(root.textContent).toContain('Linked to this scene in Stash');
      expect(root.querySelector('.release .download')).toBeNull();

      (root.querySelector('button.proceed') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(root.textContent).not.toContain('You may already have this');
      expect(root.querySelector('.release .download')).not.toBeNull();
    });

    it('lists downloads as usual when the check fails', async () => {
      const api = {
        search: vi.fn(),
        searchProwlarr: vi.fn().mockReturnValue(of({ releases: [prowlarrRelease('a')] })),
        grabProwlarr: vi.fn(),
        ownedCopies: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      };
      const { root } = await renderProwlarr(api);

      expect(root.textContent).not.toContain('You may already have this');
      expect(root.querySelector('.release .download')).not.toBeNull();
    });
  });

  it('warns about a copy you already have before picking a Whisparr release', async () => {
    const api = {
      search: vi.fn().mockReturnValue(of({ movieId: 1, releases: [release('a')] })),
      grab: vi.fn(),
      prowlarrStatus: noProwlarr,
      ownedCopies: vi.fn().mockReturnValue(
        of({
          copies: [
            {
              reason: 'FINGERPRINT',
              stashSceneId: '7',
              title: 'Beach Day',
              studio: 'Studio',
              date: '2024-05-01',
              path: '/library/beach.mp4',
              imageUrl: null,
              whisparrUrl: null,
            },
          ],
        }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [ReleasePickerComponent],
      providers: [
        provideRouter([]),
        { provide: ReleasesApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReleasePickerComponent);
    fixture.componentRef.setInput('stashId', 'abc');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(api.ownedCopies).toHaveBeenCalledWith('abc', null);
    expect(root.textContent).toContain('Same file fingerprint');
    expect(root.textContent).toContain('/library/beach.mp4');

    (root.querySelector('button.proceed') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(root.textContent).not.toContain('You may already have this');
  });
});
