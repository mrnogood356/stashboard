import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  SceneCardBodyDirective,
  SceneCardMediaFooterDirective,
  SceneCardPlaceholderDirective,
  SceneCardShellComponent,
  SceneCardShellItem,
  SceneCardShellLink,
  SceneCardTopRightDirective,
  resetUnavailablePreviews,
} from './scene-card-shell.component';

@Component({
  template: `
    <app-scene-card-shell
      [item]="item"
      [variant]="variant"
      [primaryLink]="primaryLink"
      [studioBadgeLink]="studioBadgeLink"
    >
      <div sceneCardPlaceholder class="placeholder-copy">Missing artwork</div>
      <span sceneCardTopRight class="top-right">Top Flag</span>
      <div sceneCardMediaFooter class="media-footer-test">Footer copy</div>
      <div sceneCardBody class="body-test">Body copy</div>
    </app-scene-card-shell>
  `,
  imports: [
    SceneCardShellComponent,
    SceneCardTopRightDirective,
    SceneCardMediaFooterDirective,
    SceneCardBodyDirective,
    SceneCardPlaceholderDirective,
  ],
})
class SceneCardShellHostComponent {
  item: SceneCardShellItem = {
    title: 'Shared Shell Scene',
    imageUrl: null,
    cardImageUrl: null,
    studioId: 'studio-1',
    studio: 'Studio One',
    studioImageUrl: 'http://cdn.local/studio.jpg',
  };
  variant: 'default' | 'rail' = 'default';
  primaryLink: SceneCardShellLink = {
    kind: 'router',
    commands: ['/scene', 'scene-1'],
    queryParams: { returnTo: '/library' },
    ariaLabel: 'Open scene details for Shared Shell Scene',
  };
  studioBadgeLink: SceneCardShellLink = {
    kind: 'router',
    commands: ['/library'],
    queryParams: { studios: 'studio-1', studioNames: 'Studio One' },
    ariaLabel: 'Filter library by studio Studio One',
  };
}

@Component({
  template: `<app-scene-card-shell [item]="item" [previewUrl]="previewUrl" />`,
  imports: [SceneCardShellComponent],
})
class PreviewHostComponent {
  item: SceneCardShellItem = {
    title: 'Preview Scene',
    imageUrl: 'http://cdn.local/scene.jpg',
    cardImageUrl: null,
    studioId: null,
    studio: null,
    studioImageUrl: null,
  };
  previewUrl: string | null = '/api/playback/scenes/7/preview';
}

function pointer(type: string, pointerType: string): Event {
  const event = new Event(type, { bubbles: type !== 'pointerenter' && type !== 'pointerleave' });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('SceneCardShellComponent previews', () => {
  let playSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetUnavailablePreviews();
    playSpy = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      playSpy as unknown as () => Promise<void>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function render(previewUrl: string | null = '/api/playback/scenes/7/preview') {
    await TestBed.configureTestingModule({
      imports: [PreviewHostComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(PreviewHostComponent);
    fixture.componentInstance.previewUrl = previewUrl;
    fixture.detectChanges();
    const media = fixture.nativeElement.querySelector('.media') as HTMLElement;
    const video = () =>
      fixture.nativeElement.querySelector('video.preview-video') as HTMLVideoElement | null;
    const hover = (pointerType = 'mouse') => {
      media.dispatchEvent(pointer('pointerenter', pointerType));
      vi.advanceTimersByTime(450);
      fixture.detectChanges();
    };
    return { fixture, media, video, hover };
  }

  it('mutes the clip itself and starts it, so the first hover plays', async () => {
    const { video, hover } = await render();

    hover();

    const element = video();
    expect(element).toBeTruthy();
    // The muted attribute alone doesn't mute a <video> made by script.
    expect(element?.muted).toBe(true);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the picture in front until the clip is playing', async () => {
    const { fixture, video, hover } = await render();

    hover();
    expect(video()?.classList.contains('is-playing')).toBe(false);

    video()?.dispatchEvent(new Event('playing'));
    fixture.detectChanges();
    expect(video()?.classList.contains('is-playing')).toBe(true);
  });

  it('stops when the pointer leaves', async () => {
    const { fixture, media, video, hover } = await render();

    hover();
    media.dispatchEvent(pointer('pointerleave', 'mouse'));
    fixture.detectChanges();

    expect(video()).toBeNull();
  });

  it('starts from a pointer move when the enter was missed', async () => {
    const { fixture, media, video } = await render();

    media.dispatchEvent(pointer('pointermove', 'mouse'));
    vi.advanceTimersByTime(450);
    fixture.detectChanges();

    expect(video()).toBeTruthy();
  });

  it('remembers a scene with no preview and does not try again', async () => {
    const { fixture, media, video, hover } = await render();

    hover();
    video()?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(video()).toBeNull();

    media.dispatchEvent(pointer('pointerleave', 'mouse'));
    hover();
    expect(video()).toBeNull();
  });

  it('ignores touch hover, and has no preview without a clip', async () => {
    const touch = await render();
    touch.hover('touch');
    expect(touch.video()).toBeNull();
    TestBed.resetTestingModule();

    const none = await render(null);
    none.hover();
    expect(none.video()).toBeNull();
  });
});

describe('SceneCardShellComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the shared media shell, placeholder, and projected slots', async () => {
    await TestBed.configureTestingModule({
      imports: [SceneCardShellHostComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(SceneCardShellHostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement.querySelector('app-scene-card-shell') as HTMLElement | null;
    const primaryLink = fixture.nativeElement.querySelector(
      '.media-link-stretch',
    ) as HTMLAnchorElement | null;
    const studioBadgeLink = fixture.nativeElement.querySelector(
      '.studio-badge-link',
    ) as HTMLAnchorElement | null;

    expect(host?.classList.contains('scene-card-shell-variant-default')).toBe(true);
    expect(primaryLink?.getAttribute('href')).toContain('/scene/scene-1');
    expect(primaryLink?.getAttribute('href')).toContain('returnTo=%2Flibrary');
    // The studio is shown as text under the title by the scene card, not on the picture.
    expect(studioBadgeLink).toBeNull();
    expect(fixture.nativeElement.querySelector('.placeholder-copy')?.textContent).toContain(
      'Missing artwork',
    );
    expect(fixture.nativeElement.querySelector('.top-right')?.textContent).toContain('Top Flag');
    // Title and details sit under the picture.
    expect(
      fixture.nativeElement.querySelector('.card-body > .media-footer-test')?.textContent,
    ).toContain('Footer copy');
    expect(fixture.nativeElement.querySelector('.media .media-footer-test')).toBeNull();
    expect(fixture.nativeElement.querySelector('.body-test')?.textContent).toContain('Body copy');
  });
});
