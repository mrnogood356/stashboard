import { Component } from '@angular/core';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';
import { YouMayEnjoyComponent } from '../../shared/you-may-enjoy/you-may-enjoy.component';

/** Every "You may enjoy" pick: where the Home row's and Requests' See all go. */
@Component({
  selector: 'app-you-may-enjoy-page',
  imports: [SectionBackComponent, YouMayEnjoyComponent],
  template: `
    <main class="app-page-shell app-page-shell--wide">
      <app-section-back />
      <header class="page-head-compact">
        <div class="page-head-compact__title">
          <h1>You may enjoy</h1>
          <p>Scenes you don’t have yet, picked from what you watch most.</p>
        </div>
      </header>
      <app-you-may-enjoy full />
    </main>
  `,
})
export class YouMayEnjoyPageComponent {}
