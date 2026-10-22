import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

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
  /** Why this part couldn't be checked; the other sections still show. */
  error: string | null;
  groups: EvidenceGroup[];
}

/** "What Stashboard sees" for one scene. */
export interface SceneEvidence {
  kind: 'catalog' | 'local';
  id: string;
  title: string | null;
  checkedAt: string;
  sections: EvidenceSection[];
}

/** The plain facts behind a scene's state, for "Why is it like this?". */
@Injectable({ providedIn: 'root' })
export class DiagnosticsApiService {
  private readonly http = inject(HttpClient);

  /** A StashDB/FansDB scene, by its catalog id. */
  catalogScene(stashId: string): Observable<SceneEvidence> {
    return this.http.get<SceneEvidence>(`/api/scenes/${encodeURIComponent(stashId)}/evidence`);
  }

  /** A scene in your Stash library, by its Stash id. */
  localScene(sceneId: string): Observable<SceneEvidence> {
    return this.http.get<SceneEvidence>(
      `/api/local/scenes/${encodeURIComponent(sceneId)}/evidence`,
    );
  }
}

/** The whole evidence as plain text, to paste into a message. */
export function evidenceText(evidence: SceneEvidence): string {
  const subject = evidence.kind === 'catalog' ? 'Catalog scene' : 'Stash scene';
  const lines = [
    `What Stashboard sees: ${evidence.title ?? 'Untitled'} (${subject} ${evidence.id})`,
    `Checked ${evidence.checkedAt}`,
  ];
  for (const section of evidence.sections) {
    lines.push('', `== ${section.title} ==`);
    if (section.error) {
      lines.push(`! ${section.error}`);
    }
    if (section.summary) {
      lines.push(section.summary);
    }
    for (const group of section.groups) {
      if (group.heading) {
        lines.push(`${group.heading}:`);
      }
      const indent = group.heading ? '  ' : '';
      lines.push(...group.facts.map((fact) => `${indent}${fact.label}: ${fact.value}`));
    }
  }
  return lines.join('\n');
}
