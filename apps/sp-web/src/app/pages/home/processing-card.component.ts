import { DOCUMENT } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { DownloadHandoffApiService, Processing } from '../../core/api/download-handoff.service';
import { stageLabel } from '../processing/processing.format';

/** Refreshed this often while Home is on screen. */
const POLL_MS = 15_000;
const TOP_ITEMS = 3;

export interface ProcessingCardItem {
  id: string;
  title: string;
  status: string;
}

/**
 * "Processing" on Home: shown only while something is on its way into the
 * library (a download in SABnzbd, a dropped-in file settling or waiting for
 * Stash), with the first few and a link to the Processing page.
 */
@Component({
  selector: 'app-processing-card',
  imports: [RouterLink],
  templateUrl: './processing-card.component.html',
  styleUrl: './processing-card.component.scss',
})
export class ProcessingCardComponent implements OnInit, OnDestroy {
  private readonly api = inject(DownloadHandoffApiService);
  private readonly document = inject(DOCUMENT);
  private request: Subscription | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly visibilityHandler = () => {
    if (this.document.visibilityState === 'visible') {
      this.load();
    } else {
      this.stop();
    }
  };

  protected readonly data = signal<Processing | null>(null);
  protected readonly count = computed(() => this.data()?.activeCount ?? 0);
  protected readonly items = computed<ProcessingCardItem[]>(() => {
    const data = this.data();
    if (!data) {
      return [];
    }
    const items: ProcessingCardItem[] = [
      ...data.handoffs.map((entry) => ({
        id: entry.id,
        title: entry.releaseTitle,
        status:
          entry.stage === 'downloading' && entry.progress !== null
            ? `${entry.progress}%`
            : stageLabel(entry.stage),
      })),
      ...data.dropIns.watch.settling.map((file) => ({
        id: file.path,
        title: file.name,
        status: 'Settling',
      })),
      ...data.dropIns.active.map((entry) => ({
        id: entry.id,
        title: entry.name,
        status: 'Waiting for Stash',
      })),
    ];
    return items.slice(0, TOP_ITEMS);
  });

  ngOnInit(): void {
    this.document.addEventListener('visibilitychange', this.visibilityHandler);
    this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.stop();
  }

  private load(): void {
    this.stop();
    this.request = this.api.processing().subscribe({
      next: (data) => {
        this.data.set(data);
        this.schedule();
      },
      // Home never breaks over this card: without fresh data it just hides.
      error: () => {
        this.data.set(null);
        this.schedule();
      },
    });
  }

  private schedule(): void {
    if (this.destroyed || this.document.visibilityState === 'hidden') {
      return;
    }
    this.timer = setTimeout(() => this.load(), POLL_MS);
  }

  private stop(): void {
    this.request?.unsubscribe();
    this.request = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
