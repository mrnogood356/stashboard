import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalLibraryService } from './local-library.service';

describe('LocalLibraryService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('cuts searches to the length the API accepts, so a long one still gets results', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const service = TestBed.inject(LocalLibraryService);
    const http = TestBed.inject(HttpTestingController);

    service.search(`  ${'a'.repeat(150)}  `).subscribe();
    service.searchTags('b'.repeat(150)).subscribe();

    const search = http.expectOne((request) => request.url === '/api/local/search');
    const tags = http.expectOne((request) => request.url === '/api/local/tags');
    expect(search.request.params.get('query')).toBe('a'.repeat(100));
    expect(tags.request.params.get('query')).toBe('b'.repeat(100));
    http.verify({ ignoreCancelled: true });
  });
  it('deletes a scene, saying whether to remove the file from disk too', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const service = TestBed.inject(LocalLibraryService);
    const http = TestBed.inject(HttpTestingController);

    service.deleteScene('12', true).subscribe();
    service.deleteScene('a/b', false).subscribe();

    const [withFile, stashOnly] = http.match((request) => request.method === 'DELETE');
    expect(withFile.request.url).toBe('/api/local/scenes/12');
    expect(withFile.request.params.get('deleteFile')).toBe('true');
    expect(stashOnly.request.url).toBe('/api/local/scenes/a%2Fb');
    expect(stashOnly.request.params.get('deleteFile')).toBe('false');
    http.verify();
  });

  it('saves scene changes, markers and jobs to the right places', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const service = TestBed.inject(LocalLibraryService);
    const http = TestBed.inject(HttpTestingController);

    service.updateScene('5', { organized: true }).subscribe();
    service.setWatched('5', false).subscribe();
    service.deleteMarker('5', 'm 1').subscribe();
    service.identify(['1', '2']).subscribe();
    service.startJob('auto-tag').subscribe();
    service.stopJob('7').subscribe();

    const update = http.expectOne({ method: 'PATCH', url: '/api/local/scenes/5' });
    expect(update.request.body).toEqual({ organized: true });
    const watched = http.expectOne({ method: 'POST', url: '/api/local/scenes/5/watched' });
    expect(watched.request.body).toEqual({ watched: false });
    http.expectOne({ method: 'DELETE', url: '/api/local/scenes/5/markers/m%201' });
    const identify = http.expectOne({ method: 'POST', url: '/api/local/identify' });
    expect(identify.request.body).toEqual({ sceneIds: ['1', '2'] });
    http.expectOne({ method: 'POST', url: '/api/local/jobs/auto-tag' });
    http.expectOne({ method: 'DELETE', url: '/api/local/jobs/7' });
    http.verify();
  });
});
