// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Coding } from '@medplum/fhirtypes';

/**
 * The tag every Lyfe importer stamps to record where a resource came from.
 *
 * This lives in one place because the two bots once disagreed about it: the
 * DrChrono importer wrote `https://lyfe.health/source` while the Zus importer
 * and the whole front end used `https://lyfe.com/source`. Nothing failed
 * loudly. The searches that filter on the tag simply matched nothing, so the
 * scheduling calendar, the patient timeline and the encounters list were all
 * permanently empty of DrChrono data while every underlying resource was
 * present and correct.
 *
 * A one-word difference in a string that only ever appears inside a search
 * filter is close to invisible in review, so the fix is to leave exactly one
 * definition per side of the wire: this module for the bots, and
 * `src/utils/data-source.ts` for the app. Their values must stay identical.
 */
export const LYFE_SOURCE_TAG_SYSTEM = 'https://lyfe.com/source';

/** Stamped on everything imported from DrChrono. */
export const DRCHRONO_SOURCE_TAG: Coding = { system: LYFE_SOURCE_TAG_SYSTEM, code: 'drchrono' };

/** Stamped on everything mirrored from Zus. */
export const ZUS_SOURCE_TAG: Coding = { system: LYFE_SOURCE_TAG_SYSTEM, code: 'zus' };
