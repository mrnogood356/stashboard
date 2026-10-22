import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationFormFieldsComponent } from '../integration-form-fields/integration-form-fields.component';
import { buildIntegrationPayload, createIntegrationForm } from './integration-repair.utils';

describe('integration form', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the saved key unless asked to remove it, and a new key wins', () => {
    const form = createIntegrationForm();
    form.patchValue({ name: 'Stash', baseUrl: 'http://stash:9999' });
    expect(buildIntegrationPayload('STASH', form)).toEqual({
      enabled: true,
      name: 'Stash',
      baseUrl: 'http://stash:9999',
    });

    form.patchValue({ clearApiKey: true });
    expect(buildIntegrationPayload('STASH', form)).toMatchObject({ clearApiKey: true });

    form.patchValue({ apiKey: 'new-key' });
    const payload = buildIntegrationPayload('STASH', form);
    expect(payload.apiKey).toBe('new-key');
    expect(payload.clearApiKey).toBeUndefined();
  });

  it('offers to remove the key only when one is saved', async () => {
    await TestBed.configureTestingModule({
      imports: [IntegrationFormFieldsComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(IntegrationFormFieldsComponent);
    const form = createIntegrationForm();
    fixture.componentInstance.form = form;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Remove the saved key');

    fixture.componentInstance.hasStoredApiKey = true;
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.click();

    expect(form.controls.clearApiKey.value).toBe(true);
  });
});
