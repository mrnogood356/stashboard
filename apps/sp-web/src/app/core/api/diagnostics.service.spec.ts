import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagnosticsApiService } from './diagnostics.service';

describe('DiagnosticsApiService', () => {
  let service: DiagnosticsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DiagnosticsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('asks about a catalog scene and a library scene at their own addresses', () => {
    service.catalogScene('a/b').subscribe();
    service.localScene('12').subscribe();

    expect(http.expectOne('/api/scenes/a%2Fb/evidence').request.method).toBe('GET');
    expect(http.expectOne('/api/local/scenes/12/evidence').request.method).toBe('GET');
  });
});
