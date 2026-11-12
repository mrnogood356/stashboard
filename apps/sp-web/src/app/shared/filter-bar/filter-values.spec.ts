import { describe, expect, it } from 'vitest';
import { facetOptions, pickedLabel, sortChoiceLabel, sortChoiceOptions } from './filter-values';

describe('filter values', () => {
  it('names the first pick and counts the rest', () => {
    expect(pickedLabel([])).toBeNull();
    expect(pickedLabel(['Outdoor'])).toBe('Outdoor');
    expect(pickedLabel(['Outdoor', 'POV', 'Pool'])).toBe('Outdoor +2');
  });

  it('reads a sort and direction as one choice', () => {
    const choices = [
      { label: 'Newest first', sort: 'DATE', direction: 'DESC' as const },
      { label: 'Oldest first', sort: 'DATE', direction: 'ASC' as const },
      { label: 'Title', sort: 'TITLE', direction: 'ASC' as const },
    ];
    expect(sortChoiceOptions(choices).map((option) => option.id)).toEqual([
      'DATE:DESC',
      'DATE:ASC',
      'TITLE:ASC',
    ]);
    expect(sortChoiceLabel(choices, 'DATE', 'ASC')).toBe('Oldest first');
    expect(sortChoiceLabel(choices, 'TITLE', 'DESC')).toBe('Title');
    expect(sortChoiceLabel(choices, 'OTHER', 'DESC')).toBe('Sort');
  });

  it('keeps a pick the counts no longer list, first', () => {
    expect(
      facetOptions(
        [{ id: 't1', name: 'Outdoor', count: 40 }],
        [
          { id: 't1', name: 'Outdoor' },
          { id: 't9', name: 'Vintage' },
        ],
      ),
    ).toEqual([
      { id: 't9', label: 'Vintage', count: null },
      { id: 't1', label: 'Outdoor', count: 40 },
    ]);
  });
});
