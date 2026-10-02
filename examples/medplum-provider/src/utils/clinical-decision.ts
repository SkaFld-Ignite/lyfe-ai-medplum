// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The app's side of the two clinical-decision features.
 *
 * Types and labels are **duplicated on purpose**, following the same rule as
 * `patient-ai-summary.ts` and `chart-search.ts`: one definition per side of the
 * wire, values kept identical, with `clinical-decision.test.ts` importing both
 * and failing if they drift. The app is a browser bundle and the bot is a
 * `vmcontext` script.
 */
import type { RecordTone } from '../components/patient-shell/PatientRecordRow';

/** Must equal `InteractionSeverity` in `bots/shared/clinical-decision.ts`. */
export type InteractionSeverity = 'contraindicated' | 'major' | 'moderate' | 'unknown';

/** Must equal `INTERACTION_SEVERITY_LABELS` in `bots/shared/clinical-decision.ts`. */
export const INTERACTION_SEVERITY_LABELS: Record<InteractionSeverity, string> = {
  contraindicated: 'Contraindicated',
  major: 'Major',
  moderate: 'Moderate',
  unknown: 'Severity not stated',
};

/**
 * Badge colour per severity, in the `PatientRecordRow` tone vocabulary the
 * clinical tabs already use.
 */
export const INTERACTION_SEVERITY_TONES: Record<InteractionSeverity, RecordTone> = {
  contraindicated: 'rose',
  major: 'rose',
  moderate: 'amber',
  unknown: 'slate',
};

/** Must equal `IcdSuggestion` in `bots/shared/clinical-decision.ts`. */
export interface IcdSuggestion {
  code: string;
  description: string;
  basis: string;
  verified?: boolean;
}

/** Must equal `DrugInteraction` in `bots/shared/clinical-decision.ts`. */
export interface DrugInteraction {
  drugs: [string, string];
  severity: InteractionSeverity;
  effect: string;
  management?: string;
}

/** Identifier of the bot that runs both actions. */
export const CLINICAL_DECISION_BOT_IDENTIFIER = {
  system: 'https://lyfe.health/bots',
  value: 'lyfe-clinical-decision',
};

/** What the bot returns. */
export interface ClinicalDecisionBotResult {
  ok?: boolean;
  action?: 'icd-codes' | 'drug-interactions';
  suggestions?: IcdSuggestion[];
  terminologyAvailable?: boolean;
  documented?: { code: string; display?: string }[];
  medications?: string[];
  interactions?: DrugInteraction[];
  error?: string;
}
