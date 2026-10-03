// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Resource } from '@medplum/fhirtypes';
import { storedBinaryReference } from './files.ts';
import { LYFE_SOURCE_TAG_SYSTEM } from './source.ts';

/**
 * The rule that stops a chart claiming documents it does not hold.
 *
 * A `DocumentReference` is a *claim*: it tells the Documents tab that a
 * discharge summary exists and can be opened. The bytes live somewhere else,
 * behind `content[].attachment.url`, and nothing in FHIR makes the server check
 * that the two agree. So an importer that writes the reference whether or not
 * the file landed produces a chart that lists documents which 404 on click —
 * which is strictly worse than listing fewer documents, because a clinician
 * cannot tell a phantom from a slow load and has no reason to go looking
 * elsewhere for a record the chart says it already has.
 *
 * The specific way Zus produced them is worth stating, because it looks
 * harmless in the diff: Zus returns `attachment.url` as a **relative**
 * `Binary/<zus-uuid>`. The importer's job is to download that and repoint the
 * attachment at a Medplum Binary. When the download failed it left the URL
 * alone and wrote the reference anyway — and "leaving Zus's link alone" is not
 * what that does. A relative `Binary/<id>` has no host, so once it is stored on
 * our server it resolves against *our* server, where the id is meaningless.
 * The reference did not point at Zus. It pointed at nothing.
 *
 * Hence the invariant enforced here, which is checked against the resource
 * about to be written rather than against bookkeeping kept alongside it:
 *
 *   **every attachment URL on a DocumentReference this project writes must
 *   resolve to a Binary on this Medplum server.**
 *
 * Anything else — a failed download, a file over the per-run copy cap, a URL on
 * a third-party host the browser cannot authenticate to, a future bug that
 * forgets to call the copier at all — fails the same check and withholds the
 * same document. There is no second code path to keep in step.
 *
 * Withholding is not dropping. Zus remains the record of truth and still has
 * the document; the reference is simply not written *this run*. Every
 * subsequent sync re-pulls the same document and tries again, so a file that
 * was briefly unavailable — a network that had not finished answering when the
 * pull ran — lands on the next pass with nothing lost. What does not happen in
 * the meantime is the chart telling a clinician the document is already there.
 */

/** One document that was not written, and why. */
export interface WithheldDocument {
  /** The Zus resource id, so it can be found upstream. */
  readonly zusId: string;
  /** The source network / repository it came from, as `meta.tag` reports it. */
  readonly network: string;
  /** Why the file could not be stored, e.g. `HTTP 404`. */
  readonly reason: string;
}

/** How one source network fared on this run. */
export interface NetworkOutcome {
  /** The network / repository label from `meta.tag`. */
  readonly label: string;
  /** Documents this network offered in this run. */
  readonly offered: number;
  /** How many of them had their file stored in Medplum. */
  readonly stored: number;
  /**
   * `complete` — every file retrieved.
   * `partial` — some retrieved, some not.
   * `unavailable` — the network listed documents and not one file could be
   * fetched, which is the shape CommonWell produced and is categorically
   * different from a network that simply returned nothing.
   */
  readonly status: 'complete' | 'partial' | 'unavailable';
}

/** What a document-rehosting pass produced, for reporting onto the run's Task. */
export interface DocumentFileReport {
  /** Documents withheld because their file could not be stored. */
  readonly withheld: readonly WithheldDocument[];
  /** Per-source-network outcome, worst first. */
  readonly networks: readonly NetworkOutcome[];
}

/**
 * Which network or repository a Zus resource came from.
 *
 * Read off `meta.tag`, which Zus stamps with the data's provenance and
 * `retagForMedplum` deliberately keeps. Our own source tag is excluded — it
 * says "Lyfe imported this", not where it came from.
 *
 * Deliberately data-driven rather than a list of known networks. Zus's tag
 * systems are not documented anywhere in this repo and a hardcoded
 * `commonwell | carequality | surescripts` switch would report every future
 * network as "unknown" — silently, which is the failure mode this whole change
 * exists to remove. Whatever Zus stamps is what gets grouped and reported.
 * @param resource - The resource as it will be written.
 * @returns A stable label, or `unknown source` when nothing identifies it.
 */
