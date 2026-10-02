// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Patient } from '@medplum/fhirtypes';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LyfeEvents } from './events.ts';
import { inngest } from './inngest.ts';
import { getMedplum } from './medplum.ts';
import type { Caller } from './trigger.ts';
import { bearerToken, identify, readJson, send } from './trigger.ts';

/**
 * Pulling one patient's record again, from one source.
 *
 * WHY THIS IS NOT A ZUS ENDPOINT
 * ------------------------------
 * The thing being asked for is "re-read this patient from a source of record".
 * Lyfe's network is the first source that needs it, because its webhooks do
 * not exist yet and the only way to see new data is to go and look. It will
 * not be the last, and the previous platform's mistake was to let that shape
 * the code: a `resyncZus` next to a `resyncDrChrono` next to whatever came
 * third, each with its own endpoint, its own auth check and its own idea of
 * what a patient id is.
 *
 * So the source is a parameter and {@link RESYNC_SOURCES} is the list. Adding
 * one is a registry entry naming the event it sends; everything around it —
 * the token check, the tenant check, the queueing, the shape of the reply —
 * is written once here. A source that is not in the registry is refused by
 * name, which is a far better failure than a 404 on a path nobody spelled
 * right.
 *
 * WHY IT SENDS THE IMPORT'S OWN EVENT
 * -----------------------------------
 * `lyfe/zus.import.requested` is what a chart import already emits, and a
 * re-sync sends exactly that, with `reason` set so a run can be read. Not a
 * `lyfe/zus.resync.requested` alongside it.
 *
 * The retry budget, the per-clinic concurrency, the per-patient serialisation,
 * the fresh-enrolment wait ladder and — the one that matters — the rules about
 * what may be written over all live on that one function. A second event would
 * mean a second function, and a second function is a second copy of those
 * rules that nobody notices has drifted until a chart is wrong. The index and
 * the AI summary follow a re-sync for the same reason: they are downstream of
 * that function, not of this endpoint.
 *
 * THE TRUST BOUNDARY, WHICH IS THE SAME ONE AS `/api/imports/bulk`
 * ---------------------------------------------------------------
 * The caller's own Medplum token is verified by asking Medplum, and the
 * requester is taken from *that*, never from the body — see `trigger.ts`. On
 * top of it this endpoint checks that the patient is in the caller's own
 * compartment before queueing anything. The importer checks that again, and
 * refuses, so this is not what makes it safe; it is what keeps one clinic from
 * opening Tasks and burning runs against another clinic's patient ids.
 */

/** A source a patient's record can be re-pulled from. */
export interface ResyncSource {
  /** Wire id, as the client sends it. Matches `ImportSource` in the app. */
  readonly id: string;
  /** What the product calls it. `zus` is the Lyfe Data Network. */
  readonly label: string;
  /**
   * Build the event that starts the pull.
   * @param props - Who asked and about whom.
   * @param props.caller - The verified caller.
   * @param props.patientId - The Medplum patient id.
   * @returns The event to send.
   */
  readonly event: (props: { caller: Caller; patientId: string }) => LyfeEvents[keyof LyfeEvents];
}

/** Marks a run as having been asked for by a person rather than by the import chain. */
export const MANUAL_RESYNC_REASON = 'manual-resync';

/**
 * The sources a patient can be re-pulled from today.
 *
 * Only the Lyfe network is here, and that is a statement about the product
 * rather than a limitation of the shape: DrChrono's inbound contract is being
 * designed in a separate workstream, and wiring a button to it before that
 * lands would be inventing a second answer to a question already being
 * answered. A client asking for a source that is not in this map is told which
 * ones are.
 */
export const RESYNC_SOURCES: Record<string, ResyncSource> = {
  zus: {
    id: 'zus',
    label: 'Lyfe',
    event: ({ caller, patientId }) => ({
      name: 'lyfe/zus.import.requested' as const,
      data: {
        organizationId: caller.organizationId,
        requester: caller.profile,
        medplumPatientId: patientId,
        reason: MANUAL_RESYNC_REASON,
      },
    }),
  },
};

/** What a client may send. */
interface ResyncBody {
  /** A key of {@link RESYNC_SOURCES}. */
  source?: string;
  /** The Medplum patient id. */
  patientId?: string;
}

/**
 * Handle `POST /api/imports/resync`.
 * @param req - The request.
 * @param res - The response.
 * @returns Nothing; the reply is written to `res`.
 */
export async function handleResync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const token = bearerToken(req);
    if (!token) {
      send(res, 401, { error: 'Missing bearer token' });
      return;
    }
    const caller = await identify(token);
    if (!caller) {
      send(res, 401, { error: 'Token is not valid' });
      return;
    }

    const body = (await readJson(req)) as ResyncBody;
    const patientId = String(body?.patientId ?? '').trim();
    const sourceId = String(body?.source ?? '').trim();
    if (!patientId) {
      send(res, 400, { error: 'patientId is required' });
      return;
    }
    const source = RESYNC_SOURCES[sourceId];
    if (!source) {
      send(res, 400, {
        error: `Unknown source ${JSON.stringify(sourceId)}`,
        supported: Object.keys(RESYNC_SOURCES),
      });
      return;
    }

    if (!(await callerOwnsPatient({ caller, patientId }))) {
      // 404 rather than 403: whether another clinic has a patient under this
      // id is not something an unrelated caller gets to learn.
      send(res, 404, { error: 'No such patient' });
      return;
    }

    await inngest.send(source.event({ caller, patientId }));

    // 202, not 200. Nothing has been pulled yet — the run belongs to Inngest
    // from here, and the patient's own import Task is where its outcome shows
    // up. Saying "done" would be a lie that the UI would then have to unsay.
    send(res, 202, { queued: true, source: source.id, patientId });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Whether the patient is in the caller's own clinic compartment.
 *
 * Read with the worker's client, because a clinic user's own token cannot see
 * `meta.accounts`. The importer makes the same check and refuses; this one is
 * here so a mistyped or guessed id never gets as far as opening a Task.
 * @param props - The check inputs.
 * @param props.caller - The verified caller.
 * @param props.patientId - The Medplum patient id.
 * @returns True when the patient belongs to the caller's clinic.
 */
async function callerOwnsPatient(props: { caller: Caller; patientId: string }): Promise<boolean> {
  const medplum = await getMedplum();
  const patient = await medplum.readResource('Patient', props.patientId).catch(() => undefined as Patient | undefined);
  if (!patient) {
    return false;
  }
  const expected = `Organization/${props.caller.organizationId}`;
  return [patient.meta?.account, ...(patient.meta?.accounts ?? [])].some((a) => a?.reference === expected);
}
