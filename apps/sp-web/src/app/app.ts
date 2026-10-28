import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppLockService } from './core/app-lock/app-lock.service';
import { AppUpdatesService } from './core/pwa/app-updates.service';
import { AppStatusComponent } from './shared/app-status/app-status.component';
import { AppLockScreenComponent } from './shared/app-lock-screen/app-lock-screen.component';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { Toast } from 'primeng/toast';
import { ImageObscurationToggleComponent } from './shared/image-obscuration-toggle/image-obscuration-toggle.component';
import { ThemeToggleComponent } from './shared/theme-toggle/theme-toggle.component';
import { ReleasePickerHostComponent } from './shared/release-picker/release-picker-host.component';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    ThemeToggleComponent,
    ImageObscurationToggleComponent,
    Toast,
    ConfirmDialog,
    AppLockScreenComponent,
    ReleasePickerHostComponent,
    AppStatusComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  constructor() {
    // App Lock and the app-switcher cover run for the whole app.
    inject(AppLockService).start();
    // Installable app: offline notice, "updated" notice, service worker.
    inject(AppUpdatesService).start();
  }
}
