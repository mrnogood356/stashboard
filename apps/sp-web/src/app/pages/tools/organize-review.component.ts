import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SelectionBarComponent } from '../../shared/selection-bar/selection-bar.component';
import { MatchReviewComponent } from './match-review.component';
import { OrganizeStore } from './organize.store';
import { OrganizeListStore } from './organize-list.store';

/** Match scenes → Review: found matches to save, and scenes to match one by one. */
@Component({
  selector: 'app-organize-review',
  imports: [RouterLink, SelectionBarComponent, MatchReviewComponent],
  templateUrl: './organize-review.component.html',
  styleUrls: ['./tools-shared.scss', './organize-shared.scss', './organize-review.component.scss'],
})
export class OrganizeReviewComponent {
  protected readonly store = inject(OrganizeStore);
  protected readonly list = inject(OrganizeListStore);
}
