import { Component, inject } from '@angular/core';
import { ReleaseSearchService } from '../../core/releases/release-search.service';
import { ReleasePickerComponent } from './release-picker.component';

/** The one release picker lists open through ReleaseSearchService. */
@Component({
  selector: 'app-release-picker-host',
  imports: [ReleasePickerComponent],
  template: `
    @if (search.target(); as target) {
      <!-- Its code loads the first time a picker opens, not with the app. -->
      @defer (on immediate) {
        <app-release-picker
          [open]="true"
          [stashId]="target.stashId"
          [sceneTitle]="target.title"
          [source]="target.source"
          [provider]="target.provider ?? null"
          (closed)="search.close()"
          (grabbed)="search.done()"
        />
      }
    }
  `,
})
export class ReleasePickerHostComponent {
  protected readonly search = inject(ReleaseSearchService);
}
