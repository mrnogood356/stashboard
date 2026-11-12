import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { Stage, stageNowText } from './stage-track';

/**
 * Requested → Downloading → Waiting for Stash → In library (or any other
 * list of steps, such as a download's): "Step 2 of 4 · Downloading" over a
 * thin bar in as many parts, the step it's on lit (or red where it stopped).
 */
@Component({
  selector: 'app-stage-track',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="stage-now">{{ now() }}</p>
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
          <span class="stage-label">{{ stage.label }}</span>
        </li>
      }
    </ol>
  `,
  styles: `
    :host {
      display: grid;
      gap: 0.4rem;
      min-width: 0;
      max-width: 28rem;
    }

    /* One thin bar in as many parts as there are steps. */
    .stage-track {
      display: grid;
      grid-template-columns: repeat(var(--stage-count, 4), minmax(0, 1fr));
      gap: 3px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .stage {
      height: 4px;
      border-radius: 2px;
      background: var(--border-strong);
    }

    .stage[data-state='done'] {
      background: var(--text-secondary);
    }

    .stage[data-state='current'] {
      background: var(--accent);
    }

    .stage[data-state='failed'] {
      background: var(--danger);
    }

    /* The step names stay for screen readers; the line above says where it is. */
    .stage-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .stage-now {
      margin: 0;
      font-size: 0.84rem;
      color: var(--text-secondary);
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
