/**
 * Stashboard was called Stasharr; its settings were STASHARR_* environment
 * variables. Each old name still works: it fills in the new STASHBOARD_* one
 * when that isn't set. Imported first by main.ts, before anything reads them.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const used: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('STASHARR_') || value === undefined) {
      continue;
    }
    const current = `STASHBOARD_${name.slice('STASHARR_'.length)}`;
    if (env[current] === undefined) {
      env[current] = value;
      used.push(name);
    }
  }
  return used;
}

applyLegacyEnv();
