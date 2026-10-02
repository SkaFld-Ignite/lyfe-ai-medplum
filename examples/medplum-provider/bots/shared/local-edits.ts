// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * What a re-pull is allowed to overwrite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The importers write every mirrored resource with a FHIR **conditional update
 * by business identifier** — `PUT Condition?identifier=<source>|<id>` — so the
 * server does the matching and a second import updates in place rather than
 * writing a second copy. That is what already makes an import re-runnable, and
 * it is not what this module is about.
 *
 * A conditional update **replaces the whole resource**. That is correct the
 * first time and for every resource nobody has touched since. It is wrong for
 * the one case that only appears once re-syncing is a thing a clinician can
 * ask for: a resource that came from the network and was then *edited in the
 * chart*. Marking a problem resolved, correcting a dose, adding a note — all
 * of it is gone on the next pull, silently, with the import reporting a clean
 * success. For a longitudinal record that is worse than not re-syncing at all.
 *
 * HOW A LOCAL EDIT IS RECOGNISED
 * ------------------------------
 * `meta.author` is server-controlled — Medplum sets it from the writing
 * session's membership on every create and update and never takes it from the
 * request body (`packages/server/src/fhir/repo.ts`, `getAuthor`). The importer
 * runs as a ClientApplication (the worker) or a Bot (the Medplum sandbox); a
 * clinician editing in the app runs as their own `Practitioner`. So the last
 * writer's *resource type* is enough, and nothing has to be stamped, stored or
 * migrated to make it so.
 *
 * Deliberately NOT "author differs from ours". That rule reads better and
 * behaves worse: rotating the worker's client credentials mints a new
 * ClientApplication, every resource then looks foreign, and the re-sync turns
 * into a silent no-op across the whole chart. Asking only whether a *person*
 * wrote it survives rotation.
 *
 * THREE WAYS TO DECLINE, AND WHY EACH ONE FAILS CLOSED
 * ----------------------------------------------------
 *  1. **A person wrote it.** Keep what they wrote.
 *  2. **Two local resources carry the same source identifier.** The server
 *     would answer 412 to the conditional PUT anyway; catching it here means
 *     the run can say *which* resource was ambiguous instead of reporting
 *     "a write did not settle 2xx".
 *  3. **`meta.author` could not be read at all.** Medplum strips it from reads
 *     outside extended mode, and an AccessPolicy can hide it. Either way the
 *     guard cannot tell an edited resource from an untouched one — so it
 *     declines rather than guessing, which costs a stale resource and never a
 *     lost one.
 *
 * Declining to write is always better than writing over a good record. Every
 * decline is counted and reported on the run's Task, so "the re-sync did
 * nothing" is never a mystery.
 *
 * Nothing here is Zus-specific. It takes a resource type, a patient and an
 * identifier system, which is all any source-of-record importer has.
 */
import type { MedplumClient } from '@medplum/core';
import type { Patient, Reference, Resource } from '@medplum/fhirtypes';

/**
 * Reference types that mean a person, rather than a machine, last wrote a
 * resource.
 *
 * `Practitioner` and `PractitionerRole` are the clinician in the app.
 * `Patient` and `RelatedPerson` are the portal surfaces. `Person` is Medplum's
 * cross-project identity and appears when a user writes outside a clinical
 * role. Everything else — `ClientApplication`, `Bot`, `system` — is an
 * importer, a script or the server itself.
 */
export const HUMAN_AUTHOR_TYPES = ['Practitioner', 'PractitionerRole', 'Patient', 'RelatedPerson', 'Person'] as const;

/**
 * Whether a `meta.author` reference names a person.
 * @param author - The `meta.author.reference` string, if there is one.
 * @returns True when a person wrote it; false for a machine or for no author.
 */
export function isHumanAuthor(author: string | undefined): boolean {
  if (!author) {
    return false;
  }
  const type = author.split('/')[0];
  return (HUMAN_AUTHOR_TYPES as readonly string[]).includes(type);
}

/** One resource already in the project, keyed on its source id. */
export interface LocalResource {
  /** Medplum resource id. */
  readonly id: string;
  /** `meta.author.reference`, when the server returned one. */
  readonly author?: string;
}

/**
 * What is already here for one patient and one resource type, keyed on the
 * source system's own ids.
 */
