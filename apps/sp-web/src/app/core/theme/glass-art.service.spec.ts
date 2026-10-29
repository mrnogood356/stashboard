import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlassArtService } from './glass-art.service';

describe('GlassArtService', () => {
  /** The image on the layer that is showing, or '' when none is. */
  const shown = () =>
    document.querySelector<HTMLElement>('.glass-art > span.is-shown')?.style.backgroundImage ?? '';
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  /** Cleared art lingers briefly in case the next page brings its own. */
  const cleared = () => new Promise((resolve) => setTimeout(resolve, 700));

  // Pages in other specs leave their own layers in the shared document.
  const clear = () => document.querySelectorAll('.glass-art').forEach((host) => host.remove());

  beforeEach(clear);

  afterEach(() => {
    clear();
    TestBed.resetTestingModule();
  });

  it('shows a quoted url, and ignores anything that isn’t an image address', async () => {
    const service = TestBed.inject(GlassArtService);

    service.set('/api/images/1?x="a")');
    await settle();
    expect(shown()).toContain('/api/images/1?x=');

    service.set('javascript:alert(1)');
    await cleared();
    expect(shown()).toBe('');

    service.set('https://cdn.example/a.jpg');
    service.set(null);
    await cleared();
    expect(shown()).toBe('');
  });

  it('fades the new image in on the other layer, and leaves the same image alone', async () => {
    const service = TestBed.inject(GlassArtService);

    service.set('https://cdn.example/a.jpg');
    await settle();
    const first = document.querySelector('.glass-art > span.is-shown');

    service.set('https://cdn.example/a.jpg');
    await settle();
    expect(document.querySelector('.glass-art > span.is-shown')).toBe(first);

    service.set('https://cdn.example/b.jpg');
    await settle();
    const layers = document.querySelectorAll('.glass-art > span');
    expect(layers).toHaveLength(2);
    expect(document.querySelector('.glass-art > span.is-shown')).not.toBe(first);
    expect(shown()).toContain('b.jpg');
    expect(document.querySelectorAll('.glass-art > span.is-shown')).toHaveLength(1);
  });

  it('keeps the old art up when the next page sets its own straight after', async () => {
    const service = TestBed.inject(GlassArtService);
    service.set('https://cdn.example/a.jpg');
    await settle();

    service.set(null);
    service.set('https://cdn.example/b.jpg');
    await cleared();

    expect(shown()).toContain('b.jpg');
  });

  it('follows a page’s artwork while it is open and clears it after', async () => {
    const image = signal<string | null>('https://cdn.example/a.jpg');

    @Component({ template: '' })
    class Page {
      constructor() {
        TestBed.inject(GlassArtService).follow(() => image());
      }
    }

    const fixture = TestBed.createComponent(Page);
    fixture.detectChanges();
    TestBed.tick();
    await settle();
    expect(shown()).toContain('a.jpg');

    image.set('https://cdn.example/b.jpg');
    TestBed.tick();
    await settle();
    expect(shown()).toContain('b.jpg');

    fixture.destroy();
    await cleared();
    expect(shown()).toBe('');
  });
});
