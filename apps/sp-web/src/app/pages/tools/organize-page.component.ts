import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { OrganizeStore } from './organize.store';
import { OrganizeListStore } from './organize-list.store';
import { OrganizeFilesStore } from './organize-files.store';
import { OrganizeOverviewComponent } from './organize-overview.component';
import { OrganizeReviewComponent } from './organize-review.component';
import { OrganizeMatchSettingsComponent } from './organize-match-settings.component';
import { OrganizeRenameSettingsComponent } from './organize-rename-settings.component';
import { OrganizeTool } from './organize.shared';

/**
 * Library tools → Match scenes (route data tool: 'match') and Rename files
 * (tool: 'rename'): one page, two tools. Their tabs share the three stores
 * provided here, one set per visit to the page.
 */
@Component({
  selector: 'app-organize-page',
  imports: [
    RouterLink,
    OrganizeOverviewComponent,
    OrganizeReviewComponent,
    OrganizeMatchSettingsComponent,
    OrganizeRenameSettingsComponent,
  ],
  providers: [OrganizeStore, OrganizeListStore, OrganizeFilesStore],
  templateUrl: './organize-page.component.html',
  styleUrls: ['./tools-shared.scss', './organize-shared.scss', './organize-page.component.scss'],
})
export class OrganizePageComponent implements OnInit {
  protected readonly store = inject(OrganizeStore);
  private readonly route = inject(ActivatedRoute);

  ngOnInit(): void {
    this.store.init(this.route.snapshot.data?.['tool'] as OrganizeTool | undefined);
  }
}
