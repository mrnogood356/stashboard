import { AcquisitionService } from '../../core/api/acquisition.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { finalize, merge, of, switchMap, timer } from 'rxjs';
import { catchError, filter } from 'rxjs/operators';
import { AuthService } from '../../core/api/auth.service';
import { ThemeToggleComponent } from '../../shared/theme-toggle/theme-toggle.component';
import { ThemeService } from '../../core/theme/theme.service';
import { ImageObscurationToggleComponent } from '../../shared/image-obscuration-toggle/image-obscuration-toggle.component';
import { RuntimeHealthService } from '../../core/api/runtime-health.service';
import { summarizeRuntimeDegradedState } from '../../core/api/runtime-health.types';
import { SetupService } from '../../core/api/setup.service';
import { SetupStatusStore } from '../../core/api/setup-status.store';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { summarizeDegradedSetupState } from '../../core/api/setup.types';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { QuickSearchComponent } from '../../shared/quick-search/quick-search.component';
import { NavigationHistoryService } from '../../core/navigation/navigation-history.service';

interface ShellDegradedState {
  kind: 'setup' | 'runtime';
  eyebrow: string;
  message: string;
}

interface ShellNavItem {
  label: string;
  route: string;
  icon: string;
  exact: boolean;
  activePrefixes?: readonly string[];
  /** Shown only while Settings → Playback has this turned on. */
  playbackFeature?: 'feed';
}

const HOME_NAV_ITEM: ShellNavItem = {
  label: 'Home',
  route: '/home',
  icon: 'pi pi-home',
  exact: true,
};

const SCENES_NAV_ITEM: ShellNavItem = {
  label: 'Scenes',
  route: '/scenes',
  icon: 'pi pi-video',
  exact: false,
  activePrefixes: ['/scenes', '/scene/'],
};

const ACQUISITION_NAV_ITEM: ShellNavItem = {
  label: 'Requests',
  route: '/acquisition',
  icon: 'pi pi-inbox',
  exact: true,
};

const PROCESSING_NAV_ITEM: ShellNavItem = {
  label: 'Downloads',
  route: '/processing',
  icon: 'pi pi-sync',
  exact: true,
};

const LIBRARY_NAV_ITEM: ShellNavItem = {
  label: 'Library',
  route: '/library',
  icon: 'pi pi-folder-open',
  exact: false,
  activePrefixes: ['/library'],
};

const PERFORMERS_NAV_ITEM: ShellNavItem = {
  label: 'Performers',
  route: '/performers',
  icon: 'pi pi-users',
  exact: false,
  activePrefixes: ['/performers', '/performer/'],
};

const STUDIOS_NAV_ITEM: ShellNavItem = {
  label: 'Studios',
  route: '/studios',
  icon: 'pi pi-building',
  exact: false,
  activePrefixes: ['/studios', '/studio/'],
};

const SETTINGS_NAV_ITEM: ShellNavItem = {
  label: 'Settings',
  route: '/settings',
  icon: 'pi pi-cog',
  exact: false,
};

const SEARCH_NAV_ITEM: ShellNavItem = {
  label: 'Search',
  route: '/search',
  icon: 'pi pi-search',
  exact: true,
};

const FEED_NAV_ITEM: ShellNavItem = {
  label: 'Swipe feed',
  route: '/feed',
  icon: 'pi pi-mobile',
  exact: true,
  playbackFeature: 'feed',
};

const TOOLS_NAV_ITEM: ShellNavItem = {
  label: 'Tools',
  route: '/tools',
  icon: 'pi pi-wrench',
  exact: false,
  activePrefixes: ['/tools'],
};

interface ShellNavGroup {
  /** Shown above the group in the sidebar; none for the first and last. */
  label: string | null;
  items: readonly ShellNavItem[];
}

const DESKTOP_NAV_GROUPS: readonly ShellNavGroup[] = [
  { label: null, items: [HOME_NAV_ITEM, SEARCH_NAV_ITEM] },
  { label: 'Browse', items: [SCENES_NAV_ITEM, PERFORMERS_NAV_ITEM, STUDIOS_NAV_ITEM] },
  { label: 'Your library', items: [LIBRARY_NAV_ITEM, FEED_NAV_ITEM, TOOLS_NAV_ITEM] },
  { label: 'Requests & downloads', items: [ACQUISITION_NAV_ITEM, PROCESSING_NAV_ITEM] },
  { label: null, items: [SETTINGS_NAV_ITEM] },
];

