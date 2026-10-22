import { Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * The bar along the bottom while picking items in a list: how many are
 * picked, Select all, Cancel, and the page's own action buttons (projected).
 */
@Component({
  selector: 'app-selection-bar',
  templateUrl: './selection-bar.component.html',
  styleUrl: './selection-bar.component.scss',
})
export class SelectionBarComponent {
  @Input({ required: true }) count = 0;
  @Input({ required: true }) visible = 0;
  @Input() busy = false;
  @Output() readonly selectAll = new EventEmitter<void>();
  @Output() readonly clear = new EventEmitter<void>();
  @Output() readonly done = new EventEmitter<void>();
}
