import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** Lets a page (About) open the "What's new" note on demand. */
@Injectable({ providedIn: 'root' })
export class WhatsNewService {
  private listener: (() => void) | null = null;
  /** Asked before the note's (deferred) code had loaded; shown once it has. */
  private pending = false;

  readonly requests = new Observable<void>((subscriber) => {
    this.listener = () => subscriber.next();
    if (this.pending) {
      this.pending = false;
      queueMicrotask(() => subscriber.next());
    }
    return () => {
      this.listener = null;
    };
  });

  /** Shows the running release's notes. */
  show(): void {
    if (this.listener) {
      this.listener();
    } else {
      this.pending = true;
    }
  }
}
