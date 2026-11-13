import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('on a phone', () => {
    const pointer = (type: string, clientY: number, target: EventTarget, timeStamp = 0) => {
      const event = new MouseEvent(type, { bubbles: true, clientY });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      target.dispatchEvent(event);
    };
    let width: number;
    beforeEach(() => {
      width = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      vi.useRealTimers();
    });

    it('closes when pulled down by its top, and springs back from a short pull', async () => {
      const { host, show } = await render();
      show();
      vi.useFakeTimers();
      const grabber = document.querySelector('.sheet-grabber')!;
      const panel = document.querySelector('.sheet') as HTMLElement;

      pointer('pointerdown', 100, grabber, 0);
      pointer('pointermove', 130, window, 400);
      expect(panel.style.transform).toBe('translate(-50%, 30px)');
      pointer('pointerup', 130, window, 400);
      vi.advanceTimersByTime(300);
      expect(host.closed).not.toHaveBeenCalled();
      expect(panel.style.transform).toBe('');

      pointer('pointerdown', 100, document.querySelector('.sheet-head')!, 0);
      pointer('pointermove', 260, window, 200);
      pointer('pointerup', 260, window, 200);
      vi.advanceTimersByTime(300);
      expect(host.closed).toHaveBeenCalledTimes(1);
    });

    it('can’t be pulled shut while busy, or from its close button', async () => {
      const { host, show, fixture } = await render();
      show();
      vi.useFakeTimers();
      pointer('pointerdown', 100, document.querySelector('.sheet-close')!, 0);
      pointer('pointermove', 300, window, 100);
      pointer('pointerup', 300, window, 100);
      host.busy.set(true);
      fixture.detectChanges();
      pointer('pointerdown', 100, document.querySelector('.sheet-grabber')!, 0);
      pointer('pointermove', 300, window, 100);
      pointer('pointerup', 300, window, 100);
      vi.advanceTimersByTime(300);
      expect(host.closed).not.toHaveBeenCalled();
    });
  });
});
