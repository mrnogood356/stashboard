import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { ToolsPageComponent } from './tools-page.component';

async function render(library: Record<string, unknown>) {
  await TestBed.configureTestingModule({
    imports: [ToolsPageComponent],
    providers: [provideRouter([]), { provide: LocalLibraryService, useValue: library }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ToolsPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function tool(root: HTMLElement, title: string): HTMLAnchorElement {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a.tool')).find(
    (link) => link.querySelector('.tool-title')?.textContent?.trim() === title,
  )!;
}

function detail(root: HTMLElement, title: string): string {
  return (tool(root, title).querySelector('.tool-detail')?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('ToolsPageComponent', () => {
  it('shows what needs fixing and how many jobs are running', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 3, untagged: 2, unorganized: 1 })),
      jobs: vi.fn().mockReturnValue(of([{ id: '1' }, { id: '2' }])),
    };
    const root = await render(library);

    expect(detail(root, 'Fix my library')).toBe('3 not matched · 2 without tags · 1 not organized');
    expect(detail(root, 'Match & rename')).toContain('3 not matched');
    expect(detail(root, 'Stash jobs')).toBe('2 jobs running');
    expect(tool(root, 'Fix my library').getAttribute('href')).toBe('/tools/fix');
    expect(tool(root, 'Duplicates').getAttribute('href')).toBe('/tools/duplicates');
    expect(tool(root, 'Samples').getAttribute('href')).toBe('/tools/samples');
    expect(tool(root, 'Stash jobs').getAttribute('href')).toBe('/tools/jobs');
  });

  it('says all clear and idle when there is nothing to do', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 0, untagged: 0, unorganized: 0 })),
      jobs: vi.fn().mockReturnValue(of([])),
    };
    const root = await render(library);

    expect(detail(root, 'Fix my library')).toBe('All clear');
    expect(detail(root, 'Match & rename')).toContain('Every scene is matched');
    expect(detail(root, 'Stash jobs')).toBe('Stash is idle');
  });

  it('uses singular wording for one job', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 0, untagged: 0, unorganized: 0 })),
      jobs: vi.fn().mockReturnValue(of([{ id: '1' }])),
    };
    const root = await render(library);

    expect(detail(root, 'Stash jobs')).toBe('1 job running');
  });

  it('falls back to plain descriptions when Stash cannot be reached', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      jobs: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    };
    const root = await render(library);

    expect(detail(root, 'Fix my library')).toBe('Scenes that need matching, tags or a check');
    expect(detail(root, 'Stash jobs')).toBe('Scan, Generate, Identify, Auto tag and Clean up');
  });
});
