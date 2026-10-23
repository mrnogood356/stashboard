import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrganizerApiService } from '../../core/api/organizer.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { OrganizePageComponent } from './organize-page.component';

const idle = {
  running: false,
  kind: null,
  processed: 0,
  total: 0,
  matched: 0,
  renamed: 0,
  skipped: 0,
  failed: 0,
  message: null,
};
const settings = {
  renamePattern: '{studio}/{date} - {title}',
  renameRoot: '',
  libraryRoots: ['/data/stash content', '/data/scenes'],
  renameAfterMatch: false,
  moveUnmatched: true,
  cleanEmptyFolders: true,
  keepFolders: [],
  folderAccess: true,
  skipWhisparrFiles: true,
  autoMatchNightly: false,
  useStashScrapers: true,
  hasTpdbKey: false,
  sources: [
    { name: 'StashDB', kind: 'catalog' },
    { name: 'FansDB', kind: 'stash-box' },
  ],
  scrapers: ['Site A'],
  tokens: ['title', 'studio', 'date'],
  run: idle,
  lastRun: { kind: null, at: null, status: null, message: null },
  undo: null,
};
const scene = {
  id: '7',
  title: null,
  fileName: 'Studio.23.08.14.Title.mp4',
  folder: '/data/inbox',
  duration: 1800,
  size: 1e9,
  resolution: '1080p',
  imageUrl: null,
  hasFingerprint: true,
};
const candidate = {
  id: 'r1',
  title: 'Title',
  date: '2023-08-14',
  studio: 'Studio',
  performers: ['Jane'],
  imageUrl: null,
  duration: 1801,
  code: null,
  source: 'FansDB',
  score: 1,
  confidence: 'exact',
  reasons: ['Same video fingerprint'],
};

