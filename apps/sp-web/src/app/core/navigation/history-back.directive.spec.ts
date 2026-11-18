import { Component, signal } from '@angular/core';
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router, RouterLink, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { HistoryBackDirective, sameUrl } from './history-back.directive';
import { NavigationHistoryService } from './navigation-history.service';

@Component({
  imports: [RouterLink, HistoryBackDirective],
  template: `<a appHistoryBack [routerLink]="'/search'" [queryParams]="{ q: 'anna' }">Back</a>`,
})
class Host {}

async function render(previous: string | null) {
  const back = vi.fn();
  await TestBed.configureTestingModule({
    imports: [Host],
    providers: [
      provideRouter([]),
      { provide: NavigationHistoryService, useValue: { previous: signal(previous) } },
      { provide: Location, useValue: { back, path: () => '' } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const link = (fixture.nativeElement as HTMLElement).querySelector('a')!;
  return { link, back, navigate };
}

describe('HistoryBackDirective', () => {
  it('goes back in history when the link leads to the page you came from', async () => {
    const { link, back, navigate } = await render('/search?q=anna');
    link.click();
    expect(back).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
  });

  it('opens the link as usual when you came from somewhere else', async () => {
    const { link, back, navigate } = await render('/home');
    link.click();
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalled();
    TestBed.resetTestingModule();
  });

  it('compares pages whatever the order of their query', () => {
    expect(sameUrl('/scenes?a=1&b=2', '/scenes?b=2&a=1')).toBe(true);
    expect(sameUrl('/scenes?a=1', '/scenes?a=2')).toBe(false);
  });
});
