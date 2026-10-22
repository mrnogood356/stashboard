import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { SettingsPlaybackPageComponent } from './settings-playback-page.component';

const API = '/api/playback/settings';

describe('SettingsPlaybackPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function render(saved = { enabled: true, feedEnabled: true, previewsEnabled: true }) {
    await TestBed.configureTestingModule({
      imports: [SettingsPlaybackPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SettingsPlaybackPageComponent);
    fixture.detectChanges();
    http.expectOne(API).flush({ ...saved, updatedAt: null });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = (id: string) =>
      el.querySelector(`[data-testid="playback-${id}"]`) as HTMLInputElement;
    return { fixture, http, el, input };
  }

  it('explains the switches and shows them on by default', async () => {
    const { el, input } = await render();
    expect(el.textContent).toContain('In-app playback');
    expect(el.textContent).toContain('Swipe feed');
    expect(el.textContent).toContain('Previews on scene cards');
    expect(input('enabled').checked).toBe(true);
    expect(input('feed').checked).toBe(true);
    expect(input('feed').disabled).toBe(false);
    expect(input('previews').checked).toBe(true);
  });

  it('saves the main switch at once and greys out the others', async () => {
    const { fixture, http, el, input } = await render();
    const service = TestBed.inject(PlaybackSettingsService);

    input('enabled').checked = false;
    input('enabled').dispatchEvent(new Event('change'));
    const request = http.expectOne(API);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      enabled: false,
      feedEnabled: true,
      previewsEnabled: true,
    });
    request.flush({ ...request.request.body, updatedAt: '2026-10-22T10:00:00.000Z' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(service.playbackEnabled()).toBe(false);
    expect(input('feed').disabled).toBe(true);
    expect(input('feed').checked).toBe(false);
    expect(input('previews').disabled).toBe(true);
    expect(el.textContent).toContain('Saved. Applied right away.');
    expect(el.textContent).toContain('Playback is off.');
  });

  it('puts a switch back and says why when saving fails', async () => {
    const { fixture, http, el, input } = await render();

    input('feed').checked = false;
    input('feed').dispatchEvent(new Event('change'));
    http
      .expectOne(API)
      .flush({ message: 'Database is down.' }, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input('feed').checked).toBe(true);
    expect(el.textContent).toContain('Database is down.');
  });
});
