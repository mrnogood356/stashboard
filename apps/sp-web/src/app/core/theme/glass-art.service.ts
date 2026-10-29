import { DOCUMENT } from '@angular/common';
import { DestroyRef, EffectRef, Injectable, effect, inject } from '@angular/core';

/** Our own pages, http(s) images and inline images; nothing that could run. */
const SAFE_URL = /^(?:https?:\/\/|\/(?!\/)|data:image\/)/i;

/** How long cleared art lingers in case the next page sets its own. */
const CLEAR_DELAY_MS = 600;

/**
 * The page's artwork behind the glass style (styles.scss, .glass-art). Two
 * layers, so a new image loads out of sight and fades in over the old one
 * instead of the backdrop going blank and popping.
 */
@Injectable({ providedIn: 'root' })
export class GlassArtService {
  private readonly document = inject(DOCUMENT);
  private layers: [HTMLElement, HTMLElement] | null = null;
  private front = 0;
  private current: string | null = null;
  private request = 0;

  set(url: string | null | undefined): void {
    const next = url && SAFE_URL.test(url) ? url : null;
    if (next === this.current) {
      return;
    }
    this.current = next;
    const request = ++this.request;
    if (!next) {
      // Leaving a page clears its art, but the next page usually brings its
      // own a moment later: wait, so that one crossfades straight in.
      setTimeout(() => {
        if (request === this.request) {
          this.layers?.forEach((layer) => layer.classList.remove('is-shown'));
        }
      }, CLEAR_DELAY_MS);
      return;
    }
    void this.loaded(next).then(() => {
      if (request !== this.request) {
        return;
      }
      const layers = this.ensureLayers();
      const back = layers[1 - this.front];
      // A quoted CSS string, so quotes and brackets in the address can't break out.
      back.style.backgroundImage = `url(${JSON.stringify(next)})`;
      back.classList.add('is-shown');
      layers[this.front].classList.remove('is-shown');
      this.front = 1 - this.front;
    });
  }

  /** For a page: shows url() behind the glass while the page is open, and clears it after. */
  follow(url: () => string | null | undefined): EffectRef {
    inject(DestroyRef).onDestroy(() => this.set(null));
    return effect(() => this.set(url()));
  }

  /** Waits for the image to be ready to paint; a broken one still goes through. */
  private async loaded(url: string): Promise<void> {
    const view = this.document.defaultView;
    if (!view?.Image) {
      return;
    }
    const image = new view.Image();
    image.src = url;
    if (typeof image.decode !== 'function') {
      return;
    }
    try {
      await image.decode();
    } catch {
      // Not decodable: show it anyway, the backdrop just stays plain.
    }
  }

  private ensureLayers(): [HTMLElement, HTMLElement] {
    if (!this.layers) {
      const host = this.document.createElement('div');
      host.className = 'glass-art';
      host.setAttribute('aria-hidden', 'true');
      const a = this.document.createElement('span');
      const b = this.document.createElement('span');
      host.append(a, b);
      this.document.body.append(host);
      this.layers = [a, b];
    }
    return this.layers;
  }
}
