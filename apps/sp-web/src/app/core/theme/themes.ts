/**
 * The built-in themes. Each is a small palette; theme-tokens.ts turns it into
 * the full set of CSS custom properties every page and PrimeNG use.
 * Keep the ids in step with the API (appearance.dto.ts).
 */

export type ColorScheme = 'light' | 'dark';

export interface ThemePalette {
  /** Page background behind everything (and the phone status bar). */
  appBg: string;
  /** Cards and panels. */
  surface1: string;
  /** Inset areas inside cards: fields, tiles. */
  surface2: string;
  /** Menus, dialogs, raised controls. */
  elevated: string;
  /** Chips, hovered rows, pressed states. */
  raised: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  borderSubtle: string;
  borderStrong: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  description: string;
  scheme: ColorScheme;
  palette: ThemePalette;
  /**
   * The stylesheet already holds this theme's full token set (Light and Dark),
   * so only the palette is written; nothing is derived.
   */
  builtIn?: boolean;
}

export const LIGHT_THEMES: readonly ThemeDefinition[] = [
  {
    id: 'light',
    label: 'Light',
    description: 'Clean iOS-style light.',
    scheme: 'light',
    builtIn: true,
    palette: {
      appBg: '#f2f2f7',
      surface1: '#ffffff',
      surface2: '#f7f7fa',
      elevated: '#ffffff',
      raised: '#ebebf0',
      text: '#1c1c1e',
      textSecondary: '#3a3a3f',
      textMuted: '#6c6c72',
      borderSubtle: '#e5e5ea',
      borderStrong: '#c7c7cc',
      accent: '#007aff',
      success: '#34c759',
      warning: '#ff9500',
      danger: '#d70015',
      info: '#30b0c7',
    },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    description: 'Soft pastel light with mauve.',
    scheme: 'light',
    palette: {
      appBg: '#e6e9ef',
      surface1: '#eff1f5',
      surface2: '#e8ebf1',
      elevated: '#f7f8fa',
      raised: '#dce0e8',
      text: '#4c4f69',
      textSecondary: '#525570',
      textMuted: '#5c5f77',
      borderSubtle: '#dce0e8',
      borderStrong: '#bcc0cc',
      accent: '#8839ef',
      success: '#40a02b',
      warning: '#df8e1d',
      danger: '#d20f39',
      info: '#04a5e5',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    description: 'Warm parchment with calm blue.',
    scheme: 'light',
    palette: {
      appBg: '#eee8d5',
      surface1: '#fdf6e3',
      surface2: '#f6efda',
      elevated: '#fffbee',
      raised: '#eae3cc',
      text: '#073642',
      textSecondary: '#3b5660',
      textMuted: '#5d7178',
      borderSubtle: '#e6dfc8',
      borderStrong: '#cfc7ad',
      accent: '#268bd2',
      success: '#859900',
      warning: '#b58900',
      danger: '#dc322f',
      info: '#2aa198',
    },
  },
];

export const DARK_THEMES: readonly ThemeDefinition[] = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'The classic Stashboard dark.',
    scheme: 'dark',
    builtIn: true,
    palette: {
      appBg: '#0b0b0d',
      surface1: '#151517',
      surface2: '#1b1b1e',
      elevated: '#212125',
      raised: '#2a2a2f',
      text: '#f5f5f7',
      textSecondary: '#d1d1d6',
      textMuted: '#9a9aa2',
      borderSubtle: '#242428',
      borderStrong: '#3a3a40',
      accent: '#0a84ff',
      success: '#30d158',
      warning: '#ff9f0a',
      danger: '#ff6961',
      info: '#64d2ff',
    },
  },
  {
    id: 'oled',
    label: 'OLED Black',
    description: 'Pure black. Easy on iPhone batteries.',
    scheme: 'dark',
    palette: {
      appBg: '#000000',
      surface1: '#0b0b0c',
      surface2: '#111113',
      elevated: '#161618',
      raised: '#1f1f22',
      text: '#f5f5f7',
      textSecondary: '#d1d1d6',
      textMuted: '#8e8e93',
      borderSubtle: '#1c1c1e',
      borderStrong: '#2c2c2e',
      accent: '#0a84ff',
      success: '#30d158',
      warning: '#ff9f0a',
      danger: '#ff453a',
      info: '#64d2ff',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight Blue',
    description: 'Deep navy with a bright blue.',
    scheme: 'dark',
    palette: {
      appBg: '#0b1220',
      surface1: '#111a2e',
      surface2: '#152036',
      elevated: '#1a2640',
      raised: '#22304f',
      text: '#e6edf7',
      textSecondary: '#c3cfe2',
      textMuted: '#8fa1bd',
      borderSubtle: '#1c2840',
      borderStrong: '#2f3f61',
      accent: '#5b9dff',
      success: '#3fcf8e',
      warning: '#f5b544',
      danger: '#ff6b6b',
      info: '#5ad1e6',
    },
  },
  {
    id: 'plex',
    label: 'Charcoal & Amber',
    description: 'Media-server charcoal with amber.',
    scheme: 'dark',
    palette: {
      appBg: '#18191b',
      surface1: '#202225',
      surface2: '#25282b',
      elevated: '#2b2e32',
      raised: '#33373b',
      text: '#eeeeee',
      textSecondary: '#cfcfcf',
      textMuted: '#a0a0a0',
      borderSubtle: '#2a2d31',
      borderStrong: '#42464c',
      accent: '#e5a00d',
      success: '#5fd068',
      warning: '#ff8c42',
      danger: '#ff6b6b',
      info: '#4fc3f7',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    description: 'Arctic slate with frost blue.',
    scheme: 'dark',
    palette: {
      appBg: '#242933',
      surface1: '#2e3440',
      surface2: '#333a47',
      elevated: '#3b4252',
      raised: '#434c5e',
      text: '#eceff4',
      textSecondary: '#d8dee9',
      textMuted: '#a7b1c2',
      borderSubtle: '#3b4252',
      borderStrong: '#4c566a',
      accent: '#88c0d0',
      success: '#a3be8c',
      warning: '#ebcb8b',
      danger: '#bf616a',
      info: '#81a1c1',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    description: 'Purple-tinted dark with vivid accents.',
    scheme: 'dark',
    palette: {
      appBg: '#21222c',
      surface1: '#282a36',
      surface2: '#2d2f3d',
      elevated: '#343746',
      raised: '#3c3f51',
      text: '#f8f8f2',
      textSecondary: '#dcdce4',
      textMuted: '#9ea8c7',
      borderSubtle: '#343746',
      borderStrong: '#44475a',
      accent: '#bd93f9',
      success: '#50fa7b',
      warning: '#ffb86c',
      danger: '#ff5555',
      info: '#8be9fd',
    },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Cosy pastel dark with mauve.',
    scheme: 'dark',
    palette: {
      appBg: '#181825',
      surface1: '#1e1e2e',
      surface2: '#232334',
      elevated: '#2a2b3d',
      raised: '#313244',
      text: '#cdd6f4',
      textSecondary: '#bac2de',
      textMuted: '#a6adc8',
      borderSubtle: '#2a2b3d',
      borderStrong: '#45475a',
      accent: '#cba6f7',
      success: '#a6e3a1',
      warning: '#fab387',
      danger: '#f38ba8',
      info: '#89dceb',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    description: 'Teal-black with calm blue.',
    scheme: 'dark',
    palette: {
      appBg: '#00212b',
      surface1: '#002b36',
      surface2: '#03313d',
      elevated: '#073642',
      raised: '#0b4250',
      text: '#eee8d5',
      textSecondary: '#d3cdb9',
      textMuted: '#93a1a1',
      borderSubtle: '#073642',
      borderStrong: '#1c4f5c',
      accent: '#268bd2',
      success: '#859900',
      warning: '#b58900',
      danger: '#dc322f',
      info: '#2aa198',
    },
  },
];

export const ALL_THEMES: readonly ThemeDefinition[] = [...LIGHT_THEMES, ...DARK_THEMES];

export const DEFAULT_LIGHT_THEME_ID = 'light';
export const DEFAULT_DARK_THEME_ID = 'dark';

export function findTheme(id: string | null | undefined): ThemeDefinition | undefined {
  return ALL_THEMES.find((theme) => theme.id === id);
}

export function lightThemeOrDefault(id: string | null | undefined): ThemeDefinition {
  return LIGHT_THEMES.find((theme) => theme.id === id) ?? LIGHT_THEMES[0];
}

export function darkThemeOrDefault(id: string | null | undefined): ThemeDefinition {
  return DARK_THEMES.find((theme) => theme.id === id) ?? DARK_THEMES[0];
}

/** Quick-pick accent swatches shown in Settings → Appearance. */
export const ACCENT_SWATCHES: readonly { label: string; value: string }[] = [
  { label: 'Blue', value: '#0a84ff' },
  { label: 'Indigo', value: '#5e5ce6' },
  { label: 'Purple', value: '#bf5af2' },
  { label: 'Pink', value: '#ff375f' },
  { label: 'Red', value: '#ff453a' },
  { label: 'Orange', value: '#ff9f0a' },
  { label: 'Amber', value: '#e5a00d' },
  { label: 'Green', value: '#30d158' },
  { label: 'Teal', value: '#40c8e0' },
];
