import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Component } from '@angular/core';
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

  it('names pages for the back button', () => {
    expect(pageLabel(null)).toBe('Home');
    expect(pageLabel('/acquisition?lifecycle=FAILED')).toBe('Requests');
    expect(pageLabel('/settings/indexing')).toBe('Indexing');
    expect(pageLabel('/scene/abc?returnTo=%2Fscenes')).toBe('Scene');
    expect(pageLabel('/library/performer/7')).toBe('Performer');
    expect(pageLabel('/somewhere/else')).toBe('Back');
  });
});
