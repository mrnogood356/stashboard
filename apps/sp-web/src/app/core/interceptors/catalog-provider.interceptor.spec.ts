import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogBrowseService } from '../catalog/catalog-browse.service';
import { catalogProviderInterceptor } from './catalog-provider.interceptor';

@Component({ template: '' })
class BlankComponent {}

describe('catalogProviderInterceptor', () => {
  let http: HttpClient;
  let httpTesting: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    try {
      localStorage.setItem('stashboard.browseProvider', 'FANSDB');
    } catch {
      // ignore
    }
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'home', component: BlankComponent },
          { path: 'scenes', component: BlankComponent },
          { path: 'scene/:id', component: BlankComponent },
        ]),
        provideHttpClient(withInterceptors([catalogProviderInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpTesting = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);

    const browse = TestBed.inject(CatalogBrowseService);
    browse.ensureLoaded();
    httpTesting.expectOne('/api/catalog/providers').flush({
      instance: 'STASHDB',
      available: [
        { key: 'STASHDB', label: 'StashDB', browseOnly: false },
        { key: 'FANSDB', label: 'FansDB', browseOnly: true },
      ],
    });
  });

  afterEach(() => {
    httpTesting.verify();
    TestBed.resetTestingModule();
    try {
      localStorage.removeItem('stashboard.browseProvider');
    } catch {
      // ignore
    }
  });

  function providerHeaderFor(url: string): string | null {
    http.get(url).subscribe();
    const request = httpTesting.expectOne(url);
    const header = request.request.headers.get('X-Catalog-Provider');
    request.flush({});
    return header;
  }

  it('uses the chosen provider on browse lists and keeps it on scenes opened from there', async () => {
    await router.navigateByUrl('/scenes');
    expect(providerHeaderFor('/api/scenes')).toBe('FANSDB');

    await router.navigateByUrl('/scene/abc');
    expect(providerHeaderFor('/api/scenes/abc')).toBe('FANSDB');
  });

  it('never sends it from Home, or for scenes opened from Home', async () => {
    await router.navigateByUrl('/home');
    expect(providerHeaderFor('/api/discover')).toBeNull();

    await router.navigateByUrl('/scene/abc');
    expect(providerHeaderFor('/api/scenes/abc')).toBeNull();
  });

  it('never sends it with request submissions', async () => {
    await router.navigateByUrl('/scenes');
    expect(providerHeaderFor('/api/requests/abc')).toBeNull();
  });

  it('honours an explicit provider in the link', async () => {
    await router.navigateByUrl('/home');
    await router.navigateByUrl('/scene/abc?provider=FANSDB');
    expect(providerHeaderFor('/api/scenes/abc')).toBe('FANSDB');
  });
});
