import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { HideToggleComponent } from './hide-toggle.component';

describe('HideToggleComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  const empty = { words: [], tags: [], studios: [], performers: [] };

  async function render(itemId: string | null = 'studio-1') {
    const notifications = { success: vi.fn(), error: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [HideToggleComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(HideToggleComponent);
    fixture.componentRef.setInput('kind', 'studio');
    fixture.componentRef.setInput('itemId', itemId);
    fixture.componentRef.setInput('name', 'Some Studio');
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    return { fixture, http, notifications, root: fixture.nativeElement as HTMLElement };
  }

  it('hides the studio, then shows it again', async () => {
    const { fixture, http, notifications, root } = await render();
    http.expectOne('/api/hidden-content/settings').flush(empty);
    fixture.detectChanges();

    const button = root.querySelector('[data-testid="hide-studio"]') as HTMLButtonElement;
    expect(button.textContent).toContain('Hide this studio');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.click();
    const hide = http.expectOne('/api/hidden-content/hide');
    expect(hide.request.body).toEqual({ kind: 'studio', id: 'studio-1', name: 'Some Studio' });
    hide.flush({ ...empty, studios: [{ id: 'studio-1', name: 'Some Studio' }] });
    fixture.detectChanges();

    expect(button.textContent).toContain('Hidden');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(notifications.success).toHaveBeenCalledWith('Hiding Some Studio', expect.any(String));

    button.click();
    const unhide = http.expectOne('/api/hidden-content/unhide');
    expect(unhide.request.body).toEqual({ kind: 'studio', id: 'studio-1' });
    unhide.flush(empty);
    fixture.detectChanges();

    expect(button.textContent).toContain('Hide this studio');
    http.verify();
  });

  it('says when the change could not be saved', async () => {
    const { fixture, http, notifications, root } = await render();
    http.expectOne('/api/hidden-content/settings').flush(empty);
    fixture.detectChanges();

    (root.querySelector('button') as HTMLButtonElement).click();
    http
      .expectOne('/api/hidden-content/hide')
      .flush({ message: 'down' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(notifications.error).toHaveBeenCalled();
    expect((root.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows nothing without an id', async () => {
    const { root } = await render(null);

    expect(root.querySelector('button')).toBeNull();
  });
});
