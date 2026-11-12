import type { FilterOption } from './filter-options.component';

/** What a chip says when set: the first pick, and how many more ("Outdoor +2"). */
export function pickedLabel(names: string[]): string | null {
  if (names.length === 0) {
    return null;
  }
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

/** A sort and its direction as one plain choice ("Newest first"). */
export interface SortChoice<S extends string> {
  label: string;
  sort: S;
  direction: 'ASC' | 'DESC';
}

export function sortChoiceId(sort: string, direction: string): string {
  return `${sort}:${direction}`;
}

export function sortChoiceOptions<S extends string>(choices: SortChoice<S>[]): FilterOption[] {
  return choices.map((choice) => ({
    id: sortChoiceId(choice.sort, choice.direction),
    label: choice.label,
  }));
}

/** The chip's text for the current sort; a sort that isn't listed reads by its name. */
export function sortChoiceLabel<S extends string>(
  choices: SortChoice<S>[],
  sort: string,
  direction: string,
): string {
  return (
    choices.find((choice) => choice.sort === sort && choice.direction === direction)?.label ??
    choices.find((choice) => choice.sort === sort)?.label ??
    'Sort'
  );
}

/**
 * Options from counted facets, the picked ones kept even when the counts
 * don't list them (picked from an older list, or from the address).
 */
export function facetOptions(
  facets: Array<{ id: string; name: string; count: number }>,
  picked: Array<{ id: string; name: string }>,
): FilterOption[] {
  const listed = new Set(facets.map((facet) => facet.id));
  return [
    ...picked
      .filter((pick) => !listed.has(pick.id))
      .map((pick) => ({ id: pick.id, label: pick.name, count: null })),
    ...facets.map((facet) => ({ id: facet.id, label: facet.name, count: facet.count })),
  ];
}
