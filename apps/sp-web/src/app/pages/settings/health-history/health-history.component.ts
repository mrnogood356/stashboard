import { Component, OnInit, inject, signal } from '@angular/core';
import { AboutApiService, HealthHour, ServiceHistory } from '../../../core/api/about.service';

export type HourState = 'ok' | 'some' | 'down' | 'none';

export function hourState(hour: HealthHour): HourState {
  if (hour.checks === 0) {
    return 'none';
  }
  if (hour.failed === 0) {
    return 'ok';
  }
  return hour.failed === hour.checks ? 'down' : 'some';
}

const STATE_LABEL: Record<HourState, string> = {
  ok: 'Answered',
  some: 'Some checks failed',
  down: 'Didn’t answer',
  none: 'Not checked',
};

/**
 * About's "Last 7 days": for the database and each integration, one bar per
 * hour (answered, some checks failed, didn't answer, not checked), the
 * week's share answered and average answer time, and the hours with problems
 * as a list.
 */
@Component({
  selector: 'app-health-history',
  templateUrl: './health-history.component.html',
  styleUrl: './health-history.component.scss',
})
export class HealthHistoryComponent implements OnInit {
  private readonly api = inject(AboutApiService);

  protected readonly services = signal<ServiceHistory[] | null>(null);
  protected readonly failed = signal(false);
  protected readonly stateLabel = STATE_LABEL;
  protected readonly legend: HourState[] = ['ok', 'some', 'down', 'none'];

  ngOnInit(): void {
    this.api.history().subscribe({
      next: (result) => this.services.set(result.services),
      error: () => this.failed.set(true),
    });
  }

  protected state(hour: HealthHour): HourState {
    return hourState(hour);
  }

  protected tip(hour: HealthHour): string {
    const when = this.when(hour.at);
    if (hour.checks === 0) {
      return `${when}: not checked`;
    }
    const answered = hour.checks - hour.failed;
    const time = hour.averageMs !== null ? `, ${hour.averageMs} ms on average` : '';
    return `${when}: ${answered} of ${hour.checks} checks answered${time}`;
  }

  protected problemHours(service: ServiceHistory): HealthHour[] {
    return service.hours.filter((hour) => hour.failed > 0).reverse();
  }

  protected summary(service: ServiceHistory): string {
    const time = service.averageMs !== null ? ` · ${service.averageMs} ms on average` : '';
    return `${service.upPercent}% answered${time}`;
  }

  protected when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
}
