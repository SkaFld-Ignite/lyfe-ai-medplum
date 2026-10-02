// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The one place an intent becomes an Inngest event.
 *
 * An inbound delivery joins the pipeline that already exists — chart import →
 * Zus pull → RAG index → AI summary — rather than starting a parallel one. That
 * is the mistake lyfe-provider-ui made: the Svix path wrote straight to the
 * database beside a perfectly good Inngest processor that only the dead-letter
 * replay could reach, so the two had different idempotency, different retries
 * and different bugs.
 *
 * Adapters return intents and never touch this file. That is what keeps a
 * provider from inventing its own chain, and it means the day the pipeline
 * changes shape, it changes here once.
 */
import { inngest } from '../inngest.ts';
import type { InboundIntent } from './contract.ts';

/** Prefix for the batch id attached to webhook-driven runs. */
export const WEBHOOK_BATCH_PREFIX = 'hook';

/** One intent, resolved to the event that carries it out. */
export interface Dispatched {
  /** The intent kind that produced it. */
  readonly kind: InboundIntent['kind'];
  /** The Inngest event name, or undefined when nothing was sent. */
  readonly event?: string;
}

/**
 * Turn intents into Inngest events.
 *
 * `ignore` and `unknown` send nothing. They are still returned, so the caller
 * can report them and so an operator reading a response can tell "we decided not
 * to" from "nothing happened".
 * @param props - What to dispatch.
 * @param props.intents - The adapter's intents.
 * @param props.organizationId - The clinic. Routing and concurrency only.
 * @param props.requester - The profile the work runs as; the importer derives
 * the clinic it writes into from this and not from `organizationId`.
 * @param props.deliveryId - The provider's delivery id, which becomes the batch id.
 * @returns What was sent, in the order the intents came in.
 */
export async function dispatchIntents(props: {
  intents: readonly InboundIntent[];
  organizationId: string;
  requester: string;
  deliveryId: string;
}): Promise<Dispatched[]> {
  const { intents, organizationId, requester, deliveryId } = props;

  // The delivery id is the batch id, so every Task a delivery produces can be
  // traced back to the hook that caused it — the same way a bulk run's patients
  // share one `bulk-...` id on the Imports page.
  const batchId = `${WEBHOOK_BATCH_PREFIX}-${deliveryId}`;
  const base = { organizationId, requester, batchId };

  const results: Dispatched[] = [];
  const toSend: { name: string; data: Record<string, unknown> }[] = [];

  for (const intent of intents) {
    switch (intent.kind) {
      case 'chart.import':
        toSend.push({
          name: 'lyfe/chart.import.requested',
          data: { ...base, drchronoPatientId: intent.externalPatientId },
        });
        results.push({ kind: intent.kind, event: 'lyfe/chart.import.requested' });
        break;
      case 'zus.import':
        toSend.push({
          name: 'lyfe/zus.import.requested',
          data: { ...base, medplumPatientId: intent.medplumPatientId },
        });
        results.push({ kind: intent.kind, event: 'lyfe/zus.import.requested' });
        break;
      case 'rag.ingest':
        toSend.push({
          name: 'lyfe/rag.ingest.requested',
          data: { ...base, patientId: intent.medplumPatientId },
        });
        results.push({ kind: intent.kind, event: 'lyfe/rag.ingest.requested' });
        break;
      case 'ignore':
      case 'unknown':
        results.push({ kind: intent.kind });
        break;
    }
  }

  if (toSend.length > 0) {
    // One send for the whole delivery. A partial send would leave the claim
    // held for work that only half happened, and the redelivery would be
    // dropped as a duplicate.
    await inngest.send(toSend as Parameters<typeof inngest.send>[0]);
  }

  return results;
}
