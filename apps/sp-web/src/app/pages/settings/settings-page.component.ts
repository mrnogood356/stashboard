import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs/operators';

@Component({
  selector: 'app-settings-page',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss',
})
export class SettingsPageComponent {
  private readonly router = inject(Router);

  /** True on /settings itself, where the section cards are; sections get a back link. */
  protected readonly atHome = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(() => isSettingsHome(this.router.url)),
    ),
    { initialValue: isSettingsHome(this.router.url) },
  );
}

function isSettingsHome(url: string): boolean {
  return url.split(/[?#]/)[0].replace(/\/+$/, '') === '/settings';
}