export function sourceNetworkLabel(resource: Resource): string {
  const tags = resource.meta?.tag ?? [];
  const parts = tags
    .filter((tag) => tag.system !== LYFE_SOURCE_TAG_SYSTEM)
    .map((tag) => tag.code ?? tag.display)
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' / ') : 'unknown source';
}

/**
 * Split prepared DocumentReferences into those backed by a stored file and
 * those that are not.
 *
 * The test is on the attachment URL of the resource itself: it must be a URL
 * this Medplum server hands out for one of its own Binaries. See the module
 * note for why that, and not a record of which downloads succeeded.
 *
 * An attachment that claims nothing — no URL and no inline data — is left
 * alone. It is not a phantom; there is no document behind it to open, which
 * the Documents tab shows honestly. Only a *claimed* file that we do not hold
 * withholds its document.
 *
 * Inline base64 counts as holding it. Zus sends C-CDA XML that way, and an
 * attachment carrying its own bytes opens without reaching for anything — so
 * a document whose copy into a Binary failed but which still has its content
 * in hand is written, not withheld. A URL that is present and wrong is a
 * different matter: it is what the viewer follows, so it withholds the
 * document whether or not there is data beside it.
 * @param props - The partition inputs.
 * @param props.entries - Prepared write entries, each with its Zus id.
 * @param props.baseUrl - This Medplum server's base URL, ending in a slash.
 * @param props.reasons - Why a given Zus document's copy failed, keyed on Zus id.
 * @returns The entries safe to write, and a report on the rest.
 */
export function partitionBackedDocuments<T extends { resource: Resource; value: string }>(props: {
  entries: readonly T[];
  baseUrl: string;
  reasons?: ReadonlyMap<string, string>;
}): { writable: T[]; report: DocumentFileReport } {
  const writable: T[] = [];
  const withheld: WithheldDocument[] = [];
  const offered = new Map<string, number>();
  const stored = new Map<string, number>();

  for (const entry of props.entries) {
    const network = sourceNetworkLabel(entry.resource);
    offered.set(network, (offered.get(network) ?? 0) + 1);

    const content = (entry.resource as { content?: { attachment?: { url?: string; data?: string } }[] }).content ?? [];
    const unbacked = content.filter(({ attachment }) => {
      if (attachment?.url) {
        return !storedBinaryReference(attachment.url, props.baseUrl);
      }
      return false;
    });

    if (unbacked.length === 0) {
      stored.set(network, (stored.get(network) ?? 0) + 1);
      writable.push(entry);
      continue;
    }

    withheld.push({
      zusId: entry.value,
      network,
      reason: props.reasons?.get(entry.value) ?? 'no file stored in Medplum',
    });
  }

  return { writable, report: { withheld, networks: summariseNetworks(offered, stored) } };
}

/**
 * Turn the per-network counts into outcomes, worst first.
 * @param offered - Documents offered, by network.
 * @param stored - Documents whose file landed, by network.
 * @returns One outcome per network, unavailable first, then partial.
 */
