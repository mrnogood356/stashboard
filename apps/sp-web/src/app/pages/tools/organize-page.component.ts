import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OrganizeStore } from './organize.store';
import { OrganizeListStore } from './organize-list.store';
import { OrganizeFilesStore } from './organize-files.store';
import { OrganizeOverviewComponent } from './organize-overview.component';
import { OrganizeReviewComponent } from './organize-review.component';
import { OrganizeSettingsComponent } from './organize-settings.component';

/**
 * Library tools → Match & rename: match scenes to StashDB, rename files into
 * tidy folders, and keep Stash and Whisparr in step. The tabs share the three
 * stores provided here, one set per visit to the page.
 */
@Component({
  selector: 'app-organize-page',
  imports: [
    RouterLink,
    OrganizeOverviewComponent,
    OrganizeReviewComponent,
    OrganizeSettingsComponent,
  ],
  providers: [OrganizeStore, OrganizeListStore, OrganizeFilesStore],
  templateUrl: './organize-page.component.html',
  styleUrls: ['./tools-shared.scss', './organize-shared.scss', './organize-page.component.scss'],
})
export class OrganizePageComponent implements OnInit {
  protected readonly store = inject(OrganizeStore);

  ngOnInit(): void {
    this.store.init();
  }
}
