import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { HideOwnedService } from '../../core/preferences/hide-owned.service';
import { OwnedToggleComponent } from './owned-toggle.component';

describe('OwnedToggleComponent', () => {
  afterEach(() => {
    window.localStorage.removeItem('sp-hide-owned');
    TestBed.resetTestingModule();
  });

  it('hides scenes you have from every catalog list, and remembers it', async () => {
    await TestBed.configureTestingModule({ imports: [OwnedToggleComponent] }).compileComponents();
    const fixture = TestBed.createComponent(OwnedToggleComponent);
    fixture.componentRef.setInput('count', 2);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const hideOwned = TestBed.inject(HideOwnedService);
    const items = [
      { id: 'a', status: { state: 'AVAILABLE' as const } },
      { id: 'b', status: { state: 'NOT_REQUESTED' as const } },
    ];

    expect(root.textContent).toContain('Hide ones I have');
    expect(hideOwned.filter(items)).toHaveLength(2);

    (root.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(root.textContent).toContain('Hiding 2 you have');
    expect(root.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
    expect(hideOwned.filter(items).map((item) => item.id)).toEqual(['b']);
    expect(window.localStorage.getItem('sp-hide-owned')).toBe('1');

    (root.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(hideOwned.filter(items)).toHaveLength(2);
    expect(window.localStorage.getItem('sp-hide-owned')).toBe('0');
  });
});
