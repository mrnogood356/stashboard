import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LocalLibraryService, SimilarTagGroup } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { TagCleanupPageComponent } from './tag-cleanup-page.component';

const GROUPS: SimilarTagGroup[] = [
  {
    keepId: '2',
    tags: [
      { id: '2', name: 'blondes', aliases: [], sceneCount: 300 },
      { id: '1', name: 'Blonde', aliases: [], sceneCount: 40 },
      { id: '3', name: 'BLONDE', aliases: [], sceneCount: 1 },
    ],
  },
];

async function render(library: Record<string, unknown>) {
  TestBed.resetTestingModule();
  const notifications = { success: vi.fn(), error: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [TagCleanupPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(TagCleanupPageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
}

describe('TagCleanupPageComponent', () => {
  it('merges the picked tags into the kept one only after a second tap', async () => {
    const mergeTags = vi.fn().mockReturnValue(of(undefined));
    const { fixture, root, notifications } = await render({
      similarTags: () => of(GROUPS),
      mergeTags,
    });
    const merge = () => root.querySelector<HTMLButtonElement>('[data-testid="merge-tags"]')!;
    expect(merge().textContent).toContain('Merge 2 into blondes');

    // Leave "BLONDE" out of this merge.
    const boxes = root.querySelectorAll<HTMLInputElement>('.fold input');
    boxes[1].click();
    fixture.detectChanges();
    merge().click();
    fixture.detectChanges();
    expect(mergeTags).not.toHaveBeenCalled();
    expect(merge().textContent).toContain('Tap again to merge 1 into blondes');

    merge().click();
    fixture.detectChanges();
    expect(mergeTags).toHaveBeenCalledWith('2', ['1']);
    expect(notifications.success).toHaveBeenCalledWith('Merged', '1 tag merged into blondes.');
    // blondes and BLONDE are still two ways of writing it.
    expect(root.querySelectorAll('.tag-row').length).toBe(2);
  });

  it('keeps another tag when picked, and never merges a tag into itself', async () => {
    const mergeTags = vi.fn().mockReturnValue(of(undefined));
    const { fixture, root } = await render({ similarTags: () => of(GROUPS), mergeTags });
    root.querySelectorAll<HTMLInputElement>('.keep input')[1].click();
    fixture.detectChanges();
    const merge = root.querySelector<HTMLButtonElement>('[data-testid="merge-tags"]')!;
    merge.click();
    fixture.detectChanges();
    merge.click();
    expect(mergeTags).toHaveBeenCalledWith('1', ['2', '3']);
  });

  it('keeps the tag you kept as the default after leaving one out', async () => {
    const mergeTags = vi.fn().mockReturnValue(of(undefined));
    const { fixture, root } = await render({ similarTags: () => of(GROUPS), mergeTags });
    // Keep "Blonde" (1), merge "blondes" (2), leave "BLONDE" (3) out.
    root.querySelectorAll<HTMLInputElement>('.keep input')[1].click();
    fixture.detectChanges();
    root.querySelectorAll<HTMLInputElement>('.fold input')[1].click();
    fixture.detectChanges();
    const merge = () => root.querySelector<HTMLButtonElement>('[data-testid="merge-tags"]')!;
    merge().click();
    fixture.detectChanges();
    merge().click();
    fixture.detectChanges();

    expect(mergeTags).toHaveBeenCalledWith('1', ['2']);
    expect(root.querySelector('.tag-row.kept .tag-name')?.textContent).toBe('Blonde');
    // The one left out stays out until ticked.
    expect(merge().disabled).toBe(true);
    root.querySelector<HTMLInputElement>('.fold input')!.click();
    fixture.detectChanges();
    expect(merge().textContent).toContain('Merge 1 into Blonde');
  });

  it('says when there is nothing to merge, or Stash can’t be read', async () => {
    expect((await render({ similarTags: () => of([]) })).root.textContent).toContain(
      'No tags written more than one way',
    );
    expect(
      (await render({ similarTags: () => throwError(() => new Error('x')) })).root.textContent,
    ).toContain('Couldn’t read your tags');
  });
});
