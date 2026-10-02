// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * ICD-10 coding suggestions and drug interaction review.
 *
 * These two features were only portable because their output can be checked
 * against the chart, so this file is mostly about what the validators **reject**:
 * a code that is not a code, a suggestion that cannot say where it came from, an
 * interaction naming a drug the patient is not taking, and — in every case — a
 * confidence score.
 */
import { describe, expect, test } from 'vitest';
import * as bot from '../../bots/shared/clinical-decision.ts';
import {
  groundDrugName,
  ICD10_CM_PATTERN,
  parseDrugInteractions,
  parseIcdSuggestions,
  sortInteractions,
} from '../../bots/shared/clinical-decision.ts';
import { INTERACTION_SEVERITY_LABELS } from './clinical-decision';

describe('codes shared with the bot', () => {
  test('match definition for definition', () => {
    expect(INTERACTION_SEVERITY_LABELS).toEqual(bot.INTERACTION_SEVERITY_LABELS);
  });
});

describe('ICD10_CM_PATTERN', () => {
  test('accepts real ICD-10-CM shapes', () => {
    for (const code of ['E11', 'E119', 'E11.9', 'I10', 'C50.911', 'Z85.3', 'N95.1', 'S72.001A']) {
      expect(ICD10_CM_PATTERN.test(code)).toBe(true);
    }
  });

  test('rejects things that are not codes', () => {
    // What a model returns when it has nothing to suggest.
    for (const code of ['', 'diabetes', 'U07.1', '11.9', 'E1', 'E11.', 'E11.ABCDE', 'ICD-10: E11.9']) {
      expect(ICD10_CM_PATTERN.test(code)).toBe(false);
    }
  });
});

describe('parseIcdSuggestions', () => {
  const good = {
    code: 'E11.9',
    description: 'Type 2 diabetes mellitus without complications',
    basis: 'Documented condition: Type 2 diabetes mellitus',
  };

  test('accepts a well-formed suggestion', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [good] }))).toEqual([good]);
  });

  test('accepts an empty answer, which is the correct answer most of the time', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [] }))).toEqual([]);
  });

  test('throws on output that is not JSON', () => {
    expect(() => parseIcdSuggestions('The patient is diabetic, code E11.9.')).toThrow(/did not return JSON/);
  });

  test('drops a suggestion with no basis, which is the shape an invented code takes', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, basis: '   ' }] }))).toEqual([]);
  });

  test('drops a suggestion whose code is not an ICD-10-CM code', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, code: 'diabetes' }] }))).toEqual([]);
  });

  test('drops a suggestion with no description', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, description: '' }] }))).toEqual([]);
  });

  test('upper-cases the code so the already-coded comparison is reliable', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, code: 'e11.9' }] }))[0].code).toBe('E11.9');
  });

  test('puts the dot back into a dotless code, so the terminology lookup can find it', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, code: 'E119' }] }))[0].code).toBe('E11.9');
    // A three-character code has no extension and must not grow a trailing dot.
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, code: 'I10' }] }))[0].code).toBe('I10');
  });

  test('drops a code the chart already carries', () => {
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: [good] }), ['e11.9'])).toEqual([]);
  });

  test('dedupes a repeated code', () => {
    const parsed = parseIcdSuggestions(JSON.stringify({ suggestions: [good, { ...good, basis: 'again' }] }));
    expect(parsed).toHaveLength(1);
  });

  test('caps the number of suggestions', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...good, code: `E1${i % 10}.${i}` }));
    expect(parseIcdSuggestions(JSON.stringify({ suggestions: many })).length).toBeLessThanOrEqual(
      bot.MAX_ICD_SUGGESTIONS
    );
  });

  test('carries no confidence score, whatever the model sends', () => {
    // Prod's `ICDCodeSuggestion` had one, and its no-Bedrock fallback returned
    // four canned oncology codes with hardcoded confidences of 0.95 and 0.9.
    const parsed = parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, confidence: 0.95 }] }));
    expect(parsed[0]).not.toHaveProperty('confidence');
  });

  test('does not mark anything verified — only the terminology server does that', () => {
    const parsed = parseIcdSuggestions(JSON.stringify({ suggestions: [{ ...good, verified: true }] }));
    expect(parsed[0].verified).toBeUndefined();
  });
});

describe('groundDrugName', () => {
  const list = ['Warfarin Sodium 5 MG Oral Tablet', 'Aspirin 81 MG Oral Tablet', 'Asacol HD 800 MG'];

  test('matches an ingredient the model named against the chart product name', () => {
    expect(groundDrugName('warfarin', list)).toBe('Warfarin Sodium 5 MG Oral Tablet');
  });

  test('matches when the model echoed the chart string and added to it', () => {
    expect(groundDrugName('Aspirin 81 MG Oral Tablet (daily)', list)).toBe('Aspirin 81 MG Oral Tablet');
  });

  test('does not match inside an unrelated word', () => {
    // Without the word boundary, "sacol" would ground against "Asacol HD" — a
    // different drug, and the warning would name a medication the patient is
    // not taking.
    expect(groundDrugName('sacol', list)).toBeUndefined();
  });

  test('rejects a drug that is not on the list', () => {
    expect(groundDrugName('clopidogrel', list)).toBeUndefined();
    expect(groundDrugName('  ', list)).toBeUndefined();
  });
});

