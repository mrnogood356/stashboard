import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router, provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { NavigationHistoryService, pageLabel } from './navigation-history.service';

@Component({ template: '' })
class BlankComponent {}

describe('NavigationHistoryService', () => {
  it('remembers the page before this one', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: BlankComponent }])],
    });
    const router = TestBed.inject(Router);
    const history = TestBed.inject(NavigationHistoryService);
    history.start();

    await router.navigateByUrl('/acquisition');
    expect(history.previous()).toBeNull();
    await router.navigateByUrl('/performers');
    expect(history.previous()).toBe('/acquisition');
  });

  it('knows the page behind this one in the browser, after replaced addresses and Back and Forward', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // A history that sends Back and Forward on to the router, like a browser's.
      providers: [
        provideRouter([{ path: '**', component: BlankComponent }]),
        provideLocationMocks(),
      ],
    });
    const router = TestBed.inject(Router);
    const history = TestBed.inject(NavigationHistoryService);
    const location = TestBed.inject(Location);
    // As the app does on start: from now on the router follows Back and Forward.
    router.initialNavigation();
    const popped = () =>
      new Promise<void>((resolve) => {
        const sub = router.events.subscribe((event) => {
          if (event instanceof NavigationEnd) {
            sub.unsubscribe();
            resolve();
          }
        });
      });
    history.start();

    await router.navigateByUrl('/search?q=anna');
    await router.navigateByUrl('/library/scene/1');
    expect(history.behind()).toBe('/search?q=anna');

    // Back to the search, and new words typed into it (the address is replaced).
    let done = popped();
    location.back();
    await done;
    await router.navigateByUrl('/search?q=beth', { replaceUrl: true });
    // Forward to the scene: what's behind it now is the "beth" search.
    done = popped();
    location.forward();
    await done;
    expect(router.url).toBe('/library/scene/1');
    expect(history.behind()).toBe('/search?q=beth');

    // From the scene, a new search, then Back to the scene.
    await router.navigateByUrl('/search');
    await router.navigateByUrl('/search?q=anna', { replaceUrl: true });
    done = popped();
    location.back();
    await done;
    expect(router.url).toBe('/library/scene/1');
    // The page the router just left was "anna", but the browser's Back leads to "beth".
    expect(history.previous()).toBe('/search?q=anna');
    expect(history.behind()).toBe('/search?q=beth');
  });

  it('names pages for the back button', () => {
    expect(pageLabel(null)).toBe('Home');
    expect(pageLabel('/acquisition?lifecycle=FAILED')).toBe('Wanted');
    expect(pageLabel('/settings/indexing')).toBe('Indexing');
    expect(pageLabel('/scene/abc?returnTo=%2Fscenes')).toBe('Scene');
    expect(pageLabel('/library/performer/7')).toBe('Performer');
    expect(pageLabel('/somewhere/else')).toBe('Back');
  });
});
