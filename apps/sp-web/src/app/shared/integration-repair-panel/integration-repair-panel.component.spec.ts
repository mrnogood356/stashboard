import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { IntegrationRepairPanelComponent } from './integration-repair-panel.component';

function form() {
  return new FormGroup({
    name: new FormControl('Stash'),
    baseUrl: new FormControl('http://stash:9999'),
    apiKey: new FormControl(''),
    clearApiKey: new FormControl(false),
    enabled: new FormControl(true),
  });
}

async function render(inputs: Record<string, unknown> = {}) {
  await TestBed.configureTestingModule({
    imports: [IntegrationRepairPanelComponent],
  }).compileComponents();
  const fixture = TestBed.createComponent(IntegrationRepairPanelComponent);
  const values: Record<string, unknown> = {
    label: 'Stash',
    state: 'SAVED',
    summary: 'Your media server.',
    form: form(),
    ...inputs,
  };
  for (const [name, value] of Object.entries(values)) {
    fixture.componentRef.setInput(name, value);
  }
  const events: string[] = [];
  fixture.componentInstance.primaryAction.subscribe(() => events.push('primary'));
  fixture.componentInstance.secondaryAction.subscribe(() => events.push('secondary'));
  fixture.detectChanges();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.actions button'));
  return { fixture, root, events, primary: buttons[0], secondary: buttons[1] };
}

describe('IntegrationRepairPanelComponent', () => {
  it('shows the state, test history and error', async () => {
    const { root } = await render({
      state: 'TEST_FAILED',
      lastErrorAt: '2026-10-01 10:00',
      errorMessage: 'Connection refused',
    });

    expect(root.querySelector('.state-badge')?.textContent?.trim()).toBe('Test Failed');
    expect(root.querySelector('.state-badge')?.classList).toContain('is-error');
    expect(root.textContent).toContain('Last healthy test: Never');
    expect(root.textContent).toContain('Last failed test: 2026-10-01 10:00');
    expect(root.textContent).toContain('Connection refused');
  });

  it('runs each action exactly once when its button is clicked (secondary submits)', async () => {
    const { fixture, events, primary, secondary } = await render({
      primaryActionLabel: 'Save & Test',
      secondaryActionLabel: 'Save only',
    });

    expect(primary.textContent?.trim()).toBe('Save & Test');
    expect(primary.getAttribute('type')).toBe('button');
    expect(secondary.getAttribute('type')).toBe('submit');

    primary.click();
    fixture.detectChanges();
    expect(events).toEqual(['primary']);

    secondary.click();
    fixture.detectChanges();
    expect(events).toEqual(['primary', 'secondary']);
  });

  it('runs each action exactly once when the primary button submits', async () => {
    const { fixture, events, primary, secondary } = await render({ submitAction: 'primary' });

    expect(primary.getAttribute('type')).toBe('submit');
    expect(secondary.getAttribute('type')).toBe('button');

    primary.click();
    fixture.detectChanges();
    expect(events).toEqual(['primary']);

    secondary.click();
    fixture.detectChanges();
    expect(events).toEqual(['primary', 'secondary']);
  });

  it('pressing Enter in the form runs the submit action', async () => {
    const { fixture, root, events } = await render({ submitAction: 'primary' });

    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(events).toEqual(['primary']);
  });

  it('disables actions on request and lists messages', async () => {
    const { root, primary, secondary } = await render({
      primaryDisabled: true,
      secondaryDisabled: true,
      messages: [{ severity: 'success', text: 'Saved.' }],
    });

    expect(primary.disabled).toBe(true);
    expect(secondary.disabled).toBe(true);
    expect(root.textContent).toContain('Saved.');
  });
});
