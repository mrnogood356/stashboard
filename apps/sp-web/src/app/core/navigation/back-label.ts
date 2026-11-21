/**
 * What a page's back link says, from where it goes back to. One list for
 * every page, so a performer opened from Search says "Back to Search" just
 * as a scene does. More specific paths come first.
 */
const BACK_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['/home', 'Back to Home'],
  ['/search', 'Back to Search'],
  ['/you-may-enjoy', 'Back to You may enjoy'],
  ['/following', 'Back to Following'],
  ['/calendar', 'Back to Calendar'],
  ['/history', 'Back to History'],
  ['/watch-later', 'Back to Watch later'],
  ['/chapters', 'Back to Chapters'],
  ['/acquisition', 'Back to Wanted'],
  ['/processing', 'Back to Downloads'],
  ['/library/scene/', 'Back to Scene'],
  ['/library/performer/', 'Back to Performer'],
  ['/library/studio/', 'Back to Studio'],
  ['/library', 'Back to Library'],
  ['/scenes', 'Back to Scenes'],
  ['/discover', 'Back to Scenes'],
  ['/scene/', 'Back to Scene'],
  ['/performers', 'Back to Performers'],
  ['/performer/', 'Back to Performer'],
  ['/studios', 'Back to Studios'],
  ['/studio/', 'Back to Studio'],
  ['/tools', 'Back to Tools'],
];

export function backLabelFor(path: string, fallback = 'Back'): string {
  return BACK_LABELS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? fallback;
}
