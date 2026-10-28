import { NgTemplateOutlet } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { ReadinessState, integrationReadinessLabel } from '../../core/api/integrations.types';
import { IntegrationFormFieldsComponent } from '../integration-form-fields/integration-form-fields.component';

export interface IntegrationRepairPanelMessage {
  severity: 'success' | 'error' | 'warn' | 'info';
  text: string;
}

@Component({
  selector: 'app-integration-repair-panel',
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    ButtonDirective,
    Message,
    IntegrationFormFieldsComponent,
  ],
  templateUrl: './integration-repair-panel.component.html',
  styleUrls: [
    './integration-repair-panel.component.scss',
    '../../pages/settings/settings-shared.scss',
  ],
})
export class IntegrationRepairPanelComponent {
  @Input({ required: true }) label!: string;
  /** Under the name in the row, e.g. the service's address. */
  @Input() detail: string | null = null;
  /** A row that opens to the form (Settings); otherwise always open (Setup). */
  @Input() collapsible = false;
  /** Open to show the form; closed, only the row shows. */
  @Input() expanded = false;
  @Input() sectionLabel = '';
  @Input({ required: true }) state!: ReadinessState;
  @Input({ required: true }) summary!: string;
  @Input() helpText: string | null = null;
  @Input({ required: true }) form!: FormGroup;
  @Input() hasStoredApiKey = false;
  @Input() enabledInputId = 'integration-enabled';
  @Input() showEnabledToggle = true;
  @Input() lastHealthyAt: string | null = null;
  @Input() lastErrorAt: string | null = null;
  @Input() errorMessage: string | null = null;
  @Input() primaryActionLabel = 'Save & Test';
  @Input() primaryDisabled = false;
  @Input() secondaryActionLabel = 'Save only';
  @Input() secondaryDisabled = false;
  /** A next-step line under the buttons (Setup's guided steps). */
  @Input() actionHint = '';
  @Input() messages: readonly IntegrationRepairPanelMessage[] = [];
  @Input() submitAction: 'primary' | 'secondary' = 'secondary';

  @Output() primaryAction = new EventEmitter<void>();
  /** The row was tapped: the new open state. */
  @Output() toggled = new EventEmitter<boolean>();
  private static nextId = 0;
  protected readonly bodyId = `integration-panel-${IntegrationRepairPanelComponent.nextId++}`;
  @Output() secondaryAction = new EventEmitter<void>();

  /** "Last tested OK …", or the last failure, in one line. */
  protected testedLine(): string {
    if (this.state === 'TEST_FAILED' && this.lastErrorAt) {
      return `Last test failed ${this.lastErrorAt}`;
    }
    return this.lastHealthyAt ? `Last tested OK ${this.lastHealthyAt}` : 'Not tested yet';
  }

  protected readinessLabel(): string {
    return integrationReadinessLabel(this.state);
  }

  protected stateClass(): string {
    switch (this.state) {
      case 'READY':
        return 'is-ready';
      case 'TEST_FAILED':
        return 'is-error';
      case 'SAVED':
        return 'is-saved';
      case 'NOT_SAVED':
      default:
        return 'is-pending';
    }
  }

  protected onPrimaryClick(): void {
    if (this.submitAction === 'primary') {
      return;
    }

    this.primaryAction.emit();
  }

  protected onSecondaryClick(): void {
    if (this.submitAction === 'secondary') {
      return;
    }

    this.secondaryAction.emit();
  }

  protected onSubmit(): void {
    if (this.submitAction === 'primary') {
      this.primaryAction.emit();
      return;
    }

    this.secondaryAction.emit();
  }
}
