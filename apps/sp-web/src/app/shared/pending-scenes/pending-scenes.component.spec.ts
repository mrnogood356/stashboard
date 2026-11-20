import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { PendingScenesComponent } from './pending-scenes.component';

const scene = {
  editId: 'e1',
  title: 'Coming Soon',
  date: '2026-12-01',
  duration: 1800,
  studioName: 'Gold Studio',
  performers: ['Nova', 'Mia', 'Zed'],
  imageUrl: null,
  votes: 1,
  submittedAt: null,
  url: 'https://stashdb.org/edits/e1',
};

async function render(response: unknown, kind: 'studio' | 'performer' = 'studio') {
  const discover = {
    getStudioPendingScenes: vi.fn(() => response),
    getPerformerPendingScenes: vi.fn(() => response),
  };
  await TestBed.configureTestingModule({
    imports: [PendingScenesComponent],
    providers: [{ provide: DiscoverService, useValue: discover }],
  }).compileComponents();
  const fixture = TestBed.createComponent(PendingScenesComponent);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('targetId', 's1');
  fixture.detectChanges();
  return { fixture, discover };
}

describe('PendingScenesComponent', () => {
  it('lists pending scenes, folded, each opening its edit', async () => {
    const { fixture, discover } = await render(of({ total: 3, items: [scene] }));
    const host: HTMLElement = fixture.nativeElement;

    expect(discover.getStudioPendingScenes).toHaveBeenCalledWith('s1');
    expect(host.textContent).toContain('Waiting to be added');
    expect(host.querySelector('.body')?.hasAttribute('hidden')).toBe(true);

    (host.querySelector('[data-testid="pending-scenes-toggle"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const card = host.querySelector('[data-testid="pending-scene"]') as HTMLAnchorElement;
    expect(card.href).toBe('https://stashdb.org/edits/e1');
    expect(card.target).toBe('_blank');
    expect(card.textContent).toContain('2026-12-01 · Nova, Mia');
    expect(card.textContent).toContain('1 vote · View edit');
    expect(host.textContent).toContain('The newest 1 of 3.');
  });

  it('asks for a performer’s pending scenes on a performer page', async () => {
    const { discover } = await render(of({ total: 0, items: [] }), 'performer');
    expect(discover.getPerformerPendingScenes).toHaveBeenCalledWith('s1');
  });

  it('shows nothing when there are none, or the catalog can’t be reached', async () => {
    const { fixture } = await render(throwError(() => new Error('down')));
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });
});