function summariseNetworks(offered: Map<string, number>, stored: Map<string, number>): NetworkOutcome[] {
  const rank = { unavailable: 0, partial: 1, complete: 2 };
  return [...offered.entries()]
    .map(([label, count]): NetworkOutcome => {
      const ok = stored.get(label) ?? 0;
      if (ok === 0) {
        return { label, offered: count, stored: ok, status: 'unavailable' };
      }
      return { label, offered: count, stored: ok, status: ok < count ? 'partial' : 'complete' };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || b.offered - a.offered || a.label.localeCompare(b.label));
}

/** How many distinct networks the withheld sentence names before it stops. */
const MAX_NAMED_NETWORKS = 6;

/**
 * One sentence naming what was withheld and why, for the run's Task.
 *
 * Returns undefined when nothing was withheld, so a clean run says nothing —
 * the Imports page's "Finished short" panel should appear only when a run
 * actually finished short.
 * @param report - The rehosting report.
 * @returns The sentence, or undefined.
 */
export function describeWithheldDocuments(report: DocumentFileReport): string | undefined {
  if (report.withheld.length === 0) {
    return undefined;
  }
  const byNetwork = new Map<string, { count: number; reason: string }>();
  for (const doc of report.withheld) {
    const seen = byNetwork.get(doc.network);
    if (seen) {
      seen.count++;
    } else {
      byNetwork.set(doc.network, { count: 1, reason: doc.reason });
    }
  }
  const named = [...byNetwork.entries()].sort((a, b) => b[1].count - a[1].count);
  const shown = named.slice(0, MAX_NAMED_NETWORKS).map(([label, { count, reason }]) => `${label} ${count} (${reason})`);
  if (named.length > MAX_NAMED_NETWORKS) {
    shown.push(`and ${named.length - MAX_NAMED_NETWORKS} more source(s)`);
  }
  return (
    `${report.withheld.length} document(s) not written because their file could not be stored — ${shown.join(', ')}. ` +
    'The documents are still on Zus and the next sync retries them; they are left out of the chart rather than ' +
    'listed as documents that cannot be opened.'
  );
}

/**
 * One sentence per-network, so a gap reads as a gap rather than as a clean run.
 *
 * This is the shape ported from the legacy platform's Zus history job, where a
 * run that finished with `commonwell: in_progress, carequality: error` was
 * recorded as PARTIAL rather than SUCCESS — because a plain success makes a
 * real, known gap invisible everywhere except the console. Here the networks
 * are not reported by Zus as job statuses; they are read off the provenance
 * tags of the documents that actually arrived, which answers the same question
 * from data this importer already holds and without a second API call.
 *
 * Returns undefined when every network delivered in full.
 * @param report - The rehosting report.
 * @returns The sentence, or undefined.
 */
export function describeNetworks(report: DocumentFileReport): string | undefined {
  const short = report.networks.filter((n) => n.status !== 'complete');
  if (short.length === 0) {
    return undefined;
  }
  const parts = report.networks.map((n) =>
    n.status === 'complete'
      ? `${n.label}: all ${n.offered} file(s) retrieved`
      : `${n.label}: ${n.stored} of ${n.offered} file(s) retrieved`
  );
  return parts.join('; ');
}

/**
 * The one line the Imports page shows for a finished run.
 *
 * Three outcomes, not two. A run that pulled a chart but could not retrieve a
 * whole network's documents is neither a failure — the rest of the record
 * landed and is worth having — nor a success, and reporting it as `complete`
 * is how a known gap becomes invisible to everyone except whoever reads the
 * logs. That is the exact failure the legacy platform fixed by recording such
 * a sync as PARTIAL rather than SUCCESS, and this is the same decision in the
 * vocabulary Medplum already has: `Task.status` stays `completed`, because the
 * run really did finish and the data really was written, while
 * `Task.businessStatus` says `partial` and names the biggest gap.
 *
 * No new status code, no new resource, nothing to migrate. The Imports page
 * prints `businessStatus` in the collapsed row already, so a partial run reads
 * as partial without anyone expanding it.
 * @param props - The closing inputs.
 * @param props.status - `completed` or `failed`.
 * @param props.incomplete - What finished short, keyed by what fell short.
 * @param props.report - Withheld documents and per-network outcomes, when there were any.
 * @returns The business status text.
 */
export function describeRunOutcome(props: {
  status: 'completed' | 'failed';
  incomplete: Record<string, string>;
  report?: DocumentFileReport;
}): string {
  if (props.status === 'failed') {
    return 'failed';
  }
  const gaps = Object.keys(props.incomplete);
  if (gaps.length === 0) {
    return 'complete';
  }
  const withheld = props.report?.withheld.length ?? 0;
  if (withheld > 0) {
    const short = (props.report?.networks ?? []).filter((n) => n.status !== 'complete').length;
    return `partial — ${withheld} document(s) not retrievable from ${short} source(s)`;
  }
  return `partial — ${gaps.length} gap(s): ${gaps.join(', ')}`;
}
