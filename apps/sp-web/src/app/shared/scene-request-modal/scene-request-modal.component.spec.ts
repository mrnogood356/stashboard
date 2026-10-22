import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneRequestModalComponent } from './scene-request-modal.component';

@Component({ template: '' })
class StubPageComponent {}

const options = {
  scene: { stashId: 'scene-1', title: 'Scene', studio: null },
  defaults: { monitored: true, searchForMovie: true },
  rootFolders: [{ id: 1, path: '/data/whisparr', accessible: true }],
  qualityProfiles: [{ id: 3, name: 'Any' }],
  tags: [],
};

describe('SceneRequestModalComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function create(
    submitSceneRequest: ReturnType<typeof vi.fn>,
    getOwnedCopies = vi.fn().mockReturnValue(of({ copies: [] })),
  ) {
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [SceneRequestModalComponent],
      providers: [
        provideRouter([{ path: '**', component: StubPageComponent }]),
        {
          provide: DiscoverService,
          useValue: {
            getSceneRequestOptions: vi.fn().mockReturnValue(of(options)),
            getOwnedCopies,
            submitSceneRequest,
          },
        },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SceneRequestModalComponent);
    const component = fixture.componentInstance as any;
    component.open = true;
    component.sceneId = 'scene-1';
    component.ngOnChanges();
    return { component, notifications, fixture, getOwnedCopies };
  }

  const ownedCopy = {
    reason: 'FINGERPRINT' as const,
    stashSceneId: '42',
    title: 'My copy',
    studio: 'Studio',
    date: '2024-05-01',
    path: '/library/my-copy.mp4',
    imageUrl: '/api/media/stash/scenes/42/screenshot?v=1&w=480',
    whisparrUrl: null,
  };

  it('fills in Whisparr’s defaults and submits the request', async () => {
    const submit = vi.fn().mockReturnValue(of({ accepted: true, alreadyExists: false }));
    const { component, notifications } = await create(submit);

    component.submitRequest();

    expect(submit).toHaveBeenCalledWith('scene-1', {
      monitored: true,
      rootFolderPath: '/data/whisparr',
      searchForMovie: true,
      qualityProfileId: 3,
      tags: [],
    });
    expect(notifications.success).toHaveBeenCalled();
  });

  it('shows the reason the API gives when a request fails', async () => {
    const { component } = await create(
      vi.fn().mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 409,
              error: { message: 'Whisparr already has this scene.' },
            }),
        ),
      ),
    );

    component.submitRequest();

    expect(component.requestSubmitError()).toBe('Whisparr already has this scene.');
  });

  it('warns about a copy you already have before showing the form', async () => {
    const submit = vi.fn();
    const { fixture, getOwnedCopies } = await create(
      submit,
      vi.fn().mockReturnValue(of({ copies: [ownedCopy] })),
    );
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(getOwnedCopies).toHaveBeenCalledWith('scene-1');
    expect(element.textContent).toContain('You may already have this');
    expect(element.textContent).toContain('/library/my-copy.mp4');
    expect(element.textContent).toContain('Same file fingerprint');
    expect(element.querySelector('a.open')?.getAttribute('href')).toBe('/library/scene/42');
    expect(element.querySelector('form')).toBeNull();

    const proceed = element.querySelector('button.proceed') as HTMLButtonElement;
    expect(proceed.textContent).toContain('Request anyway');
    proceed.click();
    fixture.detectChanges();

    expect(element.querySelector('[data-testid="owned-copies"]')).toBeNull();
    expect(element.querySelector('form')).not.toBeNull();
  });

  it('closes when you open the copy you have', async () => {
    const { component, fixture } = await create(
      vi.fn(),
      vi.fn().mockReturnValue(of({ copies: [ownedCopy] })),
    );
    const closed = vi.fn();
    component.closed.subscribe(closed);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('a.open') as HTMLAnchorElement).click();
    await fixture.whenStable();

    expect(closed).toHaveBeenCalled();
  });

  it('shows the form as usual when the check fails', async () => {
    const { component, fixture } = await create(
      vi.fn(),
      vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    );
    fixture.detectChanges();

    expect(component.showOwnedWarning()).toBe(false);
    expect(component.ownedChecking()).toBe(false);
    expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
  });

  it('asks again each time it opens, without checking the same scene twice', async () => {
    const { component, getOwnedCopies } = await create(
      vi.fn(),
      vi.fn().mockReturnValue(of({ copies: [ownedCopy] })),
    );
    component.requestAnyway();
    expect(component.showOwnedWarning()).toBe(false);

    component.open = false;
    component.ngOnChanges();
    component.open = true;
    component.ngOnChanges();

    expect(component.showOwnedWarning()).toBe(true);
    expect(getOwnedCopies).toHaveBeenCalledTimes(1);
  });
});
