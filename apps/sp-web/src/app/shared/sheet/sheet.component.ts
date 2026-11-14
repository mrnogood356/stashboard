import { CdkTrapFocus } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  booleanAttribute,
  inject,
} from '@angular/core';

let nextSheetId = 0;

/**
 * The app's one sheet: slides up from the bottom on a phone, sits in the
 * middle on a larger screen (or along the side, for an editor beside the
 * page). Title, subtitle and a close button on top; whatever it's given
 * below. Escape, the backdrop and the close button all close it, except
 * while it's busy; focus stays inside while it's open and goes back to what
 * opened it afterwards.
 */
@Component({
  selector: 'app-sheet',
  imports: [CdkTrapFocus],
  host: {
    '(document:keydown.escape)': 'onEscape($event)',
  },
  template: `
    @if (open) {
      <!-- Moved to the end of the page while open, so no page section it's
           placed in (a transformed or clipped header) can trap it below the
           tab bar. -->
      <div #portal class="sheet-portal">
        <div class="sheet-backdrop" aria-hidden="true" (click)="requestClose()"></div>
        <section
          #panel
          class="sheet"
          [class.sheet--side]="placement === 'side'"
          [class.sheet--wide]="size === 'wide'"
          role="dialog"
          aria-modal="true"
          [attr.aria-labelledby]="titleId"
          [attr.data-testid]="testId"
          tabindex="-1"
          cdkTrapFocus
        >
          @if (artUrl) {
            <div
              class="sheet-art"
              [style.background-image]="'url(' + artUrl + ')'"
              aria-hidden="true"
            ></div>
            <div class="sheet-art-shade" aria-hidden="true"></div>
          }
          <span class="sheet-grabber" aria-hidden="true" (pointerdown)="startDrag($event)"></span>
          <header class="sheet-head" (pointerdown)="startDrag($event)">
            <ng-content select="[sheetLead]" />
            <div class="sheet-head-copy">
              <h2 [id]="titleId">{{ title }}</h2>
              @if (subtitle) {
                <p class="sheet-subtitle">{{ subtitle }}</p>
              }
              <ng-content select="[sheetSubtitle]" />
            </div>
            <button
              type="button"
              class="sheet-close"
              aria-label="Close"
              [disabled]="busy"
              (click)="requestClose()"
            >
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </header>
          <div class="sheet-body" [class.sheet-body--own-scroll]="scroll === 'own'">
            <ng-content />
          </div>
          <ng-content select="[sheetFooter]" />
        </section>
      </div>
    }
  `,
  styleUrl: './sheet.component.scss',
})
export class SheetComponent implements OnChanges, OnDestroy {
  private readonly document = inject(DOCUMENT);

  @Input({ transform: booleanAttribute }) open = false;
  @Input() title = '';
  @Input() subtitle: string | null = null;
  /** Something is being saved or sent: it can't be closed until it's done. */
  @Input({ transform: booleanAttribute }) busy = false;
  /** 'side' runs along the right edge on a larger screen, for an editor. */
  @Input() placement: 'center' | 'side' = 'center';
  @Input() size: 'normal' | 'wide' = 'normal';
  /** A blurred picture behind the header, like the scene it's about. */
  @Input() artUrl: string | null = null;
  @Input() testId: string | null = null;
  /** 'own': the content keeps a toolbar fixed and scrolls a part of itself. */
  @Input() scroll: 'sheet' | 'own' = 'sheet';
  @Output() readonly closed = new EventEmitter<void>();

  @ViewChild('panel') private panel?: ElementRef<HTMLElement>;

  @ViewChild('portal') set portal(element: ElementRef<HTMLElement> | undefined) {
    const node = element?.nativeElement;
    if (node && node.parentElement !== this.document.body) {
      this.document.body.appendChild(node);
    }
    this.portalNode = node ?? null;
  }

  /** Where it was moved to: taken away with the sheet, wherever that is. */
  private portalNode: HTMLElement | null = null;

