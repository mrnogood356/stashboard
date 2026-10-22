import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Routes, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { routes as appRoutes } from '../../app.routes';
import { SettingsPageComponent } from './settings-page.component';
import { SETTINGS_SECTIONS } from './settings-nav';

@Component({ template: '<p class="section-body">section</p>' })
class StubSectionComponent {}

function realSettingsChildren(): Routes {
  const shell = appRoutes.find((route) => route.path === '')?.children ?? [];
  return shell.find((route) => route.path === 'settings')?.children ?? [];
}

/** /settings and its children from the real route list, each page stubbed. */
function settingsRoutes(): Routes {
  return [
    {
      path: 'settings',
      component: SettingsPageComponent,
      children: realSettingsChildren().map((child) => ({
        path: child.path,
        component: StubSectionComponent,
      })),
    },
  ];
}

async function open(url: string) {
  TestBed.configureTestingModule({ providers: [provideRouter(settingsRoutes())] });
  const harness = await RouterTestingHarness.create(url);
  return { harness, root: harness.fixture.nativeElement as HTMLElement };
}

describe('SettingsPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('has a card for every settings section and no card without a page', () => {
    const routes = realSettingsChildren()
      .map((route) => route.path)
      .filter((path) => path !== '')
      .map((path) => `/settings/${path}`);
    expect(SETTINGS_SECTIONS.map((section) => section.route).sort()).toEqual([...routes].sort());
    for (const section of SETTINGS_SECTIONS) {
      expect(section.icon, section.label).toBeTruthy();
      expect(section.detail, section.label).toBeTruthy();
    }
  });

  it('shows the Settings heading on the main page, with no back link', async () => {
    const { root } = await open('/settings');
    expect(root.querySelector('h1')?.textContent).toContain('Settings');
    expect(root.querySelector('.back-link')).toBeNull();
    expect(root.querySelector('.section-body')).not.toBeNull();
  });

  it('shows a back link to Settings instead of the heading inside a section', async () => {
    const { root } = await open('/settings/logs');
    const back = root.querySelector<HTMLAnchorElement>('.back-link');
    expect(back?.textContent?.trim()).toBe('Settings');
    expect(back?.getAttribute('href')).toBe('/settings');
    expect(root.querySelector('h1')).toBeNull();
  });

  it('switches between the two as you move around', async () => {
    const { harness, root } = await open('/settings/appearance');
    expect(root.querySelector('.back-link')).not.toBeNull();
    await harness.navigateByUrl('/settings');
    expect(root.querySelector('.back-link')).toBeNull();
    expect(root.querySelector('h1')).not.toBeNull();
    await harness.navigateByUrl('/settings/about?tab=x');
    expect(root.querySelector('.back-link')).not.toBeNull();
  });
});
