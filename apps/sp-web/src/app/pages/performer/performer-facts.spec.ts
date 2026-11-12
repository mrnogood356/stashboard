import { describe, expect, it } from 'vitest';
import { PerformerDetails } from '../../core/api/discover.types';
import {
  performerFacts,
  readableCountry,
  readableDate,
  readableHeight,
  readableValue,
} from './performer-facts';

const performer = (overrides: Partial<PerformerDetails> = {}): PerformerDetails => ({
  id: 'p1',
  name: 'Alex Rivers',
  disambiguation: null,
  aliases: [],
  gender: 'FEMALE',
  birthDate: '1996-04-02',
  deathDate: null,
  age: 30,
  ethnicity: 'CAUCASIAN',
  country: 'US',
  eyeColor: 'BLUE',
  hairColor: 'LIGHT_BROWN',
  height: '168',
  cupSize: 'C',
  bandSize: 34,
  waistSize: null,
  hipSize: null,
  breastType: 'NATURAL',
  careerStartYear: 2018,
  careerEndYear: null,
  deleted: false,
  mergedIds: [],
  mergedIntoId: null,
  isFavorite: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  imageUrl: null,
  images: [],
  ...overrides,
});

describe('performer facts', () => {
  it('says things in words, not catalog codes', () => {
    expect(performerFacts(performer())).toEqual([
      { label: 'Gender', value: 'Female' },
      { label: 'Born', value: 'Apr 2, 1996 (30)' },
      { label: 'Country', value: 'United States' },
      { label: 'Ethnicity', value: 'Caucasian' },
      { label: 'Eye color', value: 'Blue' },
      { label: 'Hair color', value: 'Light brown' },
      { label: 'Height', value: '168 cm (5′6″)' },
      { label: 'Bust', value: '34C' },
      { label: 'Breasts', value: 'Natural' },
      { label: 'Career', value: '2018 – now' },
    ]);
  });

  it('gives the age alone without a birth date, and no age after a death', () => {
    const noBirth = performerFacts(performer({ birthDate: null }));
    expect(noBirth).toContainEqual({ label: 'Age', value: '30' });

    const passed = performerFacts(performer({ deathDate: '2025-03-01' }));
    expect(passed).toContainEqual({ label: 'Born', value: 'Apr 2, 1996' });
    expect(passed).toContainEqual({ label: 'Died', value: 'Mar 1, 2025' });
  });

  it('leaves values it can’t read as they came', () => {
    expect(readableValue('light brown')).toBe('light brown');
    expect(readableDate('sometime in 1996')).toBe('sometime in 1996');
    expect(readableDate('2025-02-29')).toBe('2025-02-29');
    expect(readableDate('2025-13-01')).toBe('2025-13-01');
    expect(readableDate('2024-02-29')).toBe('Feb 29, 2024');
    expect(readableHeight('tall')).toBe('tall');
    expect(readableCountry('Atlantis')).toBe('Atlantis');
    expect(readableValue(null)).toBeNull();
  });
});
