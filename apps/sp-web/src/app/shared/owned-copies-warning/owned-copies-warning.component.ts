import { Component, EventEmitter, Input, Output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OwnedCopy, OwnedCopyReason } from '../../core/api/discover.types';

const REASONS: Record<OwnedCopyReason, string> = {
  LINKED: 'Linked to this scene in Stash',
  MERGED: 'Linked to a scene merged with this one',
  FINGERPRINT: 'Same file fingerprint',
  TITLE: 'Same title, studio and date',
  WHISPARR: 'Whisparr already has a file',
};

/**
 * "You may already have this": the copies found before a request or a
 * download, each with a way to open it, and a button to go ahead anyway.
 */
@Component({
  selector: 'app-owned-copies-warning',
  imports: [RouterLink],
  templateUrl: './owned-copies-warning.component.html',
  styleUrl: './owned-copies-warning.component.scss',
})
export class OwnedCopiesWarningComponent {
  @Input() copies: OwnedCopy[] = [];
  /** The go-ahead button: "Request anyway" or "Download anyway". */
  @Input() proceedLabel = 'Request anyway';
  @Output() readonly proceed = new EventEmitter<void>();
  /** A copy was opened; the sheet or dialog around this should close. */
  @Output() readonly opened = new EventEmitter<void>();

  protected reason(copy: OwnedCopy): string {
    return REASONS[copy.reason];
  }

  protected title(copy: OwnedCopy): string {
    return copy.title?.trim() || (copy.stashSceneId ? `Scene #${copy.stashSceneId}` : 'This scene');
  }

  protected meta(copy: OwnedCopy): string | null {
    return [copy.studio, copy.date].filter(Boolean).join(' · ') || null;
  }
}
