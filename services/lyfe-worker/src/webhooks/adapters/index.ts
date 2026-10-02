// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The provider registry.
 *
 * This is the entire cost of adding an EHR: write an adapter, add it to the
 * array below. Nothing in `receive.ts`, `dispatch.ts`, `events.ts`, `server.ts`
 * or the Inngest functions changes, and no clinic's configuration changes
 * either — a tenant gets a provider by having credentials saved for it, which
 * is data.
 *
 * Keep the array as the only registration point. A second place to register —
 * a switch, a lookup in the receiver, an `if (provider === 'drchrono')` — is
 * how the legacy design ended up with four of them.
 */
import type { InboundAdapter } from '../contract.ts';
import { drchronoAdapter } from './drchrono.ts';

/** Every provider that can deliver inbound events. */
export const ADAPTERS: readonly InboundAdapter[] = [drchronoAdapter];

const BY_ID = new Map<string, InboundAdapter>(ADAPTERS.map((adapter) => [adapter.id, adapter]));

// A duplicate id would make one adapter unreachable in a way that looks exactly
// like "that provider never delivers", which is a miserable thing to debug.
// Thrown at import time so it cannot reach a deploy.
if (BY_ID.size !== ADAPTERS.length) {
  throw new Error('Two inbound adapters share an id');
}

/**
 * Resolve an adapter by the id in a callback URL.
 * @param id - The provider path segment.
 * @returns The adapter, or undefined when no provider claims that id.
 */
export function getAdapter(id: string): InboundAdapter | undefined {
  return BY_ID.get(id);
}

/**
 * Every registered provider id, for the health endpoint and error messages.
 * @returns The ids, in registration order.
 */
export function adapterIds(): string[] {
  return ADAPTERS.map((adapter) => adapter.id);
}
