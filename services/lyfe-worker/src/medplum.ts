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
  const baseUrl = requiredEnv('MEDPLUM_BASE_URL');
  const clientId = requiredEnv('MEDPLUM_CLIENT_ID');
  const clientSecret = requiredEnv('MEDPLUM_CLIENT_SECRET');
  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(clientId, clientSecret);
  return medplum;
}

/**
 * Read a required environment variable.
 *
 * Surrounding quotes are stripped, because whether they survive depends on who
 * reads the file. Node's `--env-file` removes them; Docker's `--env-file` does
 * not, so the same `.env` that works locally yields a base URL beginning with a
 * quote character inside a container — which surfaces as "Base URL must start
 * with http or https" and sends you looking at the URL rather than the quoting.
 * @param name - The variable name.
 * @returns Its value, unquoted and trimmed.
 */
export function requiredEnv(name: string): string {
  const raw = process.env[name]?.trim();
  const value = raw?.replace(/^(['"])(.*)\1$/, '$2');
  if (!value) {
    throw new Error(`${name} is required. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
