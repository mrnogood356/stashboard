import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPageComponent } from './settings-page.component';

describe('SettingsPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders explicit navigation for each settings subsection', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPageComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(SettingsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const navLinks = Array.from(
      fixture.nativeElement.querySelectorAll('.settings-nav-link') as NodeListOf<HTMLAnchorElement>,
    );

    expect(navLinks.map((link) => link.textContent?.trim())).toEqual([
      'Overview',
      'Integrations',
      'Indexing',
      'Notifications',
      'Automation',
      'Hidden',
      'Setup check',
      'Appearance',
      'Playback',
      'Privacy',
      'Account',
      'About & health',
      'Logs',
    ]);
    expect(navLinks[0]?.getAttribute('href')).toContain('/settings');
    expect(navLinks[1]?.getAttribute('href')).toContain('/settings/integrations');
    expect(navLinks[2]?.getAttribute('href')).toContain('/settings/indexing');
    expect(navLinks[3]?.getAttribute('href')).toContain('/settings/notifications');
    expect(navLinks[4]?.getAttribute('href')).toContain('/settings/automation');
    expect(navLinks[5]?.getAttribute('href')).toContain('/settings/hidden');
    expect(navLinks[6]?.getAttribute('href')).toContain('/settings/setup-check');
    expect(navLinks[7]?.getAttribute('href')).toContain('/settings/appearance');
    expect(navLinks[8]?.getAttribute('href')).toContain('/settings/playback');
    expect(navLinks[9]?.getAttribute('href')).toContain('/settings/privacy');
    expect(navLinks[10]?.getAttribute('href')).toContain('/settings/account');
    expect(navLinks[11]?.getAttribute('href')).toContain('/settings/about');
    expect(navLinks[12]?.getAttribute('href')).toContain('/settings/logs');
  });
});