export interface LocalIndex {
  /** Source id to the single local resource carrying it. */
  readonly bySourceId: Map<string, LocalResource>;
  /** Source ids claimed by more than one local resource — an ambiguous match. */
  readonly ambiguous: Set<string>;
  /**
   * False when local resources were found but none carried `meta.author`.
   *
   * The guard cannot run in that state, so every *existing* resource is
   * declined. New ones still write: a resource that is not here yet cannot
   * carry an edit.
   */
  readonly authorReadable: boolean;
}

/** An index over nothing, used when a type has never been imported. */
export const EMPTY_LOCAL_INDEX: LocalIndex = {
  bySourceId: new Map(),
  ambiguous: new Set(),
  authorReadable: true,
};

/**
 * Read what is already in the project for one patient and one resource type.
 *
 * `_elements` keeps this to identifiers and metadata: the point is to decide
 * what may be written, not to transfer a chart twice. `meta` survives the
 * narrowing — Medplum treats `resourceType`, `id` and `meta` as mandatory in a
 * subset (`subsetResource` in `@medplum/core`) — so the author is still there.
 *
 * What it does depend on is the client sending `X-Medplum: extended`, which
 * `MedplumClient` does unless `extendedMode` is explicitly `false`: without it
 * the server blanks `meta.author` on every read. That is not a silent failure
 * here — the index reports the author as unreadable and every existing
 * resource is declined — but it is the first thing to check if a re-sync
 * suddenly writes nothing.
 *
 * The search is by `patient`, which every type the importers mirror supports,
 * and the identifier filtering is done here rather than in the query so that a
 * resource carrying the source identifier *plus* others is still matched.
 * @param props - The lookup inputs.
 * @param props.medplum - Authenticated Medplum client.
 * @param props.resourceType - The FHIR type to index.
 * @param props.patient - The patient whose resources to index.
 * @param props.system - Identifier system the source's ids live under.
 * @returns The index. Throws when the read fails — the caller must fail closed.
 */
export async function loadLocalIndex(props: {
  medplum: MedplumClient;
  resourceType: string;
  patient: Reference<Patient>;
  system: string;
}): Promise<LocalIndex> {
  const bySourceId = new Map<string, LocalResource>();
  const ambiguous = new Set<string>();
  let found = 0;
  let withAuthor = 0;

  for await (const page of props.medplum.searchResourcePages(props.resourceType as 'Observation', {
    patient: props.patient.reference as string,
    _elements: 'identifier,meta',
    _count: '1000',
  })) {
    for (const resource of page) {
      const sourceId = sourceIdOf(resource, props.system);
      if (!sourceId || !resource.id) {
        continue;
      }
      found++;
      if (resource.meta?.author?.reference) {
        withAuthor++;
      }
      if (bySourceId.has(sourceId)) {
        // Two local resources answer to one source id. The server would reject
        // the conditional PUT with 412; recording it here is what lets the run
        // report which id was ambiguous.
        ambiguous.add(sourceId);
        continue;
      }
      bySourceId.set(sourceId, { id: resource.id, author: resource.meta?.author?.reference });
    }
  }

  return { bySourceId, ambiguous, authorReadable: found === 0 || withAuthor > 0 };
}

/**
 * The source system's id for a resource, read off its identifiers.
 * @param resource - The local resource.
 * @param system - Identifier system the source's ids live under.
 * @returns The id, or undefined when this resource did not come from that source.
 */
function sourceIdOf(resource: Resource, system: string): string | undefined {
  const identifiers = (resource as { identifier?: { system?: string; value?: string }[] }).identifier;
  return identifiers?.find((i) => i.system === system && i.value)?.value;
}

/** Why a write was declined. */
export type DeclineReason = 'clinician-edited' | 'ambiguous-match' | 'author-unreadable';

/** Whether one resource may be written, and why not when it may not. */
export type WriteDecision =
  { readonly write: true } | { readonly write: false; readonly reason: DeclineReason; readonly detail: string };

/**
 * Decide whether a re-pull may write over what is already here.
 *
 * The only case that writes is "nothing is here yet, or what is here was last
 * written by a machine". Everything else declines, with the reason the run
 * reports.
 * @param props - The decision inputs.
 * @param props.index - What is already here for this type.
 * @param props.sourceId - The source system's id for the incoming resource.
 * @returns The decision.
 */
