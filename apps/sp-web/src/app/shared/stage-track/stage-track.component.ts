import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { Stage, stageNowText } from './stage-track';

/**
 * Requested → Downloading → Waiting for Stash → In library (or any other
 * list of steps, such as a download's), with the step
 * it's on lit (or red where it stopped). Phones show "Step 2 of 4 · …"
 * instead of the step names, which don't fit.
 */
@Component({
  selector: 'app-stage-track',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol
      class="stage-track"
      [style.--stage-count]="stages.length"
      [attr.aria-label]="'Progress: ' + label"
      [attr.data-testid]="testId"
    >
      @for (stage of stages; track stage.label) {
        <li
          class="stage"
          [attr.data-state]="stage.state"
          [attr.aria-current]="
            stage.state === 'current' || stage.state === 'failed' ? 'step' : null
          "
        >
          <span class="stage-dot" aria-hidden="true">
            @if (stage.state === 'done') {
              <i class="pi pi-check"></i>
            } @else if (stage.state === 'failed') {
              <i class="pi pi-times"></i>
            }
          </span>
          <span class="stage-label">{{ stage.label }}</span>
        </li>
      }
    </ol>
    <p class="stage-now">{{ now() }}</p>
  `,
  styles: `
    :host {
      display: grid;
      gap: 0.35rem;
      min-width: 0;
    }

    .stage-track {
      display: grid;
      grid-template-columns: repeat(var(--stage-count, 4), minmax(0, 1fr));
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .stage {
      position: relative;
      display: grid;
      justify-items: center;
      gap: 0.3rem;
      min-width: 0;
      text-align: center;
    }

    /* The line to the next step. */
    .stage:not(:last-child)::after {
      content: '';
      position: absolute;
      top: 0.55rem;
      left: calc(50% + 0.75rem);
      right: calc(-50% + 0.75rem);
      height: 2px;
      border-radius: 1px;
      background: var(--border-strong);
    }

    .stage[data-state='done']:not(:last-child)::after {
      background: var(--success);
    }

    .stage-dot {
      display: grid;
      place-items: center;
      width: 1.1rem;
      height: 1.1rem;
      border-radius: 50%;
      border: 2px solid var(--border-strong);
      background: var(--surface-1);
      font-size: 0.55rem;
    }

    .stage[data-state='done'] .stage-dot {
      border-color: var(--success);
      background: var(--success);
      color: var(--surface-1);
    }

    .stage[data-state='current'] .stage-dot {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }

    .stage[data-state='failed'] .stage-dot {
      border-color: var(--danger);
      background: var(--danger);
      color: var(--surface-1);
    }

    .stage-label {
      max-width: 100%;
      font-size: 0.72rem;
      line-height: 1.25;
      color: var(--text-muted);
    }

    .stage[data-state='current'] .stage-label {
      color: var(--text-primary);
      font-weight: 600;
    }

    .stage[data-state='failed'] .stage-label {
      color: var(--danger-text);
      font-weight: 600;
    }

    .stage-now {
      display: none;
      margin: 0;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
    }

    @media (max-width: 640px) {
      .stage-label {
        display: none;
      }

      .stage-now {
        display: block;
      }
    }
  `,
})
export class StageTrackComponent {
  @Input({ required: true }) stages: Stage[] = [];
  /** What it's the progress of, for screen readers. */
  @Input() label = '';
  @Input() testId: string | null = null;

  protected now(): string {
    return stageNowText(this.stages);
  }
}
