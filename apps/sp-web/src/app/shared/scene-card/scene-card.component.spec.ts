import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { SceneRequestContext } from '../../core/api/discover.types';
import { of } from 'rxjs';
import { ReleasesApiService } from '../../core/api/releases.service';
import { CatalogBrowseService } from '../../core/catalog/catalog-browse.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { ReleaseSearchService } from '../../core/releases/release-search.service';
import { SceneCardShellComponent } from './scene-card-shell.component';
import { SceneCardComponent, SceneCardItem } from './scene-card.component';

function buildSceneCardItem(overrides: Partial<SceneCardItem> = {}): SceneCardItem {
  return {
    id: 'scene-1',
    title: 'Scene Title',
    imageUrl: 'http://cdn.local/image.jpg',
    cardImageUrl: 'http://cdn.local/card.jpg',
    studioId: 'studio-1',
    studio: 'Studio One',
    studioImageUrl: 'http://cdn.local/studio.jpg',
    releaseDate: '2026-03-28',
    status: { state: 'NOT_REQUESTED' },
    ...overrides,
  };
}

describe('SceneCardComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function renderCard() {
    await TestBed.configureTestingModule({
      imports: [SceneCardComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(SceneCardComponent);

    return { fixture, component: fixture.componentInstance };
  }

  it('offers Find downloads on a FansDB card when Prowlarr is set up', async () => {
    await TestBed.configureTestingModule({
      imports: [SceneCardComponent],
      providers: [
        provideRouter([]),
        { provide: CatalogBrowseService, useValue: { providerForRequest: () => 'FANSDB' } },
        {
          provide: ReleasesApiService,
          useValue: { prowlarrStatus: () => of({ prowlarr: { configured: true } }) },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SceneCardComponent);
    fixture.componentInstance.item = buildSceneCardItem();
    fixture.detectChanges();
    fixture.detectChanges();

    const find = fixture.nativeElement.querySelector(
      '[aria-label="Find downloads for Scene Title"]',
    ) as HTMLButtonElement;
    expect(find).not.toBeNull();
    find.click();

    expect(TestBed.inject(ReleaseSearchService).target()).toEqual({
      stashId: 'scene-1',
      title: 'Scene Title',
      source: 'prowlarr',
      provider: 'FANSDB',
    });
  });

  it('lets you pick a release for a requested scene right from the card', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem({ status: { state: 'REQUESTED' } });
    fixture.detectChanges();

    const search = fixture.nativeElement.querySelector('.search-cta') as HTMLButtonElement;
    expect(search?.textContent).toContain('Search');
    // Search takes the footer, so the status stays on the picture.
    expect(fixture.nativeElement.querySelector('.footer-status-badge')).toBeNull();
    expect(fixture.nativeElement.querySelector('.status-icon')).not.toBeNull();
    search.click();

    expect(TestBed.inject(ReleaseSearchService).target()).toEqual({
      stashId: 'scene-1',
      title: 'Scene Title',
      source: 'whisparr',
    });
  });

  it('offers no release search for a scene already in the library', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem({ status: { state: 'AVAILABLE' } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.search-cta')).toBeNull();
  });

  it('renders the canonical discovery card with an internal scene link, studio filter badge, and request event', async () => {
    const { fixture, component } = await renderCard();
    const emitted: SceneRequestContext[] = [];
    component.item = buildSceneCardItem();
    component.requestable = true;
    component.sceneQueryParams = { returnTo: '/scenes' };
    component.studioBadgeRoute = 'scenes';
    component.request.subscribe((item) => emitted.push(item));

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const sceneLink = fixture.nativeElement.querySelector(
      '.media-link-stretch',
    ) as HTMLAnchorElement | null;
    const studioBadgeLink = fixture.nativeElement.querySelector(
      '.studio-badge-link',
    ) as HTMLAnchorElement | null;
    const requestButton = fixture.nativeElement.querySelector(
      '.request-cta',
    ) as HTMLButtonElement | null;

    expect(sceneLink?.getAttribute('href')).toContain('/scene/scene-1');
    expect(sceneLink?.getAttribute('href')).toContain('returnTo=%2Fscenes');
    expect(studioBadgeLink?.getAttribute('href')).toContain('/scenes');
    expect(studioBadgeLink?.getAttribute('href')).toContain('studios=studio-1');
    expect(studioBadgeLink?.getAttribute('href')).toContain('studioNames=Studio%20One');
    expect(requestButton?.textContent?.trim()).toBe('Request');

    requestButton?.click();

    expect(emitted).toEqual([
      {
        id: 'scene-1',
        title: 'Scene Title',
        imageUrl: 'http://cdn.local/image.jpg',
      },
    ]);
  });

  it('links the studio name to the studio page without following the card link', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem();
    component.studioBadgeRoute = 'studio';
    component.studioQueryParams = { returnTo: '/scenes?sort=DATE' };

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const studioLink = fixture.nativeElement.querySelector(
      '.studio-badge-link',
    ) as HTMLAnchorElement | null;
    expect(studioLink?.textContent?.trim()).toBe('Studio One');
    expect(studioLink?.getAttribute('href')).toBe(
      '/studio/studio-1?returnTo=%2Fscenes%3Fsort%3DDATE',
    );
    expect(studioLink?.getAttribute('aria-label')).toBe('View scenes from Studio One');

    const navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const clickedCard = vi.fn();
    fixture.nativeElement.addEventListener('click', clickedCard);
    studioLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clickedCard).not.toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it('renders status-driven external cards without the request CTA, the status said once', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem({
      status: { state: 'AVAILABLE' },
      studioImageUrl: null,
    });
    component.requestable = false;
    component.variant = 'rail';
    component.primaryLinkMode = 'external';
    component.externalHref = 'http://stash.local/scenes/scene-1';

    fixture.detectChanges();

    const sceneLink = fixture.nativeElement.querySelector(
      '.media-link-stretch',
    ) as HTMLAnchorElement | null;
    const requestButton = fixture.nativeElement.querySelector('.request-cta');
    const footerStatusBadge = fixture.nativeElement.querySelector('.footer-status-badge');
    const statusIcon = fixture.nativeElement.querySelector('.status-icon');
    const host = fixture.nativeElement as HTMLElement;

    expect(host.classList.contains('scene-card-variant-rail')).toBe(true);
    expect(sceneLink?.getAttribute('href')).toBe('http://stash.local/scenes/scene-1');
    expect(requestButton).toBeNull();
    expect(footerStatusBadge).toBeTruthy();
    // The footer says it in words: no second icon on the picture.
    expect(statusIcon).toBeNull();
  });

  it('supports compact library cards with a scene-details primary link and stash footer action', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem({
      id: 'local-scene-411',
      status: null,
    });
    component.primaryLinkMode = 'scene';
    component.sceneRouteId = 'catalog-scene-411';
    component.sceneQueryParams = { returnTo: '/library' };
    component.studioBadgeRoute = 'library';
    component.topBadges = [{ label: 'Local' }];
    component.footerLinkLabel = 'View in Stash';
    component.footerLink = {
      kind: 'external',
      href: 'http://stash.local/scenes/411',
      ariaLabel: 'View Scene Title in Stash',
    };

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const sceneLink = fixture.nativeElement.querySelector(
      '.media-link-stretch',
    ) as HTMLAnchorElement | null;
    const studioBadgeLink = fixture.nativeElement.querySelector(
      '.studio-badge-link',
    ) as HTMLAnchorElement | null;
    const topBadge = fixture.nativeElement.querySelector('.top-badge') as HTMLElement | null;
    const footerLink = fixture.nativeElement.querySelector(
      '.footer-link',
    ) as HTMLAnchorElement | null;

    expect(sceneLink?.getAttribute('href')).toContain('/scene/catalog-scene-411');
    expect(sceneLink?.getAttribute('href')).toContain('returnTo=%2Flibrary');
    expect(studioBadgeLink?.getAttribute('href')).toContain('/library');
    expect(topBadge?.textContent?.trim()).toBe('Local');
    expect(footerLink?.getAttribute('href')).toBe('http://stash.local/scenes/411');
  });

  it('renders a compact footer badge for local-only library cards', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem({
      id: 'local-only-512',
      status: null,
      studioImageUrl: null,
    });
    component.primaryLinkMode = 'external';
    component.externalHref = 'http://stash.local/scenes/512';
    component.topBadges = [{ label: 'Local' }];
    component.footerBadgeLabel = 'Local only';

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const sceneLink = fixture.nativeElement.querySelector(
      '.media-link-stretch',
    ) as HTMLAnchorElement | null;
    const footerBadge = fixture.nativeElement.querySelector('.footer-pill') as HTMLElement | null;
    const footerStatusBadge = fixture.nativeElement.querySelector('.footer-status-badge');

    expect(sceneLink?.getAttribute('href')).toBe('http://stash.local/scenes/512');
    expect(footerBadge?.textContent?.trim()).toBe('Local only');
    expect(footerStatusBadge).toBeNull();
  });

  it('closes the ⋯ menu on Escape or a click elsewhere', async () => {
    const { fixture, component } = await renderCard();
    component.item = buildSceneCardItem();
    component.menuActions = [{ id: 'remove', label: 'Remove', icon: 'pi pi-times' }];
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    const trigger = fixture.nativeElement.querySelector('.card-menu-trigger') as HTMLButtonElement;
    const menu = () => fixture.nativeElement.querySelector('.card-menu-list');

    trigger.click();
    fixture.detectChanges();
    expect(menu()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    fixture.detectChanges();
    document.body.click();
    fixture.detectChanges();
    expect(menu()).toBeNull();
    fixture.nativeElement.remove();
  });

  describe('with Settings → Playback', () => {
    async function renderLibraryCard(playback: boolean, previews: boolean) {
      await TestBed.configureTestingModule({
        imports: [SceneCardComponent],
        providers: [
          provideRouter([]),
          {
            provide: PlaybackSettingsService,
            useValue: {
              playbackEnabled: signal(playback),
              previewsEnabled: signal(playback && previews),
            },
          },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(SceneCardComponent);
      fixture.componentInstance.item = buildSceneCardItem({ id: '42' });
      fixture.componentInstance.playSceneId = '42';
      fixture.componentInstance.primaryLinkMode = 'watch';
      fixture.detectChanges();
      const shell = fixture.debugElement.query(By.directive(SceneCardShellComponent))
        .componentInstance as SceneCardShellComponent;
      return { fixture, shell };
    }

    it('shows the Play button and preview clip while playback is on', async () => {
      const { fixture, shell } = await renderLibraryCard(true, true);
      expect(fixture.nativeElement.querySelector('.play-button')).not.toBeNull();
      expect(shell.previewUrl).toBe('/api/playback/scenes/42/preview');
      expect(shell.primaryLink?.ariaLabel).toBe('Play Scene Title');
    });

    it('drops only the preview clip when card previews are off', async () => {
      const { fixture, shell } = await renderLibraryCard(true, false);
      expect(fixture.nativeElement.querySelector('.play-button')).not.toBeNull();
      expect(shell.previewUrl).toBeNull();
    });

    it('hides Play and previews, and opens the library scene, when playback is off', async () => {
      const { fixture, shell } = await renderLibraryCard(false, true);
      expect(fixture.nativeElement.querySelector('.play-button')).toBeNull();
      expect(shell.previewUrl).toBeNull();
      expect(shell.primaryLink).toMatchObject({
        kind: 'router',
        commands: ['/library/scene', '42'],
      });
    });
  });
});
