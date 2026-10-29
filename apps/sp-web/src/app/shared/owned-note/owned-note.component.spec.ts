import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HideOwnedService } from '../../core/preferences/hide-owned.service';
import { OwnedNoteComponent } from './owned-note.component';

describe('OwnedNoteComponent', () => {
  const hideOwned = signal(true);

  async function render(total: number, owned: number) {
    await TestBed.configureTestingModule({
      imports: [OwnedNoteComponent],
      providers: [provideRouter([]), { provide: HideOwnedService, useValue: { hideOwned } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(OwnedNoteComponent);
    fixture.componentRef.setInput('total', total);
    fixture.componentRef.setInput('owned', owned);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('explains an empty list when every scene in it is one you have', async () => {
    hideOwned.set(true);
    const root = await render(4, 4);
    expect(root.textContent).toContain('You already have every scene here.');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/settings/hidden');
  });

  it('says nothing otherwise', async () => {
    hideOwned.set(true);
    expect((await render(4, 2)).textContent?.trim()).toBe('');
    TestBed.resetTestingModule();
    hideOwned.set(false);
    expect((await render(4, 4)).textContent?.trim()).toBe('');
  });
});
