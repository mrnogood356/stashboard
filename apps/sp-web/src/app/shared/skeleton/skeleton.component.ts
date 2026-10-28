import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** The shapes pages load: a grid of cards, request cards, settings rows, or a details page. */
export type SkeletonKind = 'grid' | 'portrait' | 'list' | 'rows' | 'detail';

/**
 * Grey placeholders in the shape of what's loading, so a page keeps its
 * layout instead of showing a spinner and then jumping.
 */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      [class]="'skeleton skeleton--' + kind"
      role="status"
      aria-live="polite"
      data-testid="skeleton"
    >
      <span class="visually-hidden">{{ label }}</span>
      @switch (kind) {
        @case ('detail') {
          <div class="block hero"></div>
          <div class="line wide"></div>
          <div class="line"></div>
        }
        @case ('rows') {
          @for (row of slots(); track row) {
            <div class="block row"></div>
          }
        }
        @case ('list') {
          @for (row of slots(); track row) {
            <div class="list-item">
              <div class="block thumb"></div>
              <div class="lines">
                <div class="line short"></div>
                <div class="line wide"></div>
                <div class="line"></div>
              </div>
            </div>
          }
        }
        @default {
          @for (card of slots(); track card) {
            <div class="card">
              <div class="block art"></div>
              <div class="line wide"></div>
              <div class="line short"></div>
            </div>
          }
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin-top: 0.9rem;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    .block,
    .line {
      border-radius: 10px;
      background: linear-gradient(
        100deg,
        color-mix(in srgb, var(--surface-2) 90%, transparent) 30%,
        color-mix(in srgb, var(--surface-raised, var(--surface-elevated)) 95%, transparent) 50%,
        color-mix(in srgb, var(--surface-2) 90%, transparent) 70%
      );
      background-size: 300% 100%;
      animation: shimmer 1.4s ease-in-out infinite;
    }

    .line {
      height: 0.8rem;
      width: 60%;
      border-radius: 6px;
    }

    .line.wide {
      width: 85%;
    }

    .line.short {
      width: 40%;
    }

    .skeleton--grid,
    .skeleton--portrait {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(15rem, 42vw), 1fr));
      gap: 1rem;
    }

    .card {
      display: grid;
      gap: 0.5rem;
    }

    .art {
      aspect-ratio: 16 / 9;
      border-radius: 12px;
    }

    .skeleton--portrait .art {
      aspect-ratio: 3 / 4;
    }

    .skeleton--list,
    .skeleton--rows {
      display: grid;
      gap: 0.75rem;
    }

    .list-item {
      display: grid;
      grid-template-columns: minmax(6.5rem, 13rem) 1fr;
      gap: 0.9rem;
      padding: 0.6rem;
      border-radius: 16px;
      background: var(--surface-1);
    }

    .thumb {
      aspect-ratio: 4 / 3;
    }

    .lines {
      display: grid;
      align-content: start;
      gap: 0.6rem;
      padding-top: 0.3rem;
    }

    .row {
      height: 3.6rem;
      border-radius: 14px;
    }

    .skeleton--detail {
      display: grid;
      gap: 0.8rem;
    }

    .hero {
      height: clamp(10rem, 28vw, 18rem);
      border-radius: 18px;
    }

    @keyframes shimmer {
      from {
        background-position: 100% 0;
      }
      to {
        background-position: 0 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .block,
      .line {
        animation: none;
      }
    }
  `,
})
export class SkeletonComponent {
  @Input() kind: SkeletonKind = 'grid';
  /** How many placeholders to draw. */
  @Input() count = 8;
  /** Read out to screen readers in place of the placeholders. */
  @Input() label = 'Loading…';

  protected slots(): number[] {
    return Array.from({ length: this.count }, (_, index) => index);
  }
}