  protected readonly titleId = `sheet-title-${++nextSheetId}`;
  /** What had focus when it opened, to go back to when it closes. */
  private opener: HTMLElement | null = null;
  private scrollLocked = false;

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['open'];
    if (!change || change.previousValue === change.currentValue) {
      return;
    }
    if (this.open) {
      const active = this.document.activeElement;
      this.opener = active instanceof HTMLElement ? active : null;
      this.lockScroll(true);
      this.followKeyboard(true);
      setTimeout(() => this.panel?.nativeElement.focus({ preventScroll: true }));
    } else if (change.previousValue) {
      this.lockScroll(false);
      this.followKeyboard(false);
      this.restoreFocus();
    }
  }

  /**
   * A phone's keyboard covers the bottom of the screen without making the
   * page smaller, so a sheet with a search box would sit behind it. While
   * open, the sheet sits on top of the keyboard and fits the room left.
   */
  private followKeyboard(on: boolean): void {
    const view = this.document.defaultView;
    const viewport = view?.visualViewport;
    if (!view || !viewport) {
      return;
    }
    if (!on) {
      if (this.keyboardListener) {
        viewport.removeEventListener('resize', this.keyboardListener);
        viewport.removeEventListener('scroll', this.keyboardListener);
        this.keyboardListener = null;
      }
      return;
    }
    if (this.keyboardListener) {
      return;
    }
    this.keyboardListener = () => {
      const panel = this.panel?.nativeElement;
      if (!panel) {
        return;
      }
      const covered = Math.max(0, view.innerHeight - viewport.height - viewport.offsetTop);
      panel.style.setProperty('--sheet-keyboard', `${Math.round(covered)}px`);
      panel.style.setProperty('--sheet-room', `${Math.round(viewport.height)}px`);
    };
    viewport.addEventListener('resize', this.keyboardListener);
    viewport.addEventListener('scroll', this.keyboardListener);
    setTimeout(() => this.keyboardListener?.());
  }

  private keyboardListener: (() => void) | null = null;
  private dragging = false;

  /** Pulled down by its top on a phone: closes past a short way, else springs back. */
  protected startDrag(event: PointerEvent): void {
    const panel = this.panel?.nativeElement;
    const view = this.document.defaultView;
    if (
      !panel ||
      !view ||
      this.busy ||
      view.innerWidth >= 760 ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      (event.target as HTMLElement).closest('button, a, input, select, textarea')
    ) {
      return;
    }
    // One drag at a time, followed by the finger that started it only.
    if (this.dragging) {
      return;
    }
    this.dragging = true;
    const pointer = event.pointerId;
    const startY = event.clientY;
    const startTime = event.timeStamp;
    let pulled = 0;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) {
        return;
      }
      pulled = Math.max(0, next.clientY - startY);
      panel.style.transition = 'none';
      panel.style.transform = `translate(-50%, ${pulled}px)`;
    };
    const end = (last: PointerEvent) => {
      if (last.pointerId !== pointer) {
        return;
      }
      this.dragging = false;
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', end);
      view.removeEventListener('pointercancel', end);
      const speed = pulled / Math.max(1, last.timeStamp - startTime);
      const close = last.type === 'pointerup' && (pulled > 90 || (pulled > 30 && speed > 0.5));
      panel.style.transition = 'transform 0.2s ease';
      panel.style.transform = close ? 'translate(-50%, 100%)' : '';
      if (close) {
        setTimeout(() => {
          // Busy meanwhile (saving, say): it stays, so back into view.
          if (this.busy) {
            panel.style.transform = '';
            setTimeout(() => (panel.style.transition = ''), 200);
            return;
          }
          this.requestClose();
        }, 150);
      } else {
        setTimeout(() => (panel.style.transition = ''), 200);
      }
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
  }

  ngOnDestroy(): void {
    this.followKeyboard(false);
    // Removed while open (a page that shows it only while it's open).
    if (this.open) {
      this.restoreFocus();
    }
    this.lockScroll(false);
    // Angular takes away the page it was on, not what was moved out of it.
    this.portalNode?.remove();
    this.portalNode = null;
  }

  protected requestClose(): void {
    if (this.open && !this.busy) {
      this.closed.emit();
    }
  }

  protected onEscape(event: Event): void {
    // A dropdown inside closes first; it stops the event.
    if (this.open && !event.defaultPrevented) {
      this.requestClose();
    }
  }

  private lockScroll(lock: boolean): void {
    if (lock === this.scrollLocked) {
      return;
    }
    this.scrollLocked = lock;
    this.document.body.classList.toggle('app-sheet-open', lock);
  }

  /** Back to what opened it, unless something else has taken focus since. */
  private restoreFocus(): void {
    const opener = this.opener;
    this.opener = null;
    if (!opener) {
      return;
    }
    setTimeout(() => {
      const active = this.document.activeElement;
      const lost = !active || active === this.document.body || !active.isConnected;
      if (opener.isConnected && lost) {
        opener.focus();
      }
    });
  }
}
