// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/** Tag system the Lyfe importers stamp on every resource to record where it came from. */
export const LYFE_SOURCE_TAG_SYSTEM = 'https://lyfe.com/source';

/**
 * `_tag` search value matching resources imported from DrChrono. The provider app only shows
 * DrChrono data, so appointments and timeline searches are restricted to it on the server.
 */
export const DRCHRONO_SOURCE_TAG = `${LYFE_SOURCE_TAG_SYSTEM}|drchrono`;
