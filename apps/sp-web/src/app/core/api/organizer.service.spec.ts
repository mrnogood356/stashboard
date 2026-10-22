import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrganizerApiService } from './organizer.service';

describe('OrganizerApiService', () => {
  let service: OrganizerApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(OrganizerApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('lists unmatched scenes with a trimmed search, sort and scope, and leaves blanks out', () => {
    service.unmatched(2, { q: '  holiday  ', sort: 'title', scope: 'all' }).subscribe();
    service.unmatched(1, { q: '   ' }).subscribe();

    const [withOptions, plain] = http.match(
      (request) => request.url === '/api/organizer/unmatched',
    );
    expect(withOptions.request.params.get('page')).toBe('2');
    expect(withOptions.request.params.get('q')).toBe('holiday');
    expect(withOptions.request.params.get('sort')).toBe('title');
    expect(withOptions.request.params.get('scope')).toBe('all');
    expect(plain.request.params.keys()).toEqual(['page']);
  });

  it('only sends a search query to lookup when one is given', () => {
    service.lookup(['1', '2']).subscribe();
    service.lookup(['3'], 'custom').subscribe();

    const [auto, custom] = http.match('/api/organizer/lookup');
    expect(auto.request.method).toBe('POST');
    expect(auto.request.body).toEqual({ sceneIds: ['1', '2'] });
    expect(custom.request.body).toEqual({ sceneIds: ['3'], query: 'custom' });
  });

  it('applies a match for one scene', () => {
    service.apply('7', 'stashdb-abc').subscribe();
    const request = http.expectOne('/api/organizer/apply');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ sceneId: '7', candidateId: 'stashdb-abc' });
  });

  it('saves settings with PUT', () => {
    service.update({ renamePattern: '{studio}/{title}', tpdbApiKey: 'k' }).subscribe();
    const request = http.expectOne('/api/organizer');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ renamePattern: '{studio}/{title}', tpdbApiKey: 'k' });
  });

  it('previews with the pattern being edited, or the saved one', () => {
    service.preview('{title}').subscribe();
    service.preview().subscribe();
    const [edited, saved] = http.match('/api/organizer/rename/preview');
    expect(edited.request.body).toEqual({ pattern: '{title}' });
    expect(saved.request.body).toEqual({});
  });

  it('renames only the scenes it is given', () => {
    service.rename(['1', '5']).subscribe();
    const request = http.expectOne('/api/organizer/rename');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ sceneIds: ['1', '5'] });
  });

  it('posts the file-moving actions to their own endpoints', () => {
    service.renameAll().subscribe();
    service.undo().subscribe();
    service.moveUnmatched().subscribe();
    service.matchAll().subscribe();
    service.cleanEmptyFolders().subscribe();
    service.relocateWhisparr().subscribe();
    service.repairWhisparr().subscribe();
    service.sendAllToWhisparr().subscribe();

    for (const url of [
      '/api/organizer/rename-all',
      '/api/organizer/undo',
      '/api/organizer/unmatched/move',
      '/api/organizer/match-all',
      '/api/organizer/folders/clean',
      '/api/organizer/whisparr/relocate',
      '/api/organizer/whisparr/repair',
      '/api/organizer/whisparr/send-all',
    ]) {
      const request = http.expectOne({ method: 'POST', url });
      expect(request.request.body).toEqual({});
    }
  });

  it('escapes the StashDB id when marking the same scene', () => {
    service.markSameScene('a/b?c').subscribe();
    http.expectOne({ method: 'POST', url: '/api/organizer/waiting/a%2Fb%3Fc/same-scene' });
  });

  it('scrapes one scene', () => {
    service.scrape('42').subscribe();
    expect(http.expectOne('/api/organizer/scrape').request.body).toEqual({ sceneId: '42' });
  });
});