export function decideWrite(props: { index: LocalIndex; sourceId: string }): WriteDecision {
  if (props.index.ambiguous.has(props.sourceId)) {
    return {
      write: false,
      reason: 'ambiguous-match',
      detail: `more than one local resource carries source id ${props.sourceId}`,
    };
  }

  const existing = props.index.bySourceId.get(props.sourceId);
  if (!existing) {
    // Not here yet. Nothing to overwrite, so nothing to protect.
    return { write: true };
  }

  if (!props.index.authorReadable) {
    return {
      write: false,
      reason: 'author-unreadable',
      detail: 'meta.author is not readable on this server, so an edited resource cannot be told from an untouched one',
    };
  }

  if (isHumanAuthor(existing.author)) {
    return {
      write: false,
      reason: 'clinician-edited',
      detail: `${existing.author} last wrote this resource`,
    };
  }

  return { write: true };
}

/** How many writes each reason declined, for the run's report. */
export type DeclineTally = Partial<Record<DeclineReason, number>>;

/** What a guarded pass over one resource type produced. */
export interface Selection<T> {
  /** The items that may be written, in the order they were offered. */
  readonly writable: readonly { readonly sourceId: string; readonly value: T }[];
  /** How many were declined, by reason. */
  readonly declined: DeclineTally;
  /** One example detail per reason, so a report can name a cause. */
  readonly declineDetail: Partial<Record<DeclineReason, string>>;
  /** Source id to the Medplum id of the copy already here, for the declined and the rest alike. */
  readonly existingIds: Map<string, string>;
}

/**
 * Read what is already here and decide, per item, what may be written over it.
 *
 * The index read and the decision are one function on purpose. Keeping them
 * apart invites an importer to build its write entries first and consult the
 * guard second — and the version of that code which forgets the second step
 * looks completely normal and passes every test that does not involve a second
 * run against a chart someone has edited. Here there is no list of entries to
 * write until the guard has produced one.
 *
 * The index read is **not** caught. A caller that cannot read what is already
 * here must not write; letting this throw is what makes that the default.
 * @param props - The pass inputs.
 * @param props.medplum - Authenticated Medplum client.
 * @param props.resourceType - The FHIR type being written.
 * @param props.patient - The patient the resources hang off.
 * @param props.system - Identifier system the source's ids live under.
 * @param props.items - Candidates, each with the source system's id for it.
 * @returns What may be written, what was declined and why.
 */
export async function selectWritable<T>(props: {
  medplum: MedplumClient;
  resourceType: string;
  patient: Reference<Patient>;
  system: string;
  items: readonly { sourceId: string; value: T }[];
}): Promise<Selection<T>> {
  const index = await loadLocalIndex({
    medplum: props.medplum,
    resourceType: props.resourceType,
    patient: props.patient,
    system: props.system,
  });

  const writable: { sourceId: string; value: T }[] = [];
  const declined: DeclineTally = {};
  const declineDetail: Partial<Record<DeclineReason, string>> = {};
  const existingIds = new Map<string, string>();

  for (const item of props.items) {
    const existing = index.bySourceId.get(item.sourceId);
    if (existing) {
      existingIds.set(item.sourceId, existing.id);
    }
    const decision = decideWrite({ index, sourceId: item.sourceId });
    if (decision.write) {
      writable.push(item);
    } else {
      declined[decision.reason] = (declined[decision.reason] ?? 0) + 1;
      declineDetail[decision.reason] ??= decision.detail;
    }
  }

  return { writable, declined, declineDetail, existingIds };
}

/**
 * One sentence describing what a run refused to overwrite.
 *
 * Returns undefined when nothing was declined, so the caller can leave the
 * report clean on a run with nothing to say.
 * @param tally - Declines by reason.
 * @param sample - One example detail per reason, to name a cause.
 * @returns The sentence, or undefined.
 */
export function describeDeclines(
  tally: DeclineTally,
  sample: Partial<Record<DeclineReason, string>> = {}
): string | undefined {
  const parts: string[] = [];
  if (tally['clinician-edited']) {
    parts.push(
      `${tally['clinician-edited']} kept as edited in the chart` +
        (sample['clinician-edited'] ? ` (e.g. ${sample['clinician-edited']})` : '')
    );
  }
  if (tally['ambiguous-match']) {
    parts.push(
      `${tally['ambiguous-match']} skipped as ambiguous` +
        (sample['ambiguous-match'] ? ` (e.g. ${sample['ambiguous-match']})` : '')
    );
  }
  if (tally['author-unreadable']) {
    parts.push(
      `${tally['author-unreadable']} skipped because the local-edit guard could not run` +
        (sample['author-unreadable'] ? ` — ${sample['author-unreadable']}` : '')
    );
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}
