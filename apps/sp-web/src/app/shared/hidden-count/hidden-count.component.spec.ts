import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiddenCountComponent } from './hidden-count.component';

describe('HiddenCountComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(count: number, showing: boolean) {
    await TestBed.configureTestingModule({
      imports: [HiddenCountComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(HiddenCountComponent);
    fixture.componentRef.setInput('count', count);
    fixture.componentRef.setInput('showing', showing);
    const toggled = vi.fn();
    fixture.componentInstance.toggled.subscribe(toggled);
    fixture.detectChanges();
    return { root: fixture.nativeElement as HTMLElement, toggled };
  }

  it('shows nothing while nothing is hidden', async () => {
    const { root } = await render(0, false);

    expect(root.querySelector('[data-testid="hidden-count"]')).toBeNull();
  });

  it('says how many are hidden and offers to show them', async () => {
    const { root, toggled } = await render(3, false);

    expect(root.textContent).toContain('Hiding 3 scenes');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/settings/hidden');
    (root.querySelector('button') as HTMLButtonElement).click();
    expect(toggled).toHaveBeenCalledWith(true);
  });

  it('uses the singular for one scene', async () => {
    const { root } = await render(1, false);

    expect(root.textContent).toContain('Hiding 1 scene');
    expect(root.textContent).not.toContain('Hiding 1 scenes');
  });

  it('offers to hide them again while they are shown', async () => {
    const { root, toggled } = await render(0, true);

    expect(root.textContent).toContain('Showing hidden scenes');
    const button = root.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Hide again');
    button.click();
    expect(toggled).toHaveBeenCalledWith(false);
  });
});
