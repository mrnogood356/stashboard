import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, Routes, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { routes as appRoutes } from '../../app.routes';
import { SettingsPageComponent } from './settings-page.component';
import { SettingsNavItem } from './settings-nav';

@Component({ template: '<p class="section-body">section</p>' })
class StubSectionComponent {}

/** /settings and its children from the real route list, each page stubbed. */
function settingsRoutes(): Routes {
  const shell = appRoutes.find((route) => route.path === '')?.children ?? [];
  const settings = shell.find((route) => route.path === 'settings');
  return [
    {
      path: 'settings',
      component: SettingsPageComponent,
      children: (settings?.children ?? []).map((child) => ({
        path: child.path,
        component: StubSectionComponent,
      })),
    },
    { path: 'elsewhere', component: StubSectionComponent },
  ];
}

async function open(url: string) {
  TestBed.configureTestingModule({ providers: [provideRouter(settingsRoutes())] });
  const harness = await RouterTestingHarness.create(url);
  const root = harness.fixture.nativeElement as HTMLElement;
  const trigger = () =>
    root.querySelector<HTMLButtonElement>('[data-testid="settings-section-picker"]')!;
  const links = () => Array.from(root.querySelectorAll<HTMLAnchorElement>('.settings-nav-link'));
  const openPicker = async () => {
    trigger().click();
    harness.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    harness.detectChanges();
  };
  return { harness, root, trigger, links, openPicker };
}

function navItemsOf(component: SettingsPageComponent): SettingsNavItem[] {
  return (component as unknown as { navItems: SettingsNavItem[] }).navItems;
}

describe('SettingsPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('lists every settings route in the section picker', async () => {
    const { harness } = await open('/settings');
    const component = harness.fixture.debugElement.query(
      (element) => element.componentInstance instanceof SettingsPageComponent,
    ).componentInstance as SettingsPageComponent;
    const navRoutes = navItemsOf(component).map((item) => item.route);
    const childPaths = settingsRoutes()[0]!.children!.map((child) =>
      child.path ? `/settings/${child.path}` : '/settings',
    );
    expect([...navRoutes].sort()).toEqual([...childPaths].sort());
  });

  it('shows the current section in a closed picker instead of a row of tabs', async () => {
    const { root, trigger, links } = await open('/settings/logs');

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().textContent).toContain('Logs');
    expect(trigger().textContent).toContain('System');
    expect(trigger().getAttribute('aria-label')).toBe('Settings section: Logs');
    expect(links()).toHaveLength(0);
    expect(root.querySelector('.section-body')).toBeTruthy();
  });

  it('opens a grouped list of every section, with the current one marked', async () => {
    const { root, trigger, links, openPicker } = await open('/settings/appearance');
    await openPicker();

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const panel = root.querySelector<HTMLElement>(`#${trigger().getAttribute('aria-controls')}`);
    expect(panel?.tagName).toBe('NAV');
    expect(
      Array.from(root.querySelectorAll('.picker-section')).map((section) => ({
        group: section.querySelector('h2')?.textContent?.trim(),
        items: Array.from(section.querySelectorAll('a')).map((a) => a.textContent?.trim()),
      })),
    ).toEqual([
      { group: 'Setup', items: ['Overview', 'Integrations', 'Indexing', 'Setup check'] },
      { group: 'Behaviour', items: ['Notifications', 'Automation', 'Hidden', 'Playback'] },
      { group: 'Look & privacy', items: ['Appearance', 'Privacy', 'Account'] },
      { group: 'System', items: ['About & health', 'Logs'] },
    ]);
    const hrefs = links().map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/settings');
    expect(hrefs).toContain('/settings/integrations');
    expect(hrefs).toContain('/settings/logs');

    const current = links().filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Appearance']);
    expect(document.activeElement).toBe(current[0]);
  });

  it('marks Overview only on /settings itself', async () => {
    const { links, openPicker, trigger } = await open('/settings');
    expect(trigger().textContent).toContain('Overview');
    await openPicker();
    expect(
      links()
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent?.trim()),
    ).toEqual(['Overview']);
  });

  it('moves between sections with the arrow keys, Home and End', async () => {
    const { links, openPicker } = await open('/settings');
    await openPicker();
    const all = links();
    const press = (key: string) =>
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );

    expect(document.activeElement).toBe(all[0]);
    press('ArrowDown');
    expect(document.activeElement).toBe(all[1]);
    press('ArrowUp');
    press('ArrowUp');
    expect(document.activeElement).toBe(all[all.length - 1]);
    press('Home');
    expect(document.activeElement).toBe(all[0]);
    press('End');
    expect(document.activeElement).toBe(all[all.length - 1]);
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { harness, trigger, links, openPicker } = await open('/settings');
    await openPicker();
    links()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    harness.detectChanges();

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(links()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('opens from the keyboard with the down arrow', async () => {
    const { harness, trigger, links } = await open('/settings/hidden');
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    harness.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent?.trim()).toBe('Hidden');
    expect(links().length).toBeGreaterThan(0);
  });

  it('closes on a click outside, and after picking a section', async () => {
    const { harness, trigger, links, openPicker } = await open('/settings');
    await openPicker();
    document.body.click();
    harness.detectChanges();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await openPicker();
    links()
      .find((link) => link.textContent?.trim() === 'Privacy')!
      .click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe('/settings/privacy');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().textContent).toContain('Privacy');
  });
});
