import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationsService } from './integrations.service';
import { UpdateIntegrationPayload } from './integrations.types';

describe('IntegrationsService', () => {
  let service: IntegrationsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(IntegrationsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('saves and tests an integration with the form values', () => {
    const payload: UpdateIntegrationPayload = {
      name: 'Stash',
      baseUrl: 'http://stash:9999',
      apiKey: 'secret',
      enabled: true,
    };

    service.updateIntegration('STASH', payload).subscribe();
    service.testIntegration('STASH', payload).subscribe();

    const save = http.expectOne('/api/integrations/STASH');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual(payload);
    const test = http.expectOne('/api/integrations/STASH/test');
    expect(test.request.method).toBe('POST');
    expect(test.request.body).toEqual(payload);
  });

  it('resets one integration, or all of them', () => {
    service.resetIntegration('WHISPARR').subscribe();
    service.resetAllIntegrations().subscribe();

    http.expectOne({ method: 'DELETE', url: '/api/integrations/WHISPARR' });
    http.expectOne({ method: 'DELETE', url: '/api/integrations' });
  });
});
