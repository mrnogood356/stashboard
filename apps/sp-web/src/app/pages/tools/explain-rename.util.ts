import type { RenamePlan } from '../../core/api/organizer.service';

export interface RenameExplanation {
  reasons: string[];
  /** The new file name in pieces, with what wasn't in the old name marked. */
  name: Array<{ text: string; added: boolean }>;
}

const WORD_SEPARATORS = /([ ._-]+)/;

/** Plain words for what a rename changes: the folder, the name, or both. */
export function explainRename(plan: RenamePlan): RenameExplanation {
  const from = plan.from ?? '';
  const to = plan.to ?? '';
  const reasons: string[] = [];
  const fromFolder = folderPath(from);
  const toFolder = folderPath(to);
  if (fromFolder !== toFolder) {
    if (fromFolder.toLowerCase() === toFolder.toLowerCase()) {
      reasons.push('Folder name changes letter case');
    } else if (toFolder.startsWith(`${fromFolder}/`) || toFolder.startsWith(`${fromFolder}\\`)) {
      reasons.push(`Goes into its own folder: ${toFolder.slice(fromFolder.length + 1)}`);
    } else {
      const fromParts = fromFolder.split(/[\\/]/);
      const toParts = toFolder.split(/[\\/]/);
      let shared = 0;
      while (
        shared < Math.min(fromParts.length, toParts.length) &&
        fromParts[shared] === toParts[shared]
      ) {
        shared += 1;
      }
      reasons.push(
        `Moves from …/${fromParts.slice(shared).join('/') || '.'} to …/${toParts.slice(shared).join('/') || '.'}`,
      );
    }
  }

  const stem = (name: string) => name.replace(/\.[^.]+$/, '');
  const oldName = stem(fileName(from));
  const newName = stem(fileName(to));
  const words = (name: string) =>
    name
      .split(WORD_SEPARATORS)
      .filter((part, index) => index % 2 === 0 && part)
      .map((word) => word.toLowerCase());
  const oldWords = new Set(words(oldName));
  const newWords = new Set(words(newName));
  if (oldName !== newName) {
    if (oldName.toLowerCase() === newName.toLowerCase()) {
      reasons.push('Only the letter case changes');
    } else {
      const added = [...newWords].filter((word) => !oldWords.has(word));
      const dropped = [...oldWords].filter((word) => !newWords.has(word));
      const original = (list: string[], name: string) =>
        list.map(
          (word) => name.split(WORD_SEPARATORS).find((part) => part.toLowerCase() === word) ?? word,
        );
      const listed = (list: string[]) =>
        list.length > 4 ? `${list.slice(0, 4).join(', ')} +${list.length - 4}` : list.join(', ');
      if (added.length === 0 && dropped.length === 0) {
        const separator = (name: string) =>
          name.includes('.') && !name.includes(' ') ? 'dots' : 'spaces';
        reasons.push(
          separator(oldName) === separator(newName)
            ? 'Same words, punctuation tidied'
            : `Same words, ${separator(oldName)} become ${separator(newName)}`,
        );
      } else {
        if (added.length) {
          reasons.push(`Adds ${listed(original(added, newName))}`);
        }
        if (dropped.length) {
          reasons.push(`Drops ${listed(original(dropped, oldName))}`);
        }
      }
    }
  }
  if (reasons.length === 0) {
    reasons.push('Name changes');
  }

  const name = fileName(to)
    .split(WORD_SEPARATORS)
    .filter((part) => part)
    .map((part, index, all) => {
      const isExtension =
        index === all.length - 1 && /^[a-z0-9]{2,4}$/i.test(part) && all[index - 1] === '.';
      return {
        text: part,
        added:
          !isExtension &&
          !WORD_SEPARATORS.test(part) &&
          oldName !== newName &&
          !oldWords.has(part.toLowerCase()),
      };
    });
  return { reasons, name };
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function folderPath(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '';
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}
