import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { timeout } from 'rxjs';
import { HealthService } from '../../core/api/health.service';
import { safeNextUrl } from '../../core/network/unreachable';

/** How often it checks again on its own. */
const RETRY_MS = 5_000;
/** A check that hasn't answered by now counts as failed, so the next one can start. */
const CHECK_TIMEOUT_MS = 4_000;

/**
 * Shown instead of sign-in or setup when Stashboard itself can't be reached:
 * offline, or the server restarting. It goes back to where you were as soon
 * as it answers.
 */
@Component({
  selector: 'app-unreachable-page',
  templateUrl: './unreachable-page.component.html',
  styleUrl: './unreachable-page.component.scss',
})
export class UnreachablePageComponent implements OnInit {
  private readonly health = inject(HealthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly offline = signal(typeof navigator !== 'undefined' && !navigator.onLine);
  protected readonly checking = signal(false);

  ngOnInit(): void {
    const timer = setInterval(() => this.check(), RETRY_MS);
    const online = () => {
      this.offline.set(false);
      this.check();
    };
    const offline = () => this.offline.set(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    });
  }

  protected check(): void {
    if (this.checking()) {
      return;
    }
    this.checking.set(true);
    this.health
      .getStatus()
      .pipe(timeout(CHECK_TIMEOUT_MS))
      .subscribe({
        next: () => {
          this.checking.set(false);
          void this.router.navigateByUrl(
            safeNextUrl(this.route.snapshot.queryParamMap.get('next')),
            {
              replaceUrl: true,
            },
          );
        },
        error: () => this.checking.set(false),
      });
  }
}
