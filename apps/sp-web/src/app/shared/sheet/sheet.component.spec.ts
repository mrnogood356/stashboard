import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SheetComponent } from './sheet.component';

@Component({
  imports: [SheetComponent],
  template: `
    <button type="button" id="opener">Open</button>
    <app-sheet
      [open]="open()"
      title="Pick a release"
      subtitle="Late Night Session"
      [busy]="busy()"
      (closed)="closed()"
    >
      <button type="button" id="inside">Inside</button>
    </app-sheet>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly closed = vi.fn(() => this.open.set(false));
}

describe('SheetComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.classList.remove('app-sheet-open');
  });

  async function render() {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const host = fixture.componentInstance;
    const show = () => {
      host.open.set(true);
      fixture.detectChanges();
    };
    return { fixture, host, show, root: fixture.nativeElement as HTMLElement };
  }

  it('shows its title and content as a dialog, and stops the page scrolling', async () => {
    const { show } = await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    show();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Pick a release');
    expect(dialog.textContent).toContain('Late Night Session');
    expect(document.querySelector('#inside')).not.toBeNull();
    expect(document.body.classList.contains('app-sheet-open')).toBe(true);
  });

  it('closes on Escape, the backdrop and ✕, but not while busy', async () => {
    const { fixture, host, show } = await render();
    show();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(host.closed).toHaveBeenCalledTimes(1);

    show();
    (document.querySelector('.sheet-backdrop') as HTMLElement).click();
    expect(host.closed).toHaveBeenCalledTimes(2);

    show();
    host.busy.set(true);
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    (document.querySelector('.sheet-backdrop') as HTMLElement).click();
    expect((document.querySelector('.sheet-close') as HTMLButtonElement).disabled).toBe(true);
    expect(host.closed).toHaveBeenCalledTimes(2);
  });

  it('gives focus back to what opened it, and lets the page scroll again', async () => {
    const { fixture, host, root, show } = await render();
    const opener = root.querySelector('#opener') as HTMLButtonElement;
    opener.focus();
    show();
    (document.querySelector('#inside') as HTMLButtonElement).focus();

    host.open.set(false);
    fixture.detectChanges();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.body.classList.contains('app-sheet-open')).toBe(false);
    fixture.nativeElement.remove();
  });

  it('goes with the page it was on, even while open', async () => {
    const { fixture, show } = await render();
    show();
    expect(document.querySelector('.sheet-portal')).not.toBeNull();
    fixture.destroy();
    expect(document.querySelector('.sheet-portal')).toBeNull();
    expect(document.body.classList.contains('app-sheet-open')).toBe(false);
  });
});
