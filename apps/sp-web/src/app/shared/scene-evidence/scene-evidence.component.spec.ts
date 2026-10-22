import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiagnosticsApiService,
  SceneEvidence,
  evidenceText,
} from '../../core/api/diagnostics.service';
import { SceneEvidenceComponent } from './scene-evidence.component';

function evidence(overrides: Partial<SceneEvidence> = {}): SceneEvidence {
  return {
    kind: 'catalog',
    id: 'sdb-1',
    title: 'Summer Afternoon',
    checkedAt: '2026-10-21T10:00:00.000Z',
    sections: [
      {
        id: 'status',
        title: 'Status & why',
        summary: 'Stash has the file, but it isn’t linked yet.',
        error: null,
        groups: [
          {
            heading: null,
            facts: [
              { label: 'Status', value: 'Awaiting import' },
              { label: 'In your Stash library', value: 'No' },
            ],
          },
        ],
      },
      {
        id: 'whisparr',
        title: 'Whisparr',
        summary: null,
        error: 'Couldn’t ask Whisparr: connect ECONNREFUSED',
        groups: [{ heading: null, facts: [{ label: 'Movie id', value: '7' }] }],
      },
      {
        id: 'stash',
        title: 'Stash',
        summary: 'One Stash scene is linked to it.',
        error: null,
        groups: [
          {
            heading: 'Stash scene 12',
            facts: [{ label: 'File', value: '/data/a.mp4' }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('SceneEvidenceComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  async function render(
    options: {
      kind?: 'catalog' | 'local';
      catalogScene?: ReturnType<typeof vi.fn>;
      localScene?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const api = {
      catalogScene: options.catalogScene ?? vi.fn().mockReturnValue(of(evidence())),
      localScene:
        options.localScene ?? vi.fn().mockReturnValue(of(evidence({ kind: 'local', id: '12' }))),
    };
    await TestBed.configureTestingModule({
      imports: [SceneEvidenceComponent],
      providers: [{ provide: DiagnosticsApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SceneEvidenceComponent);
    fixture.componentRef.setInput('kind', options.kind ?? 'catalog');
    fixture.componentRef.setInput('sceneId', options.kind === 'local' ? '12' : 'sdb-1');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLButtonElement>('.evidence-toggle')!;
    const open = async () => {
      toggle.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, root, api, toggle, open };
  }

  it('starts collapsed and asks nothing until opened', async () => {
    const { root, api, toggle } = await render();

    expect(toggle.textContent).toContain('Why is it like this?');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.evidence-body')).toBeNull();
    expect(api.catalogScene).not.toHaveBeenCalled();
  });

  it('loads the catalog scene’s evidence when opened, only once', async () => {
    const { api, toggle, open } = await render();

    await open();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(api.catalogScene).toHaveBeenCalledWith('sdb-1');

    // Closing and opening again keeps what was seen.
    await open();
    await open();
    expect(api.catalogScene).toHaveBeenCalledTimes(1);
  });

  it('asks about a library scene by its Stash id', async () => {
    const { api, open } = await render({ kind: 'local' });

    await open();

    expect(api.localScene).toHaveBeenCalledWith('12');
    expect(api.catalogScene).not.toHaveBeenCalled();
  });

  it('shows each section’s summary and facts', async () => {
    const { root, open } = await render();

    await open();

    const sections = Array.from(root.querySelectorAll<HTMLElement>('.evidence-section'));
    expect(sections.map((section) => section.querySelector('h3')?.textContent?.trim())).toEqual([
      'Status & why',
      'Whisparr',
      'Stash',
    ]);
    expect(sections[0].textContent).toContain('Stash has the file, but it isn’t linked yet.');
    expect(sections[0].textContent).toContain('Awaiting import');
    expect(sections[2].querySelector('h4')?.textContent).toContain('Stash scene 12');
    expect(sections[2].textContent).toContain('/data/a.mp4');
  });

  it('shows a section that couldn’t be checked with its message, and keeps the rest', async () => {
    const { root, open } = await render();

    await open();

    const whisparr = root.querySelector<HTMLElement>('[data-section="whisparr"]')!;
    expect(whisparr.querySelector('.evidence-error')?.textContent).toContain(
      'Couldn’t ask Whisparr: connect ECONNREFUSED',
    );
    expect(whisparr.textContent).toContain('Movie id');
    expect(root.querySelector('[data-section="stash"] .evidence-error')).toBeNull();
  });

  it('says so when the whole lookup fails, and can try again', async () => {
    const catalogScene = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('offline')))
      .mockReturnValue(of(evidence()));
    const { root, fixture, open } = await render({ catalogScene });

    await open();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t ask Stashboard what it sees',
    );

    root.querySelector<HTMLButtonElement>('.evidence-body .app-btn')!.click();
    fixture.detectChanges();
    expect(catalogScene).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll('.evidence-section')).toHaveLength(3);
  });

  it('copies the whole evidence as plain text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { root, fixture, open } = await render();
    await open();

    const copy = root.querySelector<HTMLButtonElement>('.evidence-copy')!;
    copy.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith(evidenceText(evidence()));
    expect(copy.textContent).toContain('Copied');
  });

  it('says how to copy by hand when the browser won’t', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { root, fixture, open } = await render();
    await open();

    root.querySelector<HTMLButtonElement>('.evidence-copy')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(root.textContent).toContain('Couldn’t copy here');
  });
});

describe('evidenceText', () => {
  it('puts every section, its problem and its facts on plain lines', () => {
    expect(evidenceText(evidence())).toBe(
      [
        'What Stashboard sees: Summer Afternoon (Catalog scene sdb-1)',
        'Checked 2026-10-21T10:00:00.000Z',
        '',
        '== Status & why ==',
        'Stash has the file, but it isn’t linked yet.',
        'Status: Awaiting import',
        'In your Stash library: No',
        '',
        '== Whisparr ==',
        '! Couldn’t ask Whisparr: connect ECONNREFUSED',
        'Movie id: 7',
        '',
        '== Stash ==',
        'One Stash scene is linked to it.',
        'Stash scene 12:',
        '  File: /data/a.mp4',
      ].join('\n'),
    );
  });
});
