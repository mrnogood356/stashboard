import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { CatalogBrowseService } from '../catalog/catalog-browse.service';
import { PrefetchService, prefetchInterceptor, prefetchUrlFor } from './prefetch.service';

describe('PrefetchService', () => {
  let provider: string | null;
  let http: HttpClient;
  let backend: HttpTestingController;
  let prefetch: PrefetchService;

  beforeEach(() => {
    provider = null;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([prefetchInterceptor])),
        provideHttpClientTesting(),
        { provide: CatalogBrowseService, useValue: { providerForRequest: () => provider } },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    prefetch = TestBed.inject(PrefetchService);
  });

  afterEach(() => backend.verify());

  it('knows the data a scene page asks for first', () => {
    expect(prefetchUrlFor('/scene/abc-1')).toBe('/api/scenes/abc-1');
    expect(prefetchUrlFor('/library/scene/42')).toBe('/api/playback/scenes/42/details');
    expect(prefetchUrlFor('/scenes')).toBeNull();
    expect(prefetchUrlFor('/scene/a/b')).toBeNull();
  });

  it('answers the page from the early request, once, without asking again', async () => {
    prefetch.prefetch('/api/scenes/1');
    backend.expectOne('/api/scenes/1').flush({ id: '1', title: 'Early' });

    await expect(firstValueFrom(http.get('/api/scenes/1'))).resolves.toEqual({
      id: '1',
      title: 'Early',
    });

    // Used up: the next visit asks the server.
    const again = firstValueFrom(http.get('/api/scenes/1'));
    backend.expectOne('/api/scenes/1').flush({ id: '1', title: 'Fresh' });
    await expect(again).resolves.toEqual({ id: '1', title: 'Fresh' });
  });

  it('shares a request that is still on its way', async () => {
    prefetch.prefetch('/api/scenes/2');
    const page = firstValueFrom(http.get('/api/scenes/2'));
    backend.expectOne('/api/scenes/2').flush({ id: '2' });
    await expect(page).resolves.toEqual({ id: '2' });
  });

  it('asks again when the early request failed', async () => {
    prefetch.prefetch('/api/scenes/3');
    backend.expectOne('/api/scenes/3').flush('down', { status: 503, statusText: 'Down' });

    const page = firstValueFrom(http.get('/api/scenes/3'));
    backend.expectOne('/api/scenes/3').flush({ id: '3' });
    await expect(page).resolves.toEqual({ id: '3' });
  });

  it('doesn’t use an answer from a minute ago, or from the other catalog', async () => {
    prefetch.prefetch('/api/scenes/4', Date.now() - 60_000);
    backend.expectOne('/api/scenes/4').flush({ id: '4', title: 'Old' });
    const stale = firstValueFrom(http.get('/api/scenes/4'));
    backend.expectOne('/api/scenes/4').flush({ id: '4', title: 'New' });
    await expect(stale).resolves.toEqual({ id: '4', title: 'New' });

    prefetch.prefetch('/api/scenes/5');
    backend.expectOne('/api/scenes/5').flush({ id: '5', from: 'stashdb' });
    provider = 'FANSDB';
    const other = firstValueFrom(http.get('/api/scenes/5'));
    backend.expectOne('/api/scenes/5').flush({ id: '5', from: 'fansdb' });
    await expect(other).resolves.toEqual({ id: '5', from: 'fansdb' });
  });

  it('starts when you point at a scene link', () => {
    prefetch.start();
    const link = document.createElement('a');
    link.href = '/library/scene/77';
    const inner = document.createElement('span');
    link.appendChild(inner);
    document.body.appendChild(link);

    inner.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));

    backend.expectOne('/api/playback/scenes/77/details').flush({ id: '77' });
    link.remove();
  });
});
