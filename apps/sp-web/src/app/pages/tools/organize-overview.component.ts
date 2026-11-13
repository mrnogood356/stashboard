import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OrganizeStore } from './organize.store';
import { OrganizeListStore } from './organize-list.store';
import { OrganizeFilesStore } from './organize-files.store';

/** Match & rename → Overview: what needs doing, each with its fix. */
@Component({
  selector: 'app-organize-overview',
  imports: [RouterLink],
  templateUrl: './organize-overview.component.html',
  styleUrls: [
    './tools-shared.scss',
    './organize-shared.scss',
    './organize-overview.component.scss',
  ],
})
export class OrganizeOverviewComponent {
  protected readonly store = inject(OrganizeStore);
  protected readonly list = inject(OrganizeListStore);
  protected readonly files = inject(OrganizeFilesStore);
}
