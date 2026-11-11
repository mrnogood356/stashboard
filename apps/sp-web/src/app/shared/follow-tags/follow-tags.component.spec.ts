import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { FollowTag, FollowsApiService } from '../../core/api/follows.service';
import { FollowTagsComponent } from './follow-tags.component';

describe('FollowTagsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(tags: FollowTag[], found: FollowTag[] = []) {
    const searchTags = vi.fn().mockReturnValue(of(found));
    await TestBed.configureTestingModule({
      imports: [FollowTagsComponent],
      providers: [{ provide: FollowsApiService, useValue: { searchTags } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(FollowTagsComponent);
    fixture.componentRef.setInput('tags', tags);
    const changes: FollowTag[][] = [];
    fixture.componentInstance.tagsChange.subscribe((next) => changes.push(next));
    fixture.detectChanges();
    return { fixture, searchTags, changes, root: fixture.nativeElement as HTMLElement };
  }

  async function type(fixture: { detectChanges(): void }, root: HTMLElement, text: string) {
    const input = root.querySelector('[data-testid="tag-search"]') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    // Until the search has answered, however long the wait before it takes.
    await vi.waitFor(() => {
      fixture.detectChanges();
      const results = root.querySelector('.results');
      expect(results).toBeTruthy();
      expect(results?.textContent).not.toContain('Searching');
    });
  }

  it('says every scene counts until a tag is chosen', async () => {
    const { root } = await render([]);
    expect(root.textContent).toContain('Any tag: every new scene counts.');
  });

  it('adds a tag found in the catalog, leaving out ones already chosen', async () => {
    const outdoor = { id: 't-out', name: 'Outdoor' };
    const anal = { id: 't-anal', name: 'Anal' };
    const { fixture, root, searchTags, changes } = await render([outdoor], [outdoor, anal]);
    await type(fixture, root, 'o');
    expect(searchTags).toHaveBeenCalledWith('o');
    expect(root.querySelector('[data-testid="add-tag-t-out"]')).toBeNull();

    (root.querySelector('[data-testid="add-tag-t-anal"]') as HTMLButtonElement).click();
    expect(changes).toEqual([[outdoor, anal]]);
  });

  it('adds the first match on Enter, and removes a chip', async () => {
    const anal = { id: 't-anal', name: 'Anal' };
    const outdoor = { id: 't-out', name: 'Outdoor' };
    const { fixture, root, changes } = await render([outdoor], [anal]);
    await type(fixture, root, 'an');
    (root.querySelector('[data-testid="tag-search"]') as HTMLInputElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    (root.querySelector('[data-testid="remove-tag-t-out"]') as HTMLButtonElement).click();
    expect(changes).toEqual([[outdoor, anal], []]);
  });

  it('says any one of several tags is enough', async () => {
    const { root } = await render([
      { id: 't-anal', name: 'Anal' },
      { id: 't-out', name: 'Outdoor' },
    ]);
    expect(root.textContent).toContain('A scene needs any one of these.');
  });

  it('searches the same words again right after adding a tag', async () => {
    const anal = { id: 't-anal', name: 'Anal' };
    const { fixture, root, searchTags } = await render([], [anal]);
    await type(fixture, root, 'an');
    (root.querySelector('[data-testid="add-tag-t-anal"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await type(fixture, root, 'an');
    expect(searchTags).toHaveBeenCalledTimes(2);
    expect(root.textContent).not.toContain('Searching…');
  });
});
