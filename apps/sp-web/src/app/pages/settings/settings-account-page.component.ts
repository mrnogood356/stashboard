import { Component } from '@angular/core';
import { AccountSettingsSectionComponent } from '../../features/auth/account-settings-section.component';

@Component({
  selector: 'app-settings-account-page',
  imports: [AccountSettingsSectionComponent],
  templateUrl: './settings-account-page.component.html',
  styleUrls: ['./settings-account-page.component.scss', './settings-shared.scss'],
})
export class SettingsAccountPageComponent {}