async function render(api: Record<string, unknown>, tab?: string) {
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [OrganizePageComponent],
    providers: [
      provideRouter([]),
      {
        provide: OrganizerApiService,
        useValue: { proposals: vi.fn().mockReturnValue(of([])), ...api },
      },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  if (tab) {
    const router = TestBed.inject(await import('@angular/router').then((m) => m.Router));
    await router.navigateByUrl(`/?tab=${tab}`);
  }
  const fixture = TestBed.createComponent(OrganizePageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!found) {
    throw new Error(`No button "${text}"`);
  }
  return found as HTMLButtonElement;
}

describe('OrganizePageComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('lists the matches Match all found and saves only the ones you tick', async () => {
    const saveProposals = vi.fn().mockReturnValue(of({ ...idle, running: true, kind: 'match' }));
    const dismissProposals = vi.fn().mockReturnValue(of({ left: 0 }));
    const chooseProposal = vi.fn();
    const proposal = {
      scene: { ...scene, id: '8', fileName: 'other.mp4' },
      match: {
        ...candidate,
        confidence: 'likely',
        cast: [{ name: 'Jane', imageUrl: 'https://img/jane.jpg' }],
        tags: ['Outdoors'],
      },
      alternatives: [
        { ...candidate, id: 'r2', title: 'Other Title', confidence: 'likely' },
        { ...candidate, id: 'r3', title: 'Third', confidence: 'weak' },
      ],
      others: 2,
      foundAt: '2026-01-01T00:00:00Z',
    };
    chooseProposal.mockReturnValue(
      of({
        ...proposal,
        match: { ...proposal.match, id: 'r2', title: 'Swapped Title' },
        alternatives: [candidate],
      }),
    );
    const { fixture, root } = await render({
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 2, page: 1, hasMore: false, items: [scene] })),
      status: vi.fn().mockReturnValue(of(idle)),
      proposals: vi.fn().mockReturnValue(
        of([
          {
            scene,
            match: candidate,
            alternatives: [],
            others: 0,
            foundAt: '2026-01-01T00:00:00Z',
          },
          proposal,
        ]),
      ),
      saveProposals,
      dismissProposals,
      chooseProposal,
    });

    expect(root.textContent).toContain('Check these matches');
    expect(root.querySelector('.face img')?.getAttribute('src')).toBe('https://img/jane.jpg');
    expect(root.textContent).toContain('Outdoors');
    (root.querySelector('[aria-label="Use Other Title instead"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(chooseProposal).toHaveBeenCalledWith('8', 'r2');
    expect(root.textContent).toContain('Swapped Title');
    button(root, 'Only “Same video”').click();
    fixture.detectChanges();
    button(root, 'Save 1').click();
    fixture.detectChanges();
    expect(saveProposals).toHaveBeenCalledWith(['7']);

    button(root, 'Wrong').click();
    fixture.detectChanges();
    expect(dismissProposals).toHaveBeenCalledWith(['8']);
    expect(root.textContent).not.toContain('Check these matches');
  });

  it('finds a match for a scene and saves it', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 1, page: 1, hasMore: false, items: [scene] })),
      lookup: vi
        .fn()
        .mockReturnValue(of([{ sceneId: '7', searchedFor: null, candidates: [candidate] }])),
      apply: vi
        .fn()
        .mockReturnValue(of({ sceneId: '7', renamedTo: '/data/Studio/2023-08-14 - Title.mp4' })),
    };
    const { fixture, root, notifications } = await render(api);
    expect(root.textContent).toContain('Studio.23.08.14.Title.mp4');

    button(root, 'Find match').click();
    fixture.detectChanges();
    expect(api.lookup).toHaveBeenCalledWith(['7'], undefined);
    expect(root.textContent).toContain('Same video');
    expect(root.textContent).toContain('FansDB');

    button(root, 'This one').click();
    fixture.detectChanges();
    expect(api.apply).toHaveBeenCalledWith('7', 'r1');
    expect(notifications.success).toHaveBeenCalledWith(
      'Matched',
      expect.stringContaining('2023-08-14 - Title.mp4'),
    );
    expect(root.textContent).not.toContain('Studio.23.08.14.Title.mp4');
  });

  it('picks scenes in the Match list and matches just those', async () => {
    const matchSelected = vi.fn().mockReturnValue(of({ ...idle, running: true, kind: 'match' }));
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 1, page: 1, hasMore: false, items: [scene] })),
      status: vi.fn().mockReturnValue(of(idle)),
      matchSelected,
    };
    const { fixture, root } = await render(api);

    button(root, 'Pick scenes').click();
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.pick-overlay')!.click();
    fixture.detectChanges();
    expect(root.textContent).toContain('1 selected');
    button(root, 'Match picked').click();
    fixture.detectChanges();

    expect(matchSelected).toHaveBeenCalledWith(['7']);
    expect(root.querySelector('app-selection-bar')).toBeNull();
    fixture.destroy();
  });

  it('turns on nightly matching', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      update: vi.fn().mockReturnValue(of({ ...settings, autoMatchNightly: true })),
    };
    const { root } = await render(api, 'settings');
    (root.querySelector('[role="switch"]') as HTMLButtonElement).click();
    expect(api.update).toHaveBeenCalledWith({ autoMatchNightly: true });
  });

  it('searches, filters and sorts the list, keeping the unmatched count', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi
        .fn()
        .mockReturnValueOnce(of({ total: 12, page: 1, hasMore: false, items: [] }))
        .mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
    };
    vi.useFakeTimers();
    const { fixture, root } = await render(api);

    const input = root.querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'summer';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    const [scope, sort] = Array.from(root.querySelectorAll('.list-select select'));
    (scope as HTMLSelectElement).value = 'all';
    scope.dispatchEvent(new Event('change'));
    (sort as HTMLSelectElement).value = 'added-asc';
    sort.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    vi.useRealTimers();

    expect(api.unmatched).toHaveBeenCalledWith(1, {
      q: 'summer',
      sort: 'added-desc',
      scope: 'unmatched',
    });
    expect(api.unmatched).toHaveBeenLastCalledWith(1, {
      q: 'summer',
      sort: 'added-asc',
      scope: 'all',
    });
    expect(root.textContent).toContain('No scenes match.');
    // Match all still counts every unmatched scene, not the search.
    expect(root.textContent).toContain('Match all 12');
  });

  it('shows the Whisparr folder mapping read-only and links to Settings to change it', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(
        of({
          ...settings,
          whisparrAvailable: true,
          sendToWhisparr: true,
          whisparrImportMode: 'move',
          missingInWhisparr: 0,
          whisparrPathFrom: '/data',
          whisparrPathTo: '/mnt/user/media',
        }),
      ),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
    };
    const { root } = await render(api, 'settings');
    const mapping = root.querySelector('.whisparr-card .mapping') as HTMLElement;
    expect(mapping).toBeTruthy();
    expect(mapping.textContent).toContain('/data');
    expect(mapping.textContent).toContain('/mnt/user/media');
    expect(mapping.querySelector('input')).toBeNull();
    expect(mapping.querySelector('button')).toBeNull();
    const link = mapping.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toContain('Change in Settings → Integrations');
    expect(link.getAttribute('href')).toBe('/settings/integrations#whisparr-folder-mapping');
  });

  it('says the Whisparr folder mapping is not set yet', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(
        of({
          ...settings,
          whisparrAvailable: true,
          whisparrImportMode: 'move',
          missingInWhisparr: 0,
          whisparrPathFrom: '',
          whisparrPathTo: '',
        }),
      ),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
    };
    const { root } = await render(api, 'settings');
    const mapping = root.querySelector('.whisparr-card .mapping') as HTMLElement;
    expect(mapping.textContent).toContain('Not set');
    expect(mapping.querySelector('a')?.getAttribute('href')).toContain('/settings/integrations');
  });

  it('lists the sources and adds a ThePornDB key', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      update: vi.fn().mockReturnValue(of({ ...settings, hasTpdbKey: true })),
    };
    const { fixture, root } = await render(api, 'settings');
    expect(root.querySelector('.source-list')?.textContent).toContain('FansDB');
    // Stash's scrapers aren't a step of matching; they're offered one scene at a time.
    expect(root.querySelector('.source-list')?.textContent).not.toContain('Stash’s scrapers');
    button(root, 'Add ThePornDB').click();
    fixture.detectChanges();
    (root.querySelector('#tpdb-key') as HTMLInputElement).value = ' key-123 ';
    (root.querySelector('#tpdb-key') as HTMLInputElement).form!.dispatchEvent(new Event('submit'));
    expect(api.update).toHaveBeenCalledWith({ tpdbApiKey: 'key-123' });
  });

  it('explains a taken name and deletes the extra copy only on a second tap', async () => {
    const taken = {
      sceneId: '5',
      fileId: 'f5',
      title: 'Anal Training',
      from: '/data/S/T (2).mp4',
      to: '/data/S/T.mp4',
      state: 'taken',
      taken: {
        otherSceneId: '9',
        sameSize: true,
        fix: 'merge',
        note: 'Same size, so almost surely the same video.',
      },
    };
    const preview = {
      pattern: settings.renamePattern,
      scanned: 1,
      counts: {
        ready: 0,
        same: 0,
        missing: 0,
        whisparr: 0,
        outside: 0,
        'no-file': 0,
        gone: 0,
        taken: 1,
        copy: 0,
      },
      changes: [],
      skipped: [taken],
    };
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      preview: vi.fn().mockReturnValue(of(preview)),
      whisparrRelocation: vi
        .fn()
        .mockReturnValue(of({ destination: null, count: 0, examples: [] })),
      emptyFolders: vi.fn().mockReturnValue(of({ available: true, count: 0, folders: [] })),
      whisparrRepair: vi.fn().mockReturnValue(of({ count: 0, destination: null })),
      fixTaken: vi.fn().mockReturnValue(of({ scanned: 0, merged: 1, skipped: [] })),
      status: vi.fn().mockReturnValue(of(idle)),
    };
    const { fixture, root } = await render(api, 'rename');
    button(root, 'Show the files').click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Same size, so almost surely the same video.');

    button(root, 'Keep the named file, delete this copy').click();
    fixture.detectChanges();
    expect(api.fixTaken).not.toHaveBeenCalled();
    button(root, 'Tap again to delete this copy').click();
    expect(api.fixTaken).toHaveBeenCalledWith(['5']);
    expect(api.preview).toHaveBeenCalledTimes(2);
  });

  it('keeps a folder from the empty-folder list, a typed one, and stops keeping one', async () => {
    const empty = {
      available: true,
      count: 1,
      folders: ['/data/stash content/fansdb'],
    };
    let saved = { ...settings, keepFolders: [] as string[] };
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      preview: vi.fn().mockReturnValue(
        of({
          pattern: settings.renamePattern,
          scanned: 0,
          counts: {
            ready: 0,
            same: 0,
            missing: 0,
            whisparr: 0,
            outside: 0,
            'no-file': 0,
            gone: 0,
            taken: 0,
          },
          changes: [],
          skipped: [],
        }),
      ),
      whisparrRelocation: vi
        .fn()
        .mockReturnValue(of({ destination: null, count: 0, examples: [] })),
      whisparrRepair: vi.fn().mockReturnValue(of({ count: 0, destination: null })),
      emptyFolders: vi.fn().mockReturnValue(of(empty)),
      status: vi.fn().mockReturnValue(of({ running: false })),
      update: vi.fn((update: { keepFolders: string[] }) => {
        saved = { ...saved, keepFolders: update.keepFolders };
        return of(saved);
      }),
    };
    const { fixture, root } = await render(api, 'rename');

    button(root, 'Keep').click();
    fixture.detectChanges();
    expect(api.update).toHaveBeenLastCalledWith({ keepFolders: ['/data/stash content/fansdb'] });
    expect(root.querySelector('.keep-folders')?.textContent).toContain(
      '/data/stash content/fansdb',
    );

    const input = root.querySelector('#keep-folder-input') as HTMLInputElement;
    input.value = '/data/stash content/Keep me';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(root, 'Add').click();
    fixture.detectChanges();
    expect(api.update).toHaveBeenLastCalledWith({
      keepFolders: ['/data/stash content/fansdb', '/data/stash content/Keep me'],
    });
    expect(input.value).toBe('');

    (
      root.querySelector(
        '[aria-label="Stop keeping /data/stash content/fansdb"]',
      ) as HTMLButtonElement
    ).click();
    expect(api.update).toHaveBeenLastCalledWith({
      keepFolders: ['/data/stash content/Keep me'],
    });
  });

  it('previews renames and asks twice before renaming', async () => {
    const preview = {
      pattern: settings.renamePattern,
      scanned: 2,
      counts: {
        ready: 1,
        same: 1,
        missing: 2,
        whisparr: 9,
        outside: 0,
        'no-file': 0,
        gone: 0,
        taken: 0,
        copy: 0,
      },
      changes: [
        {
          sceneId: '1',
          fileId: 'f',
          title: 'Title',
          from: '/data/in/x.mp4',
          to: '/data/Studio/2023-08-14 - Title.mp4',
          state: 'ready',
        },
      ],
      skipped: [],
    };
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      preview: vi.fn().mockReturnValue(of(preview)),
      whisparrRelocation: vi.fn().mockReturnValue(
        of({
          destination: '/data/stash content/scenes',
          count: 4,
          examples: ['/data/stash content/Studio/A'],
        }),
      ),
      relocateWhisparr: vi.fn().mockReturnValue(of({ ...idle, kind: 'whisparr' })),
      emptyFolders: vi.fn().mockReturnValue(
        of({
          available: true,
          count: 2,
          folders: ['/data/stash content/scenes/scenes', '/data/stash content/scenes/scenes/S'],
        }),
      ),
      cleanEmptyFolders: vi.fn().mockReturnValue(of({ removed: 2, kept: 0 })),
      whisparrRepair: vi
        .fn()
        .mockReturnValue(of({ count: 3, destination: '/data/stash content/scenes' })),
      repairWhisparr: vi.fn().mockReturnValue(of({ ...idle, kind: 'whisparr' })),
      renameAll: vi.fn().mockReturnValue(of({ ...idle, running: true, kind: 'rename' })),
      status: vi.fn().mockReturnValue(of(idle)),
    };
    const { fixture, root } = await render(api, 'rename');
    expect(api.preview).toHaveBeenCalled();
    expect(root.textContent).toContain('2023-08-14 - Title.mp4');
    const reasons = root.querySelector('.skip-reasons')?.textContent ?? '';
    expect(reasons).toContain('9');
    expect(reasons).toContain('Whisparr’s file');
    expect(reasons.indexOf('Whisparr’s file')).toBeLessThan(reasons.indexOf('No title yet'));

    const select = root.querySelector('.root-field select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      '/data/stash content',
      '/data/scenes',
    ]);

    expect(root.querySelector('.folders')?.textContent).toContain('2 folders with no video');
    button(root, 'Clean up 2 folders').click();
    fixture.detectChanges();
    expect(api.cleanEmptyFolders).not.toHaveBeenCalled();
    button(root, 'Tap again to remove 2').click();
    expect(api.cleanEmptyFolders).toHaveBeenCalled();
    fixture.detectChanges();
    expect(root.querySelector('.repair')?.textContent).toContain(
      '3 Whisparr scenes are in the wrong folder',
    );
    button(root, 'Repair Whisparr').click();
    expect(api.repairWhisparr).toHaveBeenCalled();
    expect(root.querySelector('.relocate')?.textContent).toContain('/data/stash content/scenes');
    button(root, 'Have Whisparr move them').click();
    fixture.detectChanges();
    expect(api.relocateWhisparr).not.toHaveBeenCalled();
    button(root, 'Tap again to move 4').click();
    expect(api.relocateWhisparr).toHaveBeenCalled();

    button(root, 'Rename 1 file').click();
    fixture.detectChanges();
    expect(api.renameAll).not.toHaveBeenCalled();
    button(root, 'Tap again').click();
    expect(api.renameAll).toHaveBeenCalled();
    fixture.destroy();
  });

  function renameApi(overrides: Record<string, unknown> = {}) {
    return {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      preview: vi.fn().mockReturnValue(of(renamePreview(settings.renamePattern))),
      whisparrRelocation: vi
        .fn()
        .mockReturnValue(of({ destination: null, count: 0, examples: [] })),
      emptyFolders: vi.fn().mockReturnValue(of({ available: true, count: 0, folders: [] })),
      whisparrRepair: vi.fn().mockReturnValue(of({ count: 0, destination: null })),
      renameAll: vi.fn().mockReturnValue(of({ ...idle, running: true, kind: 'rename' })),
      status: vi.fn().mockReturnValue(of(idle)),
      ...overrides,
    };
  }

  function renamePreview(pattern: string, ready = 1) {
    return {
      pattern,
      scanned: ready,
      counts: {
        ready,
        same: 0,
        missing: 0,
        whisparr: 0,
        outside: 0,
        'no-file': 0,
        gone: 0,
        taken: 0,
        copy: 0,
      },
      changes: Array.from({ length: ready }, (_, index) => ({
        sceneId: String(index + 1),
        fileId: `f${index + 1}`,
        title: `Title ${index + 1}`,
        from: `/data/in/${index + 1}.mp4`,
        to: `/data/${pattern.length}/${index + 1}.mp4`,
        state: 'ready',
      })),
      skipped: [],
    };
  }

  it('edits the folder and file formats separately, and can fill both from Whisparr', async () => {
    const api = {
      ...renameApi(),
      whisparrNaming: vi.fn().mockReturnValue(
        of({
          folderFormat: 'scenes/{Studio Title}/{Release Date} - {Scene Title}',
          fileFormat: '{Studio CleanTitleSlug}.{Scene.CleanTitle}',
          pattern: 'scenes/{studio}/{date} - {title}/{studioslug}.{title}',
          problem: null,
        }),
      ),
    };
    const { fixture, root } = await render(api, 'rename');
    const component = fixture.componentInstance as any;

    component.setPattern('{studio}/{date} - {title}');
    component.setFolderPart('scenes/{studio}');
    expect(component.pattern()).toBe('scenes/{studio}/{date} - {title}');
    component.setFilePart('{title}/x');
    expect(component.pattern()).toBe('scenes/{studio}/{title}x');

    button(root, 'Use Whisparr’s naming').click();
    fixture.detectChanges();
    expect(component.folderPart()).toBe('scenes/{studio}/{date} - {title}');
    expect(component.filePart()).toBe('{studioslug}.{title}');
    expect(api.preview).toHaveBeenCalled();
    fixture.destroy();
  });

  it('shows why each file is renamed and marks what its name gains', async () => {
    const preview = renamePreview(settings.renamePattern);
    preview.changes[0].from = '/data/Studio/Summer Afternoon.mp4';
    preview.changes[0].to = '/data/Studio/Summer Afternoon/Studio.Summer.Afternoon.WEBDL-1080p.mp4';
    const { fixture, root } = await render(
      renameApi({ preview: vi.fn().mockReturnValue(of(preview)) }),
      'rename',
    );

    const to = root.querySelector('.change .to')!;
    expect(to.textContent?.replace(/^\s+|\s+$/g, '')).toBe(
      'To /data/Studio/Summer Afternoon/Studio.Summer.Afternoon.WEBDL-1080p.mp4',
    );
    expect(Array.from(to.querySelectorAll('.added')).map((piece) => piece.textContent)).toEqual([
      'Studio',
      'WEBDL',
      '1080p',
    ]);
    expect(Array.from(root.querySelectorAll('.why li')).map((item) => item.textContent)).toEqual([
      'Goes into its own folder: Summer Afternoon',
      'Adds Studio, WEBDL, 1080p',
    ]);
    fixture.destroy();
  });

  it('removes extra copies only after a second tap, then previews again', async () => {
    const preview = renamePreview(settings.renamePattern, 0);
    preview.counts.copy = 3;
    const removeExtraCopies = vi.fn().mockReturnValue(of({ removed: 3, failed: [] }));
    const api = renameApi({
      preview: vi.fn().mockReturnValue(of(preview)),
      removeExtraCopies,
    });
    const { fixture, root } = await render(api, 'rename');

    button(root, 'Remove 3 extra copies').click();
    fixture.detectChanges();
    expect(removeExtraCopies).not.toHaveBeenCalled();
    button(root, 'Tap again to delete 3 files').click();
    fixture.detectChanges();

    expect(removeExtraCopies).toHaveBeenCalledTimes(1);
    expect(api.preview).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('syncs with Whisparr and explains why imports leave copies behind', async () => {
    const syncWithWhisparr = vi.fn().mockReturnValue(of({ ...idle, running: true, kind: 'sync' }));
    const api = renameApi({
      settings: vi.fn().mockReturnValue(
        of({
          ...settings,
          whisparrAvailable: true,
          whisparrLeavesCopies: { by: 'whisparr', hardlinks: true },
        }),
      ),
      syncWithWhisparr,
    });
    const { fixture, root } = await render(api, 'rename');

    expect(root.querySelector('.sync .note')?.textContent).toContain('hardlinking');
    button(root, 'Sync now').click();
    fixture.detectChanges();

    expect(syncWithWhisparr).toHaveBeenCalledTimes(1);
    expect(button(root, 'Syncing…').disabled).toBe(true);
    fixture.destroy();
  });

  it('renames just one scene from the preview', async () => {
    const rename = vi
      .fn()
      .mockReturnValue(of({ moved: [{ sceneId: '1', to: '/data/x/1.mp4' }], failed: [] }));
    const api = renameApi({ rename });
    const { fixture, root, notifications } = await render(api, 'rename');

    button(root, 'Rename this one').click();
    fixture.detectChanges();

    expect(rename).toHaveBeenCalledWith(['1']);
    expect(notifications.success).toHaveBeenCalledWith('Renamed', '/data/x/1.mp4');
    expect(api.preview).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('won’t rename with a pattern nobody previewed', async () => {
    const api = renameApi();
    const { fixture, root } = await render(api, 'rename');
    const component = fixture.componentInstance as any;

    component.setPattern('{performers}/{title}');
    fixture.detectChanges();

    expect(button(root, 'Rename 1 file').disabled).toBe(true);
    expect(root.textContent).toContain('Working out names for the new pattern');
    component.renameAll();
    component.renameAll();
    expect(api.renameAll).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('shows the preview for the latest pattern, even if an older one answers last', async () => {
    const first = new Subject<unknown>();
    const second = new Subject<unknown>();
    const api = renameApi();
    const { fixture } = await render(api, 'rename');
    const component = fixture.componentInstance as any;
    api.preview.mockReturnValueOnce(first).mockReturnValueOnce(second);

    component.setPattern('{title}');
    component.loadPreview();
    component.setPattern('{studio}/{title}');
    component.loadPreview();
    second.next(renamePreview('{studio}/{title}', 3));
    first.next(renamePreview('{title}', 7));

    expect(component.preview().pattern).toBe('{studio}/{title}');
    expect(component.previewOutdated()).toBe(false);
    fixture.destroy();
  });

  it('keeps following a run after one status check fails', async () => {
    const api = renameApi();
    const { fixture } = await render(api, 'rename');
    const component = fixture.componentInstance as any;
    vi.useFakeTimers();
    try {
      api.status
        .mockReturnValueOnce(throwError(() => new Error('502')))
        .mockReturnValue(of({ ...idle, running: true, kind: 'rename' }));

      component.startPolling();
      vi.advanceTimersByTime(6_000);

      expect(api.status).toHaveBeenCalledTimes(3);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('shows which scenes a Whisparr repair would change, and where they would go', async () => {
    const api = renameApi({
      whisparrRepair: vi.fn().mockReturnValue(
        of({
          count: 2,
          destination: '/data/stash content/scenes',
          scenes: [
            {
              title: 'Summer Afternoon',
              action: 'move',
              from: '/data/stash content/scenes/scenes/Studio',
              to: '/data/stash content/scenes/Studio/2020-01-02 - Summer Afternoon',
            },
            {
              title: 'Gone Missing',
              action: 'reimport',
              from: '/data/old/Gone',
              to: null,
            },
          ],
        }),
      ),
    });
    const { fixture, root } = await render(api, 'rename');

    expect(root.querySelector('.repair-scenes')).toBeNull();
    button(root, 'Show the 2 scenes').click();
    fixture.detectChanges();

    const list = root.querySelector('.repair-scenes')?.textContent ?? '';
    expect(list).toContain('Summer Afternoon');
    expect(list).toContain('/data/stash content/scenes/Studio/2020-01-02 - Summer Afternoon');
    expect(list).toContain('Whisparr moves it, with its file');
    expect(list).toContain('Gone Missing');
    expect(list).toContain('Imported again from where Stash has the file');
    fixture.destroy();
  });

  it('offers to move only unmatched files that aren’t in the Unmatched folder yet', async () => {
    const api = {
      settings: vi.fn().mockReturnValue(of(settings)),
      unmatched: vi
        .fn()
        .mockReturnValue(of({ total: 533, toMove: 0, page: 1, hasMore: false, items: [scene] })),
    };
    const { root } = await render(api);

    expect(root.textContent).not.toContain('unmatched files now');
    expect(root.textContent).toContain('All 533 unmatched files are in the Unmatched folder.');
  });

  it('shows the whole new folder when a file moves to another library folder', async () => {
    const preview = {
      ...renamePreview(settings.renamePattern),
      changes: [
        {
          sceneId: '1',
          fileId: 'f1',
          title: 'Title',
          from: '/data/old library/Studio/2020-01-02 - Title.mp4',
          to: '/data/stash content/Studio/2020-01-02 - Title.mp4',
          state: 'ready',
        },
      ],
    };
    const api = renameApi({ preview: vi.fn().mockReturnValue(of(preview)) });
    const { root, fixture } = await render(api, 'rename');

    expect(root.querySelector('.changes .to')?.textContent).toContain(
      '/data/stash content/Studio/',
    );
    fixture.destroy();
  });

  it('previews a pattern a moment after typing stops, and right away on Enter', async () => {
    const api = renameApi();
    api.preview.mockImplementation((pattern?: string) => of(renamePreview(pattern ?? '', 2)));
    const { fixture, root } = await render(api, 'rename');
    vi.useFakeTimers();
    try {
      const calls = api.preview.mock.calls.length;
      const file = root.querySelector('#rename-file') as HTMLInputElement;
      file.value = '{date}';
      file.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(300);
      file.value = '{date} {title}';
      file.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(root.textContent).toContain('Working out names for the new pattern');
      vi.advanceTimersByTime(300);
      expect(api.preview).toHaveBeenCalledTimes(calls);

      vi.advanceTimersByTime(400);
      expect(api.preview).toHaveBeenCalledTimes(calls + 1);
      expect(api.preview).toHaveBeenLastCalledWith('{studio}/{date} {title}');
      fixture.detectChanges();
      expect(root.textContent).not.toContain('Working out names');
      expect(button(root, 'Rename 2 files').disabled).toBe(false);

      const folder = root.querySelector('#rename-folders') as HTMLInputElement;
      folder.value = '{year}';
      folder.dispatchEvent(new Event('input'));
      folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(api.preview).toHaveBeenLastCalledWith('{year}/{date} {title}');
      const afterEnter = api.preview.mock.calls.length;
      vi.advanceTimersByTime(1000);
      // Enter already did it; the wait for typing is called off.
      expect(api.preview).toHaveBeenCalledTimes(afterEnter);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('reloads the preview and the Whisparr repair plan after saving the pattern', async () => {
    const update = vi.fn().mockReturnValue(of({ ...settings, renamePattern: '{studio}/{title}' }));
    const api = renameApi({ update });
    const { fixture, root, notifications } = await render(api, 'rename');
    const component = fixture.componentInstance as any;
    const previews = api.preview.mock.calls.length;
    const repairs = api.whisparrRepair.mock.calls.length;
    const relocations = api.whisparrRelocation.mock.calls.length;

    // Whisparr's placeholder, which Stashboard turns into its own as it saves.
    component.setPattern('{studio}/{Scene Title}');
    fixture.detectChanges();
    button(root, 'Save pattern').click();
    fixture.detectChanges();

    expect(update).toHaveBeenCalledWith({ renamePattern: '{studio}/{Scene Title}' });
    expect(notifications.success).toHaveBeenCalledWith('Pattern saved', expect.any(String));
    expect(api.preview.mock.calls.length).toBeGreaterThan(previews);
    expect(api.whisparrRepair.mock.calls.length).toBeGreaterThan(repairs);
    expect(api.whisparrRelocation.mock.calls.length).toBeGreaterThan(relocations);
    // Shows what was saved, so it doesn't look unsaved.
    expect(component.pattern()).toBe('{studio}/{title}');
    expect(root.textContent).not.toContain('Save pattern');
    fixture.destroy();
  });

  it('keeps what was typed after Save when the save answers late', async () => {
    const saved = new Subject<unknown>();
    const api = renameApi({ update: vi.fn().mockReturnValue(saved) });
    const { fixture } = await render(api, 'rename');
    const component = fixture.componentInstance as any;

    component.setPattern('{studio}/{Scene Title}');
    component.savePattern();
    component.setPattern('{studio}/{title} more');
    saved.next({ ...settings, renamePattern: '{studio}/{title}' });

    expect(component.pattern()).toBe('{studio}/{title} more');
    expect(component.patternDirty()).toBe(true);
    fixture.destroy();
  });

  it('reloads the lists once when a run finishes', async () => {
    const api = renameApi({
      status: vi.fn().mockReturnValue(of({ ...idle, kind: 'rename', message: 'Renamed 1 file.' })),
    });
    const { fixture, root, notifications } = await render(api, 'rename');
    vi.useFakeTimers();
    try {
      const before = {
        preview: api.preview.mock.calls.length,
        repair: api.whisparrRepair.mock.calls.length,
        settings: api.settings.mock.calls.length,
      };
      button(root, 'Rename 1 file').click();
      fixture.detectChanges();
      button(root, 'Tap again').click();
      expect(api.renameAll).toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      expect(notifications.success).toHaveBeenCalledWith('Renaming finished', 'Renamed 1 file.');
      expect(api.preview).toHaveBeenCalledTimes(before.preview + 1);
      expect(api.whisparrRepair).toHaveBeenCalledTimes(before.repair + 1);
      expect(api.settings).toHaveBeenCalledTimes(before.settings + 1);

      vi.advanceTimersByTime(10_000);
      expect(api.status).toHaveBeenCalledTimes(1);
      expect(api.preview).toHaveBeenCalledTimes(before.preview + 1);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('reloads the Match list and the Rename names after matching everything', async () => {
    const api = renameApi({
      status: vi.fn().mockReturnValue(of({ ...idle, kind: 'match' })),
    });
    const { fixture } = await render(api, 'rename');
    const component = fixture.componentInstance as any;
    vi.useFakeTimers();
    try {
      const lists = api.unmatched.mock.calls.length;
      const previews = api.preview.mock.calls.length;
      component.run.set({ ...idle, running: true, kind: 'match' });
      component.startPolling();
      vi.advanceTimersByTime(2_000);
      expect(api.unmatched).toHaveBeenCalledTimes(lists + 1);
      expect(api.preview).toHaveBeenCalledTimes(previews + 1);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('works out names again on the Rename tab after a scene is matched', async () => {
    const api = {
      ...renameApi(),
      unmatched: vi.fn().mockReturnValue(of({ total: 1, page: 1, hasMore: false, items: [scene] })),
      lookup: vi
        .fn()
        .mockReturnValue(of([{ sceneId: '7', searchedFor: null, candidates: [candidate] }])),
      apply: vi.fn().mockReturnValue(of({ sceneId: '7', renamedTo: null })),
    };
    const { fixture, root } = await render(api);
    button(root, 'Rename').click();
    fixture.detectChanges();
    expect(api.preview).toHaveBeenCalledTimes(1);
    button(root, 'Match').click();
    fixture.detectChanges();
    button(root, 'Rename').click();
    fixture.detectChanges();
    // Nothing changed: the names on screen still hold.
    expect(api.preview).toHaveBeenCalledTimes(1);

    button(root, 'Match').click();
    fixture.detectChanges();
    button(root, 'Find match').click();
    fixture.detectChanges();
    button(root, 'This one').click();
    fixture.detectChanges();
    button(root, 'Rename').click();
    expect(api.preview).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('puts back only the setting that failed to save', async () => {
    const saving = new Subject<unknown>();
    const api = {
      settings: vi.fn().mockReturnValue(
        of({
          ...settings,
          whisparrAvailable: true,
          whisparrImportMode: 'move',
          missingInWhisparr: 0,
          whisparrPathFrom: '',
          whisparrPathTo: '',
        }),
      ),
      unmatched: vi.fn().mockReturnValue(of({ total: 0, page: 1, hasMore: false, items: [] })),
      update: vi.fn().mockReturnValue(saving),
    };
    const { fixture, root, notifications } = await render(api, 'settings');
    const component = fixture.componentInstance as any;

    button(root, 'Hardlink / copy').click();
    expect(component.settings().whisparrImportMode).toBe('copy');
    // Something else refreshed meanwhile, like a run finishing.
    component.settings.update((current: any) => ({ ...current, hasTpdbKey: true }));
    saving.error({ status: 500 });

    expect(component.settings().whisparrImportMode).toBe('move');
    expect(component.settings().hasTpdbKey).toBe(true);
    expect(notifications.error).toHaveBeenCalledWith('Couldn’t save', expect.any(String));
  });
});