// Requests is checked often, so it gets a tab; Search is one tap from
// Home's header (and first under More).
const MOBILE_PRIMARY_NAV_ITEMS: readonly ShellNavItem[] = [
  HOME_NAV_ITEM,
  SCENES_NAV_ITEM,
  ACQUISITION_NAV_ITEM,
  LIBRARY_NAV_ITEM,
];

const MOBILE_SECONDARY_NAV_ITEMS: readonly ShellNavItem[] = [
  SEARCH_NAV_ITEM,
  PERFORMERS_NAV_ITEM,
  STUDIOS_NAV_ITEM,
  FEED_NAV_ITEM,
  TOOLS_NAV_ITEM,
  PROCESSING_NAV_ITEM,
  SETTINGS_NAV_ITEM,
];

@Component({
  selector: 'app-shell-layout',
  imports: [
    RouterLink,
    RouterOutlet,
    ThemeToggleComponent,
    ImageObscurationToggleComponent,
    QuickSearchComponent,
  ],
  templateUrl: './app-shell-layout.component.html',
  styleUrl: './app-shell-layout.component.scss',
})
export class AppShellLayoutComponent implements OnInit, OnDestroy {
  private static readonly SETUP_STATUS_POLL_INTERVAL_MS = 30_000;
  private static readonly ATTENTION_POLL_INTERVAL_MS = 60_000;
  private static readonly PHONE_SHELL_MEDIA_QUERY = '(max-width: 720px)';
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly setupService = inject(SetupService);
  private readonly acquisitionService = inject(AcquisitionService);
  private readonly runtimeHealthService = inject(RuntimeHealthService);
  private readonly setupStatusStore = inject(SetupStatusStore);
  private readonly notifications = inject(AppNotificationsService);
  private readonly appLock = inject(AppLockService);
  private readonly themeService = inject(ThemeService);
  private readonly playbackSettings = inject(PlaybackSettingsService);
  private readonly navigationHistory = inject(NavigationHistoryService);
  private readonly phoneShellMediaQuery = this.createPhoneShellMediaQuery();
  private readonly phoneShellMediaChangeHandler = (event: MediaQueryListEvent) => {
    this.mobileShell.set(event.matches);
    if (!event.matches) {
      this.moreMenuOpen.set(false);
    }
  };

  protected readonly desktopNavGroups = computed(() =>
    DESKTOP_NAV_GROUPS.map((group) => ({
      label: group.label,
      items: this.visibleNavItems(group.items),
    })).filter((group) => group.items.length > 0),
  );
  protected readonly mobilePrimaryNavItems = computed(() =>
    this.visibleNavItems(MOBILE_PRIMARY_NAV_ITEMS),
  );
  protected readonly mobileSecondaryNavItems = computed(() =>
    this.visibleNavItems(MOBILE_SECONDARY_NAV_ITEMS),
  );
  /** Failed requests and downloads, shown as a count on Requests. */
  protected readonly requestsAttention = signal(0);
  protected readonly collapsed = signal(false);
  protected readonly isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  protected readonly mobileShell = signal(this.phoneShellMediaQuery?.matches ?? false);
  protected readonly moreMenuOpen = signal(false);
  protected readonly loggingOut = signal(false);
  protected readonly currentUrl = signal(this.router.url);
  protected readonly authStatus = this.authService.status;
  protected readonly runtimeHealth = this.runtimeHealthService.status;
  protected readonly degradedState = computed<ShellDegradedState | null>(() => {
    const setupState = summarizeDegradedSetupState(this.setupStatusStore.status());
    if (setupState) {
      return {
        kind: 'setup',
        eyebrow: 'Repair needed',
        message: setupState.message,
      };
    }

    const runtimeState = summarizeRuntimeDegradedState(
      this.runtimeHealth(),
      this.setupStatusStore.status()?.catalogProvider ?? null,
    );
    if (!runtimeState) {
      return null;
    }

    return {
      kind: 'runtime',
      eyebrow: 'Runtime outage',
      message: runtimeState.message,
    };
  });
  protected readonly moreNavActive = computed(() => {
    const currentUrl = this.currentUrl();
    return this.mobileSecondaryNavItems().some((item) => this.matchesNavItem(item, currentUrl));
  });

