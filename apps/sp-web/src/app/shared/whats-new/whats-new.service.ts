import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** Lets a page (About) open the "What's new" note on demand. */
@Injectable({ providedIn: 'root' })
export class WhatsNewService {
  private readonly asks = new Subject<void>();
  readonly requests = this.asks.asObservable();

  /** Shows the running release's notes. */
  show(): void {
    this.asks.next();
  }
}
