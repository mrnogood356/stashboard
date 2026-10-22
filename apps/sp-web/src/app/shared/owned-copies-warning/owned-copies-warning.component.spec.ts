import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedCopy } from '../../core/api/discover.types';
import { OwnedCopiesWarningComponent } from './owned-copies-warning.component';

describe('OwnedCopiesWarningComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  const linked: OwnedCopy = {
    reason: 'LINKED',
    stashSceneId: '12',
    title: 'Beach Day',
    studio: 'Studio',
    date: '2024-05-01',
    path: '/library/Studio/beach-day.mp4',
    imageUrl: null,
    whisparrUrl: null,
  };
  const whisparr: OwnedCopy = {
    reason: 'WHISPARR',
    stashSceneId: null,
    title: null,
    studio: null,
    date: null,
    path: null,
    imageUrl: null,
    whisparrUrl: 'http://whisparr.local/movie/3',
  };

  async function render(copies: OwnedCopy[], proceedLabel = 'Request anyway') {
    await TestBed.configureTestingModule({
      imports: [OwnedCopiesWarningComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(OwnedCopiesWarningComponent);
    fixture.componentRef.setInput('copies', copies);
    fixture.componentRef.setInput('proceedLabel', proceedLabel);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows which copy you have, why it matched, and where it is', async () => {
    const { root } = await render([linked]);

    expect(root.textContent).toContain('You may already have this');
    expect(root.textContent).toContain('Beach Day');
    expect(root.textContent).toContain('Studio · 2024-05-01');
    expect(root.textContent).toContain('Linked to this scene in Stash');
    expect(root.textContent).toContain('/library/Studio/beach-day.mp4');
    expect(root.querySelector('a.open')?.getAttribute('href')).toBe('/library/scene/12');
  });

  it('links a Whisparr-only match to Whisparr, with a stand-in title', async () => {
    const { root } = await render([whisparr]);

    expect(root.textContent).toContain('Whisparr already has a file');
    expect(root.textContent).toContain('This scene');
    expect(root.querySelector('a.open')?.getAttribute('href')).toBe(
      'http://whisparr.local/movie/3',
    );
  });

  it('lets you go ahead anyway, and closes around an opened copy', async () => {
    const { fixture, root } = await render([linked, whisparr], 'Download anyway');
    const proceed = vi.fn();
    const opened = vi.fn();
    fixture.componentInstance.proceed.subscribe(proceed);
    fixture.componentInstance.opened.subscribe(opened);

    expect(root.textContent).toContain('These look like copies you already have.');
    const button = root.querySelector('button.proceed') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Download anyway');
    button.click();
    expect(proceed).toHaveBeenCalledTimes(1);

    // A modified click: the router leaves it to the browser, so no navigation here.
    (root.querySelector('a.open') as HTMLAnchorElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
