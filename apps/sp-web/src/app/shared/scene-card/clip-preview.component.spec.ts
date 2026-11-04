import { inViewPreviews } from './in-view-previews';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClipPreviewComponent, resetFailedClips } from './clip-preview.component';

@Component({
  template: `<app-clip-preview [clip]="clip"><img src="/shot.jpg" alt="" /></app-clip-preview>`,
  imports: [ClipPreviewComponent],
})
class HostComponent {
  clip: string | null = '/api/playback/scenes/1/markers/2/preview';
}

function pointer(type: string, pointerType: string): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('ClipPreviewComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFailedClips();
    inViewPreviews.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function render(clip: string | null = '/api/playback/scenes/1/markers/2/preview') {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.clip = clip;
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('app-clip-preview') as HTMLElement;
    const video = () =>
      fixture.nativeElement.querySelector('video.clip') as HTMLVideoElement | null;
    return { fixture, host, video };
  }

  it('plays the clip over the picture on hover, and stops on leave', () => {
    const { fixture, host, video } = render();
    expect(fixture.nativeElement.querySelector('img')).toBeTruthy();

    host.dispatchEvent(pointer('pointerenter', 'mouse'));
    vi.advanceTimersByTime(350);
    fixture.detectChanges();
    expect(video()?.getAttribute('src')).toBe('/api/playback/scenes/1/markers/2/preview');

    host.dispatchEvent(pointer('pointerleave', 'mouse'));
    fixture.detectChanges();
    expect(video()).toBeNull();
  });

  it('gives up on a clip that won’t play, and does nothing without one', () => {
    const first = render();
    first.host.dispatchEvent(pointer('pointerenter', 'mouse'));
    vi.advanceTimersByTime(350);
    first.fixture.detectChanges();
    first.video()?.dispatchEvent(new Event('error'));
    first.fixture.detectChanges();
    expect(first.video()).toBeNull();
    first.host.dispatchEvent(pointer('pointerenter', 'mouse'));
    vi.advanceTimersByTime(350);
    first.fixture.detectChanges();
    expect(first.video()).toBeNull();
    TestBed.resetTestingModule();

    const none = render(null);
    none.host.dispatchEvent(pointer('pointerenter', 'mouse'));
    vi.advanceTimersByTime(350);
    none.fixture.detectChanges();
    expect(none.video()).toBeNull();
  });

  it('plays on a touch screen while in view', () => {
    let callback!: IntersectionObserverCallback;
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({ matches: query.includes('hover: none') }) as MediaQueryList,
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0);
      return 1;
    });
    const { fixture, host, video } = render();
    callback(
      [
        {
          target: host,
          isIntersecting: true,
          intersectionRatio: 1,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    fixture.detectChanges();
    expect(video()).toBeTruthy();
    fixture.destroy();
  });
});
