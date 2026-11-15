import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OrganizeStore } from './organize.store';
import { OrganizeFilesStore } from './organize-files.store';

/** Rename files → To do: what needs doing, each with its fix. */
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
  protected readonly files = inject(OrganizeFilesStore);

  /** Opens the list of what Whisparr still wants, reading it fresh. */
  protected toggleMissing(): void {
    if (!this.store.isOpen('missing')) {
      this.files.loadMissingInWhisparr();
    }
    this.store.toggleOpen('missing');
  }
}
