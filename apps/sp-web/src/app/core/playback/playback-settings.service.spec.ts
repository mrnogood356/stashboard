import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaybackSettingsService } from './playback-settings.service';

describe('PlaybackSettingsService', () => {
  let service: PlaybackSettingsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(PlaybackSettingsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('has everything on until the server answers', () => {
    expect(service.playbackEnabled()).toBe(true);
    expect(service.feedEnabled()).toBe(true);
    expect(service.previewsEnabled()).toBe(true);
    expect(service.loaded()).toBe(false);
  });

  it('asks the server once and keeps the answer', async () => {
    const first = service.ensureLoaded();
    const second = service.ensureLoaded();
    http.expectOne('/api/playback/settings').flush({
      enabled: true,
      feedEnabled: false,
      previewsEnabled: true,
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
    await Promise.all([first, second]);
    await service.ensureLoaded();
    http.expectNone('/api/playback/settings');

    expect(service.loaded()).toBe(true);
    expect(service.playbackEnabled()).toBe(true);
    expect(service.feedEnabled()).toBe(false);
    expect(service.previewsEnabled()).toBe(true);
  });

  it('turns the feed and previews off with the main switch', async () => {
    const loading = service.ensureLoaded();
    http.expectOne('/api/playback/settings').flush({
      enabled: false,
      feedEnabled: true,
      previewsEnabled: true,
      updatedAt: null,
    });
    await loading;
    expect(service.playbackEnabled()).toBe(false);
    expect(service.feedEnabled()).toBe(false);
    expect(service.previewsEnabled()).toBe(false);
  });

  it('keeps everything on after a failed read, and tries again next time', async () => {
    const loading = service.ensureLoaded();
    http
      .expectOne('/api/playback/settings')
      .flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await loading;
    expect(service.loaded()).toBe(false);
    expect(service.playbackEnabled()).toBe(true);

    const retry = service.ensureLoaded();
    http.expectOne('/api/playback/settings').flush({
      enabled: false,
      feedEnabled: true,
      previewsEnabled: true,
      updatedAt: null,
    });
    await retry;
    expect(service.playbackEnabled()).toBe(false);
  });

  it('saves and applies the new settings straight away', async () => {
    const saving = service.save({ enabled: false, feedEnabled: true, previewsEnabled: false });
    const request = http.expectOne('/api/playback/settings');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      enabled: false,
      feedEnabled: true,
      previewsEnabled: false,
    });
    request.flush({ ...request.request.body, updatedAt: '2026-10-22T10:00:00.000Z' });
    await saving;
    expect(service.playbackEnabled()).toBe(false);
    expect(service.loaded()).toBe(true);
  });
});
