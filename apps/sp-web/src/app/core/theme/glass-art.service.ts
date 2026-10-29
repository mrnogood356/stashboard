import { DOCUMENT } from '@angular/common';
import { DestroyRef, EffectRef, Injectable, effect, inject } from '@angular/core';

/** The page's artwork, as the glass style's backdrop shows it (styles.scss, body::after). */
const PROPERTY = '--glass-art';

/** Our own pages, http(s) images and inline images; nothing that could run. */
const SAFE_URL = /^(?:https?:\/\/|\/(?!\/)|data:image\/)/i;

@Injectable({ providedIn: 'root' })
export class GlassArtService {
  private readonly document = inject(DOCUMENT);

  set(url: string | null | undefined): void {
    const style = this.document.documentElement.style;
    if (url && SAFE_URL.test(url)) {
      // A quoted CSS string, so quotes and brackets in the address can't break out.
      style.setProperty(PROPERTY, `url(${JSON.stringify(url)})`);
    } else {
      style.removeProperty(PROPERTY);
    }
  }

  /** For a page: shows url() behind the glass while the page is open, and clears it after. */
  follow(url: () => string | null | undefined): EffectRef {
    inject(DestroyRef).onDestroy(() => this.set(null));
    return effect(() => this.set(url()));
  }
}
