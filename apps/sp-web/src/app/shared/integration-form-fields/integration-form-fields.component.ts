import { Component, Input } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';

@Component({
  selector: 'app-integration-form-fields',
  imports: [ReactiveFormsModule, InputText],
  templateUrl: './integration-form-fields.component.html',
  styleUrls: [
    './integration-form-fields.component.scss',
    '../../pages/settings/settings-shared.scss',
  ],
})
export class IntegrationFormFieldsComponent {
  @Input({ required: true }) form!: FormGroup;
  @Input() hasStoredApiKey = false;
  @Input() enabledInputId = 'integration-enabled';
  @Input() showEnabledToggle = true;
}
