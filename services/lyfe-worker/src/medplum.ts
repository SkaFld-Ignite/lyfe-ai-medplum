// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient } from '@medplum/core';

/**
 * The worker's Medplum connection.
 *
 * One client for the process, logged in once and reused. A client login costs
 * a round trip and a token; doing it per patient would add one to every import
 * in a thousand-patient run for nothing.
 *
 * The client authenticates as a ClientApplication, which must carry the clinic
 * access policy **with an `organization` parameter** on its ProjectMembership.
 * Without it every import refuses with "not scoped to an organization" — a
 * machine client has no logged-in user to inherit a clinic from, so it has to
 * be told which one it acts for.
 */

let client: Promise<MedplumClient> | undefined;

/**
 * The shared, authenticated Medplum client.
 * @returns A logged-in client.
 */
export function getMedplum(): Promise<MedplumClient> {
  client ??= login().catch((err) => {
    // Not remembered on failure: fixing the credentials or the access policy
    // should take effect without restarting the worker.
    client = undefined;
    throw err;
  });
  return client;
}

/**
 * Log in as the worker's ClientApplication.
 * @returns The authenticated client.
 */
async function login(): Promise<MedplumClient> {
  const baseUrl = required('MEDPLUM_BASE_URL');
  const clientId = required('MEDPLUM_CLIENT_ID');
  const clientSecret = required('MEDPLUM_CLIENT_SECRET');
  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(clientId, clientSecret);
  return medplum;
}

/**
 * Read a required environment variable.
 * @param name - The variable name.
 * @returns Its value.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
