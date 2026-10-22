// "What Stashboard sees" for one scene: plain facts with short labels, in
// sections that each fail on their own.

export type EvidenceSectionId =
  'status' | 'whisparr' | 'downloads' | 'stash' | 'rename' | 'activity';

export interface EvidenceFact {
  label: string;
  value: string;
}

/** Facts about one thing (a Stash scene, a file); heading null for the section itself. */
export interface EvidenceGroup {
  heading: string | null;
  facts: EvidenceFact[];
}

export interface EvidenceSection {
  id: EvidenceSectionId;
  title: string;
  /** One line in plain words: what this part says about the scene. */
  summary: string | null;
  /** Why this part couldn't be checked, e.g. "Couldn't ask Whisparr: …". */
  error: string | null;
  groups: EvidenceGroup[];
}

export interface SceneEvidenceDto {
  /** A catalog (StashDB/FansDB) scene, or a scene in your Stash library. */
  kind: 'catalog' | 'local';
  /** The catalog scene's id, or the Stash scene's id. */
  id: string;
  title: string | null;
  checkedAt: string;
  sections: EvidenceSection[];
}
