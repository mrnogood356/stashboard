import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PULL_TO_RELOAD_PX, PullToRefreshComponent } from './pull-to-refresh.component';

function touch(type: string, x: number, y: number): TouchEvent {
  const event = new Event(type) as TouchEvent;
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  return event;
}

describe('PullToRefreshComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  async function render(standalone: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        ({ matches: standalone && query.includes('standalone') }) as MediaQueryList,
    });
    await TestBed.configureTestingModule({
      imports: [PullToRefreshComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(PullToRefreshComponent);
    fixture.detectChanges();
    return fixture;
  }

  const pull = (distance: number, sideways = 0) => {
    window.dispatchEvent(touch('touchstart', 100, 100));
    window.dispatchEvent(touch('touchmove', 100 + sideways, 100 + distance));
  };

  it('shows the arrow as you pull from the top, and refreshes past the mark', async () => {
    const fixture = await render(true);
    const reload = vi
      .spyOn(fixture.componentInstance as unknown as { refresh: () => Promise<void> }, 'refresh')
      .mockResolvedValue(undefined);

    pull(40);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pull')).not.toBeNull();
    window.dispatchEvent(touch('touchend', 0, 0));
    expect(reload).not.toHaveBeenCalled();

    pull(Math.ceil(PULL_TO_RELOAD_PX / 0.55) + 10);
    window.dispatchEvent(touch('touchend', 0, 0));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the page in place, without reloading the app, then the marker goes', async () => {
    vi.useFakeTimers();
    const fixture = await render(true);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/scenes?sort=new');

    pull(Math.ceil(PULL_TO_RELOAD_PX / 0.55) + 10);
    window.dispatchEvent(touch('touchend', 0, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(navigate.mock.calls.map((call) => call[0])).toEqual(['/refreshing', '/scenes?sort=new']);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pull.reloading')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pull')).toBeNull();
    vi.useRealTimers();
  });

  it('doesn’t reload when a second finger joins a pull', async () => {
    await render(true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    pull(Math.ceil(PULL_TO_RELOAD_PX / 0.55) + 10);
    const pinch = new Event('touchstart') as TouchEvent;
    Object.defineProperty(pinch, 'touches', {
      value: [
        { clientX: 100, clientY: 300 },
        { clientX: 200, clientY: 300 },
      ],
    });
    window.dispatchEvent(pinch);
    window.dispatchEvent(touch('touchend', 0, 0));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores a sideways swipe, and does nothing in a browser tab', async () => {
    const fixture = await render(true);
    pull(60, 200);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pull')).toBeNull();
    fixture.destroy();
    TestBed.resetTestingModule();

    const browser = await render(false);
    pull(300);
    browser.detectChanges();
    expect(browser.nativeElement.querySelector('.pull')).toBeNull();
  });
});
