import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  PreloadAllModules,
  provideRouter,
  withInMemoryScrolling,
  withPreloading,
} from '@angular/router';
import { prefetchInterceptor } from './core/prefetch/prefetch.service';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { ConfirmationService, MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/** `a` mixed into `b`; PrimeNG keeps the var() references, so tokens follow the theme live. */
const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/** Aura's surface ramp, mapped onto the app's own surface/border/text tokens. */
const lightSurface = {
  0: 'var(--surface-1)',
  50: 'var(--surface-2)',
  100: 'var(--surface-raised)',
  200: 'var(--border-subtle)',
  300: 'var(--border-strong)',
  400: mix('var(--text-muted)', 60, 'var(--border-strong)'),
  500: 'var(--text-muted)',
  600: mix('var(--text-muted)', 50, 'var(--text-primary)'),
  700: 'var(--text-primary)',
  800: mix('var(--text-primary)', 85, 'var(--app-bg)'),
  900: mix('var(--text-primary)', 92, 'var(--app-bg)'),
  950: 'var(--text-primary)',
};

const darkSurface = {
  0: 'var(--text-primary)',
  50: mix('var(--text-primary)', 92, 'var(--surface-1)'),
  100: mix('var(--text-primary)', 84, 'var(--surface-1)'),
  200: mix('var(--text-primary)', 70, 'var(--surface-1)'),
  300: mix('var(--text-muted)', 60, 'var(--text-primary)'),
  400: 'var(--text-muted)',
  500: mix('var(--text-muted)', 55, 'var(--border-strong)'),
  600: mix('var(--border-strong)', 70, 'var(--text-muted)'),
  700: 'var(--border-strong)',
  800: 'var(--surface-elevated)',
  900: 'var(--surface-1)',
  950: 'var(--app-bg)',
};

/**
 * PrimeNG follows the app's theme tokens (Settings → Appearance): primary is
 * the accent, the surface ramp is the theme's surfaces, and corner radius and
 * field padding follow the radius/density choices.
 */
const StashboardPreset = definePreset(Aura, {
  primitive: {
    borderRadius: {
      none: '0',
      xs: 'calc(2px * var(--radius-scale, 1))',
      sm: 'calc(4px * var(--radius-scale, 1))',
      md: 'calc(6px * var(--radius-scale, 1))',
      lg: 'calc(8px * var(--radius-scale, 1))',
      xl: 'calc(12px * var(--radius-scale, 1))',
    },
  },
  semantic: {
    primary: {
      50: mix('var(--accent)', 8, '#ffffff'),
      100: mix('var(--accent)', 18, '#ffffff'),
      200: mix('var(--accent)', 35, '#ffffff'),
      300: mix('var(--accent)', 55, '#ffffff'),
      400: mix('var(--accent)', 78, '#ffffff'),
      500: 'var(--accent)',
      600: mix('var(--accent)', 86, '#000000'),
      700: mix('var(--accent)', 72, '#000000'),
      800: mix('var(--accent)', 58, '#000000'),
      900: mix('var(--accent)', 44, '#000000'),
      950: mix('var(--accent)', 30, '#000000'),
    },
    formField: {
      paddingX: 'calc(0.75rem * var(--density-scale, 1))',
      paddingY: 'calc(0.5rem * var(--density-scale, 1))',
    },
    colorScheme: {
      light: {
        surface: lightSurface,
        primary: {
          color: 'var(--accent)',
          contrastColor: 'var(--accent-contrast)',
          hoverColor: 'var(--accent-hover)',
          activeColor: 'var(--accent-active)',
        },
        highlight: {
          background: mix('var(--accent)', 12, 'transparent'),
          focusBackground: mix('var(--accent)', 18, 'transparent'),
          color: 'var(--accent-text)',
          focusColor: 'var(--accent-text)',
        },
      },
      dark: {
        surface: darkSurface,
        primary: {
          color: 'var(--accent)',
          contrastColor: 'var(--accent-contrast)',
          hoverColor: 'var(--accent-hover)',
          activeColor: 'var(--accent-active)',
        },
        highlight: {
          background: mix('var(--accent)', 20, 'transparent'),
          focusBackground: mix('var(--accent)', 28, 'transparent'),
          color: 'var(--accent-text)',
          focusColor: 'var(--text-primary)',
        },
      },
    },
  },
});

import { authRedirectInterceptor } from './core/interceptors/auth-redirect.interceptor';
import { appLockInterceptor } from './core/interceptors/app-lock.interceptor';
import { catalogProviderInterceptor } from './core/interceptors/catalog-provider.interceptor';
import { ReportingErrorHandler } from './core/logging/client-log';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: ErrorHandler, useClass: ReportingErrorHandler },
    provideRouter(
      routes,
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
      }),
      // Pages load on demand; once the first page is up, fetch the rest quietly
      // in the background so switching pages stays instant.
      withPreloading(PreloadAllModules),
    ),
    provideHttpClient(
      withInterceptors([
        // First, so it sees the URL exactly as the page asked for it.
        prefetchInterceptor,
        catalogProviderInterceptor,
        appLockInterceptor,
        authRedirectInterceptor,
      ]),
    ),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: StashboardPreset,
        options: {
          darkModeSelector: "[data-theme='dark']",
        },
      },
    }),
    MessageService,
    ConfirmationService,
  ],
};
