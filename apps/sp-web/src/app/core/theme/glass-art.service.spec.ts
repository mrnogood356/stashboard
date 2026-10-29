import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { GlassArtService } from './glass-art.service';

describe('GlassArtService', () => {
  const art = () => document.documentElement.style.getPropertyValue('--glass-art');

  afterEach(() => {
    document.documentElement.style.removeProperty('--glass-art');
    TestBed.resetTestingModule();
  });

  it('sets a quoted url, and ignores anything that isn’t an image address', () => {
    const service = TestBed.inject(GlassArtService);

    service.set('/api/images/1?x="a")');
    expect(art()).toContain('url("/api/images/1?x=\\"a\\")")');

    service.set('javascript:alert(1)');
    expect(art()).toBe('');

    service.set('https://cdn.example/a.jpg');
    service.set(null);
    expect(art()).toBe('');
  });

  it('follows a page’s artwork while it is open and clears it after', () => {
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
    expect(art()).toContain('a.jpg');

    image.set('https://cdn.example/b.jpg');
    TestBed.tick();
    expect(art()).toContain('b.jpg');

    fixture.destroy();
    expect(art()).toBe('');
  });
});
