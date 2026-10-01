// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

export interface SpaceModelOption {
  value: string;
  label: string;
}

/**
 * Name of the Project.setting entry that holds the list of selectable AI models.
 * The value should be a JSON-encoded array of {@link SpaceModelOption} objects, e.g.
 * `[{"value":"gpt-5.5","label":"GPT-5.5"},{"value":"my-litellm-model","label":"Custom"}]`.
 * Manage it from the project admin "Settings" page.
 */
export const AI_MODELS_SETTING = 'aiModels';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  label: string;
}

/**
 * Reasoning effort levels selectable next to the model.
 * The value is passed to the AI bots as the `reasoning_effort` input parameter.
 */
export const REASONING_EFFORTS: ReasoningEffortOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

/** Reasoning effort preselected for a new conversation. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

/** Built-in fallback used when the project has not configured `aiModels`. */
export const DEFAULT_MODELS: SpaceModelOption[] = [
  // Upstream Medplum ships a list of OpenAI models here. This deployment reaches
  // exactly one model — Claude Sonnet 4.6 on Bedrock, via the LiteLLM bridge that
  // `LLM_BASE_URL` points at — so the upstream list is not a useful fallback: it is
  // a list of models that do not exist here, and a request for one comes back
  // `Invalid model name` from LiteLLM.
  //
  // This fallback is load-bearing rather than cosmetic. `getProjectModels` reads
  // `aiModels` off `medplum.getProject()`, and a non-admin clinic user does not see
  // `Project.setting` — so for every real clinician the fallback IS the list. It
  // shipped showing "GPT-6 Astra", which would have been both wrong and expensive
  // if it had resolved to anything.
  { value: 'global.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];

/**
 * Reads the selectable AI model list from the current project's settings.
 * Falls back to {@link DEFAULT_MODELS} when the setting is missing, empty, or malformed.
 * @param medplum - The Medplum client.
 * @returns The list of model options to show in the model picker.
 */
export function getProjectModels(medplum: MedplumClient): SpaceModelOption[] {
  const valueString = medplum.getProject()?.setting?.find((s) => s.name === AI_MODELS_SETTING)?.valueString;
  if (valueString) {
    try {
      const parsed = JSON.parse(valueString);
      if (Array.isArray(parsed)) {
        const models = parsed
          .filter(
            (m): m is { value: string; label?: unknown } =>
              Boolean(m) && typeof m.value === 'string' && m.value.length > 0
          )
          .map((m) => ({ value: m.value, label: typeof m.label === 'string' && m.label ? m.label : m.value }));
        if (models.length > 0) {
          return models;
        }
      }
    } catch {
      // Ignore malformed JSON and fall back to defaults.
    }
  }
  return DEFAULT_MODELS;
}

/**
 * Returns the default model value to preselect — the first entry in the list.
 * @param models - The available model options.
 * @returns The default model value.
 */
export function getDefaultModel(models: SpaceModelOption[]): string {
  return models[0]?.value ?? DEFAULT_MODELS[0].value;
}
