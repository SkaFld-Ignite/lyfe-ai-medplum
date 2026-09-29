// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Organization, ProjectMembership, Reference } from '@medplum/fhirtypes';

/** ProjectMembership access parameter that binds a user to their clinic. */
export const ORGANIZATION_PARAMETER = 'organization';

/**
 * Resolve the caller's clinic from their own ProjectMembership.
 *
 * Deliberately derived from `event.requester` — which the server sets from the
 * authenticated membership — and never from anything the caller supplies. An
 * organization id accepted as an argument would let one clinic read another's
 * data by passing its id, which is the IDOR class lyfe-provider-ui had to fix.
 *
 * Exactly one organization is required. lyfe-provider-ui's
 * `createDrChronoServiceForUser` once picked `orderBy: updatedAt desc` then
 * `[0]`, which silently handed a multi-clinic user whichever tenant's
 * credentials were touched most recently. Ambiguity fails closed here instead.
 * @param props - The lookup inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.requester - `event.requester`, set by the server from the caller's membership.
 * @returns A reference to the caller's single organization.
 */
export async function resolveCallerOrganization(props: {
  medplum: MedplumClient;
  requester: BotEvent['requester'];
}): Promise<Reference<Organization>> {
  const profile = props.requester?.reference;
  if (!profile) {
    throw new Error('No requester on this execution: the caller could not be identified');
  }

  const memberships = (await props.medplum.searchResources(
    'ProjectMembership',
    `profile=${encodeURIComponent(profile)}&_count=50`
  )) as ProjectMembership[];

  const references = new Set<string>();
  for (const membership of memberships) {
    for (const access of membership.access ?? []) {
      for (const parameter of access.parameter ?? []) {
        const reference = parameter.valueReference?.reference;
        if (parameter.name === ORGANIZATION_PARAMETER && reference?.startsWith('Organization/')) {
          references.add(reference);
        }
      }
    }
  }

  if (references.size === 0) {
    throw new Error(
      `${profile} is not scoped to an organization. ` +
        'Assign the clinic access policy with an "organization" parameter on their ProjectMembership.'
    );
  }
  if (references.size > 1) {
    throw new Error(
      `${profile} is scoped to ${references.size} organizations (${[...references].join(', ')}). ` +
        'Refusing to guess which clinic this call is for.'
    );
  }

  return { reference: [...references][0] };
}
