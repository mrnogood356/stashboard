import { Routes } from '@angular/router';
import {
  bootstrapOnlyWhenRequiredGuard,
  loginOnlyWhenLoggedOutGuard,
  requireAuthenticatedGuard,
} from './core/guards/auth-route.guard';
import { requireFeedGuard, requirePlaybackGuard } from './core/guards/playback-route.guard';
import {
  requireSetupCompleteGuard,
  setupOnlyWhenIncompleteGuard,
} from './core/guards/setup-route.guard';
import { AppShellLayoutComponent } from './layouts/app-shell-layout/app-shell-layout.component';

export const routes: Routes = [
  {
    path: 'bootstrap',
    loadComponent: () =>
      import('./features/auth/bootstrap-page.component').then((m) => m.BootstrapPageComponent),
    canActivate: [bootstrapOnlyWhenRequiredGuard],
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./features/auth/login-page.component').then((m) => m.LoginPageComponent),
    canActivate: [loginOnlyWhenLoggedOutGuard],
  },
  {
    path: 'setup',
    loadComponent: () =>
      import('./features/setup/setup-page.component').then((m) => m.SetupPageComponent),
    canActivate: [requireAuthenticatedGuard, setupOnlyWhenIncompleteGuard],
  },
  {
    // Full-screen player, outside the app shell (no navigation bars).
    path: 'watch/:sceneId',
    canActivate: [requireAuthenticatedGuard, requireSetupCompleteGuard, requirePlaybackGuard],
    loadComponent: () =>
      import('./pages/watch/watch-page.component').then((m) => m.WatchPageComponent),
  },
  {
    // Full-screen swipe feed of preview clips, outside the app shell.
    path: 'feed',
    canActivate: [requireAuthenticatedGuard, requireSetupCompleteGuard, requireFeedGuard],
    loadComponent: () =>
      import('./pages/feed/feed-page.component').then((m) => m.FeedPageComponent),
  },
  {
    path: '',
    component: AppShellLayoutComponent,
    canActivate: [requireAuthenticatedGuard, requireSetupCompleteGuard],
    children: [
      {
        path: 'home',
        loadComponent: () =>
          import('./pages/home/home-page.component').then((module) => module.HomePageComponent),
      },
      {
        path: 'scene/:stashId',
        loadComponent: () =>
          import('./pages/scene/scene-page.component').then((m) => m.ScenePageComponent),
      },
      {
        path: 'tools',
        loadComponent: () =>
          import('./pages/tools/tools-page.component').then((m) => m.ToolsPageComponent),
      },
      {
        path: 'tools/activity',
        loadComponent: () =>
          import('./pages/tools/activity-page.component').then((m) => m.ActivityPageComponent),
      },
      {
        path: 'tools/fix',
        loadComponent: () =>
          import('./pages/tools/fix-library-page.component').then((m) => m.FixLibraryPageComponent),
      },
      {
        path: 'tools/organize',
        loadComponent: () =>
          import('./pages/tools/organize-page.component').then((m) => m.OrganizePageComponent),
      },
      {
        path: 'tools/jobs',
        loadComponent: () =>
          import('./pages/tools/stash-jobs-page.component').then((m) => m.StashJobsPageComponent),
      },
      {
        path: 'tools/samples',
        loadComponent: () =>
          import('./pages/tools/samples-page.component').then((m) => m.SamplesPageComponent),
      },
      {
        path: 'tools/duplicates',
        loadComponent: () =>
          import('./pages/tools/duplicates-page.component').then((m) => m.DuplicatesPageComponent),
      },
      {
        path: 'search',
        loadComponent: () =>
          import('./pages/search/search-page.component').then((m) => m.SearchPageComponent),
      },
      {
        path: 'scenes',
        loadComponent: () =>
          import('./pages/scenes/scenes-page.component').then((m) => m.ScenesPageComponent),
      },
      {
        path: 'acquisition',
        loadComponent: () =>
          import('./pages/acquisition/acquisition-page.component').then(
            (m) => m.AcquisitionPageComponent,
          ),
      },
      {
        // Downloads and drop-ins on their way into the library.
        path: 'processing',
        loadComponent: () =>
          import('./pages/processing/processing-page.component').then(
            (m) => m.ProcessingPageComponent,
          ),
      },
      {
        // A scene in your own Stash library: details and a Play button.
        path: 'library/scene/:sceneId',
        loadComponent: () =>
          import('./pages/local-scene/local-scene-page.component').then(
            (m) => m.LocalScenePageComponent,
          ),
      },
      {
        path: 'library/performer/:id',
        data: { kind: 'performer' },
        loadComponent: () =>
          import('./pages/local-collection/local-collection-page.component').then(
            (m) => m.LocalCollectionPageComponent,
          ),
      },
      {
        path: 'library/studio/:id',
        data: { kind: 'studio' },
        loadComponent: () =>
          import('./pages/local-collection/local-collection-page.component').then(
            (m) => m.LocalCollectionPageComponent,
          ),
      },
      {
        path: 'library',
        loadComponent: () =>
          import('./pages/library/library-page.component').then((m) => m.LibraryPageComponent),
      },
      {
        path: 'performers',
        loadComponent: () =>
          import('./pages/performers/performers-page.component').then(
            (m) => m.PerformersPageComponent,
          ),
      },
      {
        path: 'studios',
        loadComponent: () =>
          import('./pages/studios/studios-page.component').then((m) => m.StudiosPageComponent),
      },
      {
        path: 'performer/:performerId',
        loadComponent: () =>
          import('./pages/performer/performer-page.component').then(
            (m) => m.PerformerPageComponent,
          ),
      },
      {
        path: 'studio/:studioId',
        loadComponent: () =>
          import('./pages/studio/studio-page.component').then((m) => m.StudioPageComponent),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/settings/settings-page.component').then((m) => m.SettingsPageComponent),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./pages/settings/settings-overview-page.component').then(
                (m) => m.SettingsOverviewPageComponent,
              ),
          },
          {
            path: 'integrations',
            loadComponent: () =>
              import('./pages/settings/settings-integrations-page.component').then(
                (m) => m.SettingsIntegrationsPageComponent,
              ),
          },
          {
            path: 'indexing',
            loadComponent: () =>
              import('./pages/settings/indexing-settings-page.component').then(
                (m) => m.IndexingSettingsPageComponent,
              ),
          },
          {
            path: 'notifications',
            loadComponent: () =>
              import('./pages/settings/settings-notifications-page.component').then(
                (m) => m.SettingsNotificationsPageComponent,
              ),
          },
          {
            path: 'automation',
            loadComponent: () =>
              import('./pages/settings/settings-automation-page.component').then(
                (m) => m.SettingsAutomationPageComponent,
              ),
          },
          {
            path: 'hidden',
            loadComponent: () =>
              import('./pages/settings/settings-hidden-page.component').then(
                (m) => m.SettingsHiddenPageComponent,
              ),
          },
          {
            path: 'setup-check',
            loadComponent: () =>
              import('./pages/settings/settings-setup-check-page.component').then(
                (m) => m.SettingsSetupCheckPageComponent,
              ),
          },
          {
            path: 'appearance',
            loadComponent: () =>
              import('./pages/settings/settings-appearance-page.component').then(
                (m) => m.SettingsAppearancePageComponent,
              ),
          },
          {
            path: 'playback',
            loadComponent: () =>
              import('./pages/settings/settings-playback-page.component').then(
                (m) => m.SettingsPlaybackPageComponent,
              ),
          },
          {
            path: 'privacy',
            loadComponent: () =>
              import('./pages/settings/settings-privacy-page.component').then(
                (m) => m.SettingsPrivacyPageComponent,
              ),
          },
          {
            path: 'account',
            loadComponent: () =>
              import('./pages/settings/settings-account-page.component').then(
                (m) => m.SettingsAccountPageComponent,
              ),
          },
          {
            path: 'about',
            loadComponent: () =>
              import('./pages/settings/settings-about-page.component').then(
                (m) => m.SettingsAboutPageComponent,
              ),
          },
          {
            path: 'logs',
            loadComponent: () =>
              import('./pages/settings/settings-logs-page.component').then(
                (m) => m.SettingsLogsPageComponent,
              ),
          },
        ],
      },
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'home',
      },
    ],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
