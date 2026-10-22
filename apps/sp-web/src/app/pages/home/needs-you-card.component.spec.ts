import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AuthStateStore } from '../../core/api/auth-state.store';
import { HomeService } from '../../core/api/home.service';
import { HomeAttention } from '../../core/api/home.types';
import { clearUserCaches, writeUserCache } from '../../core/cache/user-cache';
import { NeedsYouCardComponent } from './needs-you-card.component';

const NOTHING: HomeAttention = {
  matchesToCheck: 0,
  failed: 0,
  waitingForImport: 0,
  unmatched: 0,
};

async function render(attention$: Observable<HomeAttention>, username?: string) {
  const homeService = { getAttention: vi.fn().mockReturnValue(attention$) };
  await TestBed.configureTestingModule({
    imports: [NeedsYouCardComponent],
    providers: [provideRouter([]), { provide: HomeService, useValue: homeService }],
  }).compileComponents();
  if (username) {
    TestBed.inject(AuthStateStore).sync({
      authenticated: true,
      username,
    } as Parameters<AuthStateStore['sync']>[0]);
  }
  const fixture = TestBed.createComponent(NeedsYouCardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, root, homeService };
}

function row(root: HTMLElement, id: keyof HomeAttention): HTMLAnchorElement | null {
  return root.querySelector<HTMLAnchorElement>(`[data-testid="needs-you-${id}"]`);
}

describe('NeedsYouCardComponent', () => {
  afterEach(() => {
    clearUserCaches();
  });

  it('shows a row with its count for each thing that needs the user', async () => {
    const { root } = await render(
      of({ matchesToCheck: 2, failed: 3, waitingForImport: 1, unmatched: 12 }),
    );

    expect(root.querySelector('[data-testid="needs-you-card"]')).not.toBeNull();
    expect(root.textContent).toContain('Needs you');
    expect(row(root, 'matchesToCheck')?.textContent).toContain('Matches to check');
    expect(row(root, 'matchesToCheck')?.textContent).toContain('2');
    expect(row(root, 'failed')?.textContent).toContain('Stuck downloads');
    expect(row(root, 'failed')?.textContent).toContain('3');
    expect(row(root, 'waitingForImport')?.textContent).toContain('Waiting for import');
    expect(row(root, 'waitingForImport')?.textContent).toContain('1');
    expect(row(root, 'unmatched')?.textContent).toContain('Scenes not matched');
    expect(row(root, 'unmatched')?.textContent).toContain('12');
  });

  it('links each row to where to act', async () => {
    const { root } = await render(
      of({ matchesToCheck: 2, failed: 3, waitingForImport: 1, unmatched: 12 }),
    );

    expect(row(root, 'matchesToCheck')?.getAttribute('href')).toBe('/tools/organize?tab=match');
    expect(row(root, 'failed')?.getAttribute('href')).toBe('/acquisition?lifecycle=FAILED');
    expect(row(root, 'waitingForImport')?.getAttribute('href')).toBe(
      '/acquisition?lifecycle=IMPORT_PENDING',
    );
    expect(row(root, 'unmatched')?.getAttribute('href')).toBe('/tools/organize');
  });

  it('hides rows with nothing to do or an unreachable source', async () => {
    const { root } = await render(
      of({ matchesToCheck: 0, failed: 4, waitingForImport: null, unmatched: 0 }),
    );

    expect(row(root, 'failed')).not.toBeNull();
    expect(row(root, 'matchesToCheck')).toBeNull();
    expect(row(root, 'waitingForImport')).toBeNull();
    expect(row(root, 'unmatched')).toBeNull();
  });

  it('hides the whole card when nothing needs the user', async () => {
    const { root } = await render(of(NOTHING));

    expect(root.querySelector('[data-testid="needs-you-card"]')).toBeNull();
    expect(root.textContent?.trim()).toBe('');
  });

  it('hides the whole card when every source is down', async () => {
    const { root } = await render(
      of({ matchesToCheck: null, failed: null, waitingForImport: null, unmatched: null }),
    );

    expect(root.querySelector('[data-testid="needs-you-card"]')).toBeNull();
  });

  it('hides the whole card when the request fails', async () => {
    const { root } = await render(throwError(() => new Error('offline')));

    expect(root.querySelector('[data-testid="needs-you-card"]')).toBeNull();
  });

  it("shows the last visit's counts while fresh ones load", async () => {
    writeUserCache('admin', 'home.attention', { ...NOTHING, failed: 5 });

    const { root } = await render(new Observable<HomeAttention>(), 'admin');

    expect(row(root, 'failed')?.textContent).toContain('5');
  });
});
