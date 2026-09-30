// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tag system the Lyfe importers stamp on every resource to record where it came from.
 *
 * Must stay identical to `LYFE_SOURCE_TAG_SYSTEM` in `bots/shared/source.ts`.
 * The two once disagreed — the DrChrono bot wrote `https://lyfe.health/source`
 * — and because this value is only ever used inside a `_tag` search filter,
 * the mismatch failed silently: the scheduling calendar, the patient timeline
 * and the encounters list all returned nothing while the data was there.
 */
export const LYFE_SOURCE_TAG_SYSTEM = 'https://lyfe.com/source';

/**
 * `_tag` search value matching resources imported from DrChrono. The provider app only shows
 * DrChrono data, so appointments and timeline searches are restricted to it on the server.
 */
export const DRCHRONO_SOURCE_TAG = `${LYFE_SOURCE_TAG_SYSTEM}|drchrono`;
