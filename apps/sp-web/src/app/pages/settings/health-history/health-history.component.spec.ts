import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AboutApiService, HealthHistoryResponse } from '../../../core/api/about.service';
import { HealthHistoryComponent, hourState } from './health-history.component';

const HISTORY: HealthHistoryResponse = {
  since: '2026-11-01T00:00:00.000Z',
  services: [
    {
      service: 'STASH',
      label: 'Stash',
      checks: 36,
      upPercent: 97.2,
      averageMs: 140,
      lastProblem: { at: '2026-11-01T02:10:00.000Z', error: 'ECONNREFUSED' },
      hours: [
        { at: '2026-11-01T00:00:00.000Z', checks: 12, failed: 0, averageMs: 120 },
        { at: '2026-11-01T01:00:00.000Z', checks: 0, failed: 0, averageMs: null },
        { at: '2026-11-01T02:00:00.000Z', checks: 12, failed: 1, averageMs: 160 },
        { at: '2026-11-01T03:00:00.000Z', checks: 12, failed: 12, averageMs: null },
      ],
    },
  ],
};

describe('HealthHistoryComponent', () => {
  async function render(history: AboutApiService['history']) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HealthHistoryComponent],
      providers: [{ provide: AboutApiService, useValue: { history } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(HealthHistoryComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('draws a bar per hour with its state, the week’s numbers and the problem hours', async () => {
    const root = await render(() => of(HISTORY));
    const bars = Array.from(root.querySelectorAll('.hour')) as HTMLElement[];

    expect(bars.map((bar) => bar.dataset['state'])).toEqual(['ok', 'none', 'some', 'down']);
    expect(bars[2].getAttribute('title')).toContain('11 of 12 checks answered, 160 ms on average');
    expect(root.textContent).toContain('97.2% answered · 140 ms on average');
    expect(root.textContent).toContain('ECONNREFUSED');
    expect(root.querySelectorAll('.problems li').length).toBe(2);
    expect(root.querySelector('.strip')?.getAttribute('aria-label')).toContain('Stash');
  });

  it('says so before the first checks, and when it can’t read them', async () => {
    expect((await render(() => of({ since: '', services: [] }))).textContent).toContain(
      'first results show here shortly',
    );
    expect((await render(() => throwError(() => new Error('x')))).textContent).toContain(
      'Couldn’t read the history',
    );
  });

  it('tells hours apart', () => {
    expect(hourState({ at: '', checks: 0, failed: 0, averageMs: null })).toBe('none');
    expect(hourState({ at: '', checks: 3, failed: 3, averageMs: null })).toBe('down');
  });
});