describe('parseDrugInteractions', () => {
  const meds = ['Warfarin Sodium 5 MG Oral Tablet', 'Aspirin 81 MG Oral Tablet'];
  const good = {
    drugs: ['warfarin', 'aspirin'],
    severity: 'major',
    effect: 'Additive bleeding risk.',
    management: 'Monitor INR.',
  };

  test('accepts a grounded interaction and renames it to the chart strings', () => {
    expect(parseDrugInteractions(JSON.stringify({ interactions: [good] }), meds)).toEqual([
      {
        drugs: ['Warfarin Sodium 5 MG Oral Tablet', 'Aspirin 81 MG Oral Tablet'],
        severity: 'major',
        effect: 'Additive bleeding risk.',
        management: 'Monitor INR.',
      },
    ]);
  });

  test('drops an interaction naming a drug the patient is not taking', () => {
    // The grounding step, and the reason this feature was portable. A warning
    // about a drug that is not on the chart is wrong, not weak.
    const parsed = parseDrugInteractions(
      JSON.stringify({ interactions: [{ ...good, drugs: ['warfarin', 'clopidogrel'] }] }),
      meds
    );
    expect(parsed).toEqual([]);
  });

  test('drops a row that does not name exactly two drugs', () => {
    expect(parseDrugInteractions(JSON.stringify({ interactions: [{ ...good, drugs: ['warfarin'] }] }), meds)).toEqual(
      []
    );
    expect(
      parseDrugInteractions(
        JSON.stringify({ interactions: [{ ...good, drugs: ['warfarin', 'aspirin', 'aspirin'] }] }),
        meds
      )
    ).toEqual([]);
  });

  test('drops a row where both names ground to the same medication', () => {
    expect(
      parseDrugInteractions(
        JSON.stringify({ interactions: [{ ...good, drugs: ['warfarin', 'Warfarin Sodium'] }] }),
        meds
      )
    ).toEqual([]);
  });

  test('drops a row with no stated effect', () => {
    expect(parseDrugInteractions(JSON.stringify({ interactions: [{ ...good, effect: '' }] }), meds)).toEqual([]);
  });

  test('marks an ungraded row as unknown rather than assuming a severity', () => {
    // Defaulting to "moderate" would be the validator inventing the one field a
    // clinician triages on.
    const parsed = parseDrugInteractions(JSON.stringify({ interactions: [{ ...good, severity: 'spicy' }] }), meds);
    expect(parsed[0].severity).toBe('unknown');
  });

  test('dedupes the same pair given in either order', () => {
    const parsed = parseDrugInteractions(
      JSON.stringify({ interactions: [good, { ...good, drugs: ['aspirin', 'warfarin'] }] }),
      meds
    );
    expect(parsed).toHaveLength(1);
  });

  test('omits management when the model gave none', () => {
    const parsed = parseDrugInteractions(JSON.stringify({ interactions: [{ ...good, management: '' }] }), meds);
    expect(parsed[0]).not.toHaveProperty('management');
  });

  test('carries no confidence or overall-risk score', () => {
    const parsed = parseDrugInteractions(
      JSON.stringify({ interactions: [{ ...good, confidence: 0.9 }], overallRisk: 'CRITICAL' }),
      meds
    );
    expect(parsed[0]).not.toHaveProperty('confidence');
  });

  test('caps the number of interactions', () => {
    const list = Array.from({ length: 40 }, () => good);
    expect(parseDrugInteractions(JSON.stringify({ interactions: list }), meds).length).toBeLessThanOrEqual(
      bot.MAX_INTERACTIONS
    );
  });
});

describe('sortInteractions', () => {
  test('worst first, ungraded last', () => {
    const row = (severity: bot.InteractionSeverity): bot.DrugInteraction => ({
      drugs: [severity, 'x'],
      severity,
      effect: 'e',
    });
    const sorted = sortInteractions([row('unknown'), row('moderate'), row('contraindicated'), row('major')]);
    expect(sorted.map((i) => i.severity)).toEqual(['contraindicated', 'major', 'moderate', 'unknown']);
  });
});

describe('buildIcdPrompt', () => {
  test('names the blocks the system prompt refers to', () => {
    // The rules say "DOCUMENTED CONDITIONS" and "CHART NOTE" by name, so the
    // blocks have to carry those headings.
    const prompt = bot.buildIcdPrompt({ conditions: ['Hypertension (I10)'], reasons: [], note: 'BP well controlled.' });
    expect(prompt).toContain('DOCUMENTED CONDITIONS:');
    expect(prompt).toContain('- Hypertension (I10)');
    expect(prompt).toContain('CHART NOTE:');
    expect(prompt).toContain('BP well controlled.');
  });

  test('says explicitly when a block is empty rather than omitting it', () => {
    const prompt = bot.buildIcdPrompt({ conditions: [], reasons: [] });
    expect(prompt).toContain('- None recorded');
    expect(prompt).toContain('None recorded');
  });
});
