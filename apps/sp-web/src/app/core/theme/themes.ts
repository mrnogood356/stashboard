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
  {
    id: 'github-light',
    label: 'GitHub Light',
    description: 'Crisp white with GitHub blue.',
    scheme: 'light',
    palette: {
      appBg: '#f6f8fa',
      surface1: '#ffffff',
      surface2: '#f6f8fa',
      elevated: '#ffffff',
      raised: '#eff2f5',
      text: '#1f2328',
      textSecondary: '#31373d',
      textMuted: '#59636e',
      borderSubtle: '#d8dee4',
      borderStrong: '#afb8c1',
      accent: '#0969da',
      success: '#1a7f37',
      warning: '#9a6700',
      danger: '#d1242f',
      info: '#0550ae',
    },
  },
  {
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    description: 'Soft rose and pine on cream.',
    scheme: 'light',
    palette: {
      appBg: '#f2e9e1',
      surface1: '#fffaf3',
      surface2: '#f8f1ea',
      elevated: '#fffaf3',
      raised: '#efe6de',
      text: '#575279',
      textSecondary: '#5f5a80',
      textMuted: '#6e6a86',
      borderSubtle: '#ece3da',
      borderStrong: '#cecacd',
      accent: '#286983',
      success: '#3e7f73',
      warning: '#b0701a',
      danger: '#b4637a',
      info: '#56949f',
    },
  },
  {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    description: 'Retro warm paper with deep teal.',
    scheme: 'light',
    palette: {
      appBg: '#f2e5bc',
      surface1: '#fbf1c7',
      surface2: '#f6ecc4',
      elevated: '#f9f5d7',
      raised: '#ebdbb2',
      text: '#3c3836',
      textSecondary: '#504945',
      textMuted: '#665c54',
      borderSubtle: '#ebdbb2',
      borderStrong: '#bdae93',
      accent: '#076678',
      success: '#79740e',
      warning: '#b57614',
      danger: '#9d0006',
      info: '#427b58',
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
      appBg: '#111215',
      surface1: '#1a1b1f',
      surface2: '#202126',
      elevated: '#26272c',
      raised: '#2e2f35',
      text: '#f5f5f7',
      textSecondary: '#d1d1d6',
      textMuted: '#9a9aa2',
      borderSubtle: '#2a2b30',
      borderStrong: '#3d3e45',
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
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Neon city blues after dark.',
    scheme: 'dark',
    palette: {
      appBg: '#16161e',
      surface1: '#1a1b26',
      surface2: '#1f2030',
      elevated: '#24283b',
      raised: '#292e42',
      text: '#c0caf5',
      textSecondary: '#a9b1d6',
      textMuted: '#8c93ba',
      borderSubtle: '#24283b',
      borderStrong: '#414868',
      accent: '#7aa2f7',
      success: '#9ece6a',
      warning: '#e0af68',
      danger: '#f7768e',
      info: '#7dcfff',
    },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    description: 'Retro warm dark with orange.',
    scheme: 'dark',
    palette: {
      appBg: '#1d2021',
      surface1: '#282828',
      surface2: '#2e2c2b',
      elevated: '#3c3836',
      raised: '#504945',
      text: '#ebdbb2',
      textSecondary: '#d5c4a1',
      textMuted: '#a89984',
      borderSubtle: '#3c3836',
      borderStrong: '#665c54',
      accent: '#fe8019',
      success: '#b8bb26',
      warning: '#fabd2f',
      danger: '#fb4934',
      info: '#83a598',
    },
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    description: 'Muted violet with soft rose.',
    scheme: 'dark',
    palette: {
      appBg: '#191724',
      surface1: '#1f1d2e',
      surface2: '#23212f',
      elevated: '#26233a',
      raised: '#312e48',
      text: '#e0def4',
      textSecondary: '#cfcbe6',
      textMuted: '#908caa',
      borderSubtle: '#26233a',
      borderStrong: '#403d52',
      accent: '#ebbcba',
      success: '#9ccfd8',
      warning: '#f6c177',
      danger: '#eb6f92',
      info: '#c4a7e7',
    },
  },
  {
    id: 'everforest',
    label: 'Everforest',
    description: 'Calm forest greens.',
    scheme: 'dark',
    palette: {
      appBg: '#232a2e',
      surface1: '#2d353b',
      surface2: '#313a40',
      elevated: '#323c41',
      raised: '#3d484d',
      text: '#e0d6bd',
      textSecondary: '#c9bea3',
      textMuted: '#9da9a0',
      borderSubtle: '#343f44',
      borderStrong: '#4f585e',
      accent: '#a7c080',
      success: '#83c092',
      warning: '#dbbc7f',
      danger: '#e67e80',
      info: '#7fbbb3',
    },
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    description: 'Ink black with GitHub blue.',
    scheme: 'dark',
    palette: {
      appBg: '#010409',
      surface1: '#0d1117',
      surface2: '#151b23',
      elevated: '#161b22',
      raised: '#21262d',
      text: '#e6edf3',
      textSecondary: '#c9d1d9',
      textMuted: '#9198a1',
      borderSubtle: '#21262d',
      borderStrong: '#30363d',
      accent: '#4493f8',
      success: '#3fb950',
      warning: '#d29922',
      danger: '#f85149',
      info: '#58a6ff',
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
