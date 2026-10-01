// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent } from '@medplum/core';

/**
 * Building the event an importer expects, outside the Medplum bot runtime.
 *
 * Two fields carry weight here, and both are easy to pass as empty and then
 * spend an hour debugging.
 *
 * **`requester`** decides which clinic the import writes into. The importers
 * resolve it from the caller's own ProjectMembership rather than from their
 * input, because taking an `organizationId` argument would be an IDOR — pass
 * another clinic's id and its chart gets written under your session. Moving the
 * work out of Medplum does not move that rule, so the event carries whoever
 * asked and the importer resolves the clinic from them exactly as before.
 *
 * **`secrets`** were populated by Medplum from project secrets when a bot ran
 * there. Nothing populates them out here, so the worker supplies them from its
 * own environment — which is where a deployed service's secrets belong anyway.
 */

/** The secret the importers use to decrypt a clinic's stored credentials. */
const ENCRYPTION_KEY_SECRET = 'LYFE_CREDENTIAL_ENCRYPTION_KEY';

/**
 * Build a BotEvent for an importer.
 * @param requester - Reference to whoever asked, e.g. `Practitioner/abc`.
 * @param input - The importer's own input.
 * @returns An event the importer can run on.
 */
export function botEvent<T>(requester: string, input: T): BotEvent<T> {
  const material = process.env[ENCRYPTION_KEY_SECRET];
  if (!material) {
    // Failed loudly and early rather than letting the importer report a
    // missing project secret, which is misleading out here: there is no
    // project secret involved, only this worker's environment.
    throw new Error(
      `${ENCRYPTION_KEY_SECRET} is not set. The worker decrypts each clinic's stored ` +
        `credentials with it; copy it from the Medplum project secrets into the worker's environment.`
    );
  }
  return {
    bot: { reference: 'Bot/lyfe-worker' },
    contentType: 'application/json',
    secrets: { [ENCRYPTION_KEY_SECRET]: { name: ENCRYPTION_KEY_SECRET, valueString: material } },
    requester: { reference: requester },
    input,
  };
}
