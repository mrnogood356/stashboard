import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OrganizeStore } from './organize.store';
import { OrganizeFilesStore } from './organize-files.store';

/** Match & rename → Settings: sources, what happens after a match, naming and folders. */
@Component({
  selector: 'app-organize-settings',
  imports: [RouterLink],
  templateUrl: './organize-settings.component.html',
  styleUrls: [
    './tools-shared.scss',
    './organize-shared.scss',
    './organize-settings.component.scss',
  ],
})
export class OrganizeSettingsComponent {
  protected readonly store = inject(OrganizeStore);
  protected readonly files = inject(OrganizeFilesStore);

  @ViewChild('folderInput') private folderInput?: ElementRef<HTMLInputElement>;
  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>;

  protected insertToken(token: string): void {
    const field = this.files.lastPatternField;
    const input = (field === 'folder' ? this.folderInput : this.fileInput)?.nativeElement;
    const value = field === 'folder' ? this.files.folderPart() : this.files.filePart();
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}{${token}}${value.slice(end)}`;
    if (field === 'folder') {
      this.files.setFolderPart(next);
    } else {
      this.files.setFilePart(next);
    }
    setTimeout(() => {
      const caret = start + token.length + 2;
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  }
}