  ngOnInit(): void {
    // So the back button on More's sections knows where you came from.
    this.navigationHistory.start();
    void this.appLock.refresh();
    // The saved theme may have changed on another device.
    void this.themeService.syncFromServer();
    // Whether Play buttons, previews and the swipe feed are shown.
    void this.playbackSettings.ensureLoaded();
    this.runtimeHealthService.ensureStarted();
    this.currentUrl.set(this.normalizeUrl(this.router.url));

    if (this.phoneShellMediaQuery) {
      this.mobileShell.set(this.phoneShellMediaQuery.matches);
      this.phoneShellMediaQuery.addEventListener('change', this.phoneShellMediaChangeHandler);
    }

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.currentUrl.set(this.normalizeUrl(event.urlAfterRedirects));
        this.moreMenuOpen.set(false);
      });

    merge(
      of(null),
      this.router.events.pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      ),
      timer(
        AppShellLayoutComponent.SETUP_STATUS_POLL_INTERVAL_MS,
        AppShellLayoutComponent.SETUP_STATUS_POLL_INTERVAL_MS,
      ),
    )
      .pipe(
        switchMap(() => this.setupService.getStatus().pipe(catchError(() => of(null)))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((setupStatus) => {
        if (!setupStatus) {
          return;
        }

        this.setupStatusStore.sync(setupStatus);
      });

    merge(
      of(null),
      this.router.events.pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      ),
      timer(
        AppShellLayoutComponent.ATTENTION_POLL_INTERVAL_MS,
        AppShellLayoutComponent.ATTENTION_POLL_INTERVAL_MS,
      ),
    )
      .pipe(
        filter(() => typeof document === 'undefined' || document.visibilityState !== 'hidden'),
        switchMap(() => this.acquisitionService.attention().pipe(catchError(() => of(null)))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((attention) => {
        if (attention) {
          this.requestsAttention.set(Math.max(0, attention.failed));
        }
      });
  }

  ngOnDestroy(): void {
    this.phoneShellMediaQuery?.removeEventListener('change', this.phoneShellMediaChangeHandler);
    this.runtimeHealthService.stop();
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  protected toggleMoreMenu(): void {
    this.moreMenuOpen.update((value) => !value);
  }

  protected closeMoreMenu(): void {
    this.moreMenuOpen.set(false);
  }

  protected isNavItemActive(item: ShellNavItem): boolean {
    return this.matchesNavItem(item, this.currentUrl());
  }

  protected logout(): void {
    if (this.loggingOut()) {
      return;
    }

    this.loggingOut.set(true);

    this.authService
      .logout()
      .pipe(
        finalize(() => {
          this.loggingOut.set(false);
        }),
      )
      .subscribe({
        next: () => {
          this.notifications.info('Signed out');
          void this.router.navigateByUrl('/login');
        },
        error: () => {
          this.authService.clearStatus();
          void this.router.navigateByUrl('/login');
        },
      });
  }

  /** Hides entries for playback features turned off in Settings → Playback. */
  private visibleNavItems(items: readonly ShellNavItem[]): readonly ShellNavItem[] {
    const feed = this.playbackSettings.feedEnabled();
    return items.filter((item) => item.playbackFeature !== 'feed' || feed);
  }

  private createPhoneShellMediaQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return null;
    }

    return window.matchMedia(AppShellLayoutComponent.PHONE_SHELL_MEDIA_QUERY);
  }

  private matchesNavItem(item: ShellNavItem, currentUrl: string): boolean {
    const normalizedUrl = this.normalizeUrl(currentUrl);
    if (item.exact) {
      return normalizedUrl === item.route;
    }

    const activePrefixes = item.activePrefixes?.length ? item.activePrefixes : [item.route];
    return activePrefixes.some((prefix) => this.matchesRoutePrefix(normalizedUrl, prefix));
  }

  private matchesRoutePrefix(url: string, prefix: string): boolean {
    if (prefix.endsWith('/')) {
      return url.startsWith(prefix);
    }

    return url === prefix || url.startsWith(`${prefix}/`);
  }

  private normalizeUrl(url: string): string {
    return url.split('?')[0]?.split('#')[0] || '/';
  }
}
