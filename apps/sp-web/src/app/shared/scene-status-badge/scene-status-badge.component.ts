import { Component, Input, computed, signal } from '@angular/core';
import { SceneStatus } from '../../core/api/discover.types';
import {
  sceneStatusBadgeLabel,
  sceneStatusBadgeModifier,
  sceneStatusIconClass,
  sceneStatusIconVisible,
} from './scene-status-badge.model';

@Component({
  selector: 'app-scene-status-badge',
  template: `
    @if (displayMode() === 'icon') {
      @if (iconVisible()) {
        <span
          class="icon"
          [class]="iconClass()"
          role="img"
          [attr.aria-label]="badgeLabel()"
          [attr.title]="badgeLabel()"
        >
          <i [class]="statusIconClass()" aria-hidden="true"></i>
        </span>
      }
    } @else {
      <span class="badge" [class]="badgeClass()">{{ badgeLabel() }}</span>
    }
  `,
  styleUrl: './scene-status-badge.component.scss',
})
export class SceneStatusBadgeComponent {
  // Decorator inputs, not input(): the JIT-compiled unit tests don't see signal inputs.
  private readonly statusValue = signal<SceneStatus | null>(null);
  private readonly modeValue = signal<'badge' | 'icon'>('badge');

  @Input({ required: true })
  set status(value: SceneStatus) {
    this.statusValue.set(value);
  }

  @Input()
  set mode(value: 'badge' | 'icon' | null | undefined) {
    this.modeValue.set(value ?? 'badge');
  }

  private readonly currentStatus = computed(() => {
    const status = this.statusValue();
    if (status === null) {
      throw new Error('SceneStatusBadgeComponent status input is required.');
    }
    return status;
  });

  protected readonly displayMode = computed(() => this.modeValue());
  protected readonly iconVisible = computed(() => sceneStatusIconVisible(this.currentStatus()));

  protected readonly badgeLabel = computed(() => sceneStatusBadgeLabel(this.currentStatus()));

  protected readonly badgeClass = computed(
    () => `badge ${sceneStatusBadgeModifier(this.currentStatus())}`,
  );

  protected readonly iconClass = computed(
    () => `icon ${sceneStatusBadgeModifier(this.currentStatus())}`,
  );

  protected readonly statusIconClass = computed(() => sceneStatusIconClass(this.currentStatus()));
}
