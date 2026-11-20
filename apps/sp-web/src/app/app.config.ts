import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling, withPreloading } from '@angular/router';
import { prefetchInterceptor } from './core/prefetch/prefetch.service';
import { IdlePreloading } from './core/navigation/idle-preloading';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { ConfirmationService, MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import AuraBase from '@primeuix/themes/aura/base';
import auraCss from '@primeuix/themes/aura/css';
import type { ExtendedCSS } from '@primeuix/themes/types';
import badge from '@primeuix/themes/aura/badge';
import button from '@primeuix/themes/aura/button';
import checkbox from '@primeuix/themes/aura/checkbox';
import chip from '@primeuix/themes/aura/chip';
import confirmdialog from '@primeuix/themes/aura/confirmdialog';
import dialog from '@primeuix/themes/aura/dialog';
import iconfield from '@primeuix/themes/aura/iconfield';
import inputtext from '@primeuix/themes/aura/inputtext';
import message from '@primeuix/themes/aura/message';
import multiselect from '@primeuix/themes/aura/multiselect';
import progressspinner from '@primeuix/themes/aura/progressspinner';
import ripple from '@primeuix/themes/aura/ripple';
import select from '@primeuix/themes/aura/select';
import toast from '@primeuix/themes/aura/toast';
import toggleswitch from '@primeuix/themes/aura/toggleswitch';
import tooltip from '@primeuix/themes/aura/tooltip';
import virtualscroller from '@primeuix/themes/aura/virtualscroller';

/**
 * Aura with only the components the app uses, and the ones they use inside
 * (a multiselect's checkboxes and chips, a confirm dialog's dialog, a select's
 * scroller). The full `@primeuix/themes/aura` carries settings for about 90
 * components and was the largest single piece of the first page load. A
 * PrimeNG component added later needs its entry here, or it shows unstyled.
 */
const Aura = {
  ...AuraBase,
  components: {
    badge,
    button,
    checkbox,
    chip,
    confirmdialog,
    dialog,
    iconfield,
    inputtext,
    message,
    multiselect,
    progressspinner,
    ripple,
    select,
    toast,
    toggleswitch,
    tooltip,
    virtualscroller,
  },
  // The module's default export is the CSS string; its typings only declare a named export.
  css: auraCss as unknown as ExtendedCSS,
};

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
      // in the background, in quiet moments, so switching pages stays instant.
      withPreloading(IdlePreloading),
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
      // Dropdown menus open at the page's top level. Inside a panel they're
      // placed against it, and with Glass (backdrop-filter) that put them in
      // the wrong spot for a moment before they jumped into place.
      overlayAppendTo: 'body',
      // Dropdowns above the app's sheets (1100–1101), so a select inside a
      // sheet opens over it rather than behind it.
      zIndex: { modal: 1100, overlay: 1200, menu: 1200, tooltip: 1300 },
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
