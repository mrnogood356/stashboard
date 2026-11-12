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
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime())
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
