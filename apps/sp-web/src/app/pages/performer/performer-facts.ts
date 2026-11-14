import { PerformerDetails } from '../../core/api/discover.types';

export interface PerformerFact {
  label: string;
  value: string;
}

/** "LIGHT_BROWN" → "Light brown": catalog values are shouted enum names. */
export function readableValue(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  // Already written for people ("Blue", "light brown").
  if (text !== text.toUpperCase()) {
    return text;
  }
  const words = text.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "1996-04-02" → "Apr 2, 1996"; anything else is shown as it came. */
export function readableDate(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) {
    return text;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls an impossible day over (Feb 29, 2025 becomes Mar 1):
  // shown as it came instead of as a different day.
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return !real
    ? text
    : date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

/** Centimetres, as the catalog gives them, with feet and inches alongside. */
export function readableHeight(value: string | number | null | undefined): string | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const cm = Number(text);
  if (!Number.isFinite(cm) || cm <= 0) {
    return text;
  }
  const totalInches = Math.round(cm / 2.54);
  return `${Math.round(cm)} cm (${Math.floor(totalInches / 12)}′${totalInches % 12}″)`;
}

/** "US" → "United States"; unknown codes stay as they are. */
export function readableCountry(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (!/^[A-Za-z]{2}$/.test(text)) {
    return text;
  }
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(text.toUpperCase()) ?? text;
  } catch {
    return text;
  }
}

function genderLabel(gender: string | null): string | null {
  return readableValue(gender);
}

/** The details shown under a performer's name, in words rather than catalog codes. */
export function performerFacts(performer: PerformerDetails): PerformerFact[] {
  const facts: PerformerFact[] = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') {
      return;
    }
    facts.push({ label, value: String(value) });
  };

  add('Gender', genderLabel(performer.gender));
  const born = readableDate(performer.birthDate);
  if (born) {
    add(
      'Born',
      performer.age !== null && !performer.deathDate ? `${born} (${performer.age})` : born,
    );
  } else {
    add('Age', performer.age);
  }
  add('Died', readableDate(performer.deathDate));
  add('Country', readableCountry(performer.country));
  add('Ethnicity', readableValue(performer.ethnicity));
  add('Eye color', readableValue(performer.eyeColor));
  add('Hair color', readableValue(performer.hairColor));
  add('Height', readableHeight(performer.height));
  const bust = [performer.bandSize, performer.cupSize].filter((part) => part).join('');
  add('Bust', bust || null);
  add('Waist', performer.waistSize);
  add('Hips', performer.hipSize);
  add('Breasts', readableValue(performer.breastType));
  if (performer.careerStartYear) {
    add('Career', `${performer.careerStartYear} – ${performer.careerEndYear ?? 'now'}`);
  } else if (performer.careerEndYear) {
    add('Career', `until ${performer.careerEndYear}`);
  }
  return facts;
}

export interface PerformerFactGroup {
  title: string;
  facts: PerformerFact[];
}

/**
 * The same details in three short groups (About, Look, Body), with the
 * measurements as one "32J-27-38". Empty groups are left out.
 */
export function performerFactGroups(performer: PerformerDetails): PerformerFactGroup[] {
  const all = performerFacts(performer);
  const pick = (...labels: string[]) => all.filter((fact) => labels.includes(fact.label));
  const bust = all.find((fact) => fact.label === 'Bust')?.value;
  const waist = all.find((fact) => fact.label === 'Waist')?.value;
  const hips = all.find((fact) => fact.label === 'Hips')?.value;
  const measured = [bust, waist, hips];
  const body: PerformerFact[] = measured.some(Boolean)
    ? [{ label: 'Measurements', value: measured.map((part) => part ?? '?').join('-') }]
    : [];
  body.push(...pick('Breasts'));
  return [
    { title: 'About', facts: pick('Gender', 'Born', 'Age', 'Died', 'Country', 'Career') },
    { title: 'Look', facts: pick('Ethnicity', 'Hair color', 'Eye color', 'Height') },
    { title: 'Body', facts: body },
  ].filter((group) => group.facts.length > 0);
}
