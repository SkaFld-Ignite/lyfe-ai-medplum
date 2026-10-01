// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The seeded prompts against the chat UI's citation parser.
 *
 * Inline citations are the one behaviour in Spaces that neither half can deliver alone: the UI can
 * only render a marker the model emits, and only a prompt can cause the model to emit one. There is
 * no type, no build step and no runtime check connecting the two — a prompt that quietly loses the
 * protocol produces an assistant that answers perfectly and cites nothing, which reads as a UI bug.
 *
 * The regexes below are copied, deliberately, from `src/components/lyfe-ai/citations.ts`. They are
 * duplicated rather than imported because the parser and these prompts have shipped on separate
 * branches and either can arrive first; if that file is ever importable from here, import it and
 * delete these two lines. The test that matters either way is the one asserting the key sets are
 * equal — that is what catches a key added to one side and not the other.
 */
import { describe, expect, test } from 'vitest';
import { SPACES_PROMPT_SEEDS, TAB_CITATION_KEYS } from './spaces-prompts.ts';

/** Copied from `citations.ts`: `const DOC_CITE_RE = /\[doc:(S\d+)\]/g;` */
const DOC_CITE_RE = /\[doc:(S\d+)\]/g;

/**
 * Copied from `citations.ts`, which builds it as
 * `new RegExp(`\\[(${Object.keys(TAB_CITATIONS).join('|')})\\]`, 'g')`.
 */
const TAB_CITE_RE = new RegExp(`\\[(${TAB_CITATION_KEYS.join('|')})\\]`, 'g');

/** The keys `TAB_CITATIONS` declares in `src/components/lyfe-ai/citations.ts`, in its order. */
const UI_TAB_KEYS = [
  'meds',
  'conditions',
  'allergies',
  'vitals',
  'labs',
  'encounters',
  'demographics',
  'immunizations',
];

/**
 * Finds one seeded prompt.
 * @param id - The bot identifier value.
 * @returns The prompt text.
 */
function promptFor(id: string): string {
  const seed = SPACES_PROMPT_SEEDS.find((s) => s.id === id);
  if (!seed) {
    throw new Error(`no seed for ${id}`);
  }
  return seed.prompt;
}

const SUMMARY = promptFor('ai-resource-summary-sse');
const TRANSLATOR = promptFor('ai-fhir-request-tools');
const VISUALIZER = promptFor('ai-component-generator-sse');

describe('the chart-section keys the prompts teach', () => {
  test('are exactly the keys the UI can match, with no extras and none missing', () => {
    // The test this file exists for. A key on one side only is invisible until a clinician sees
    // "[procedures]" as literal text, or a working section is never cited because nothing names it.
    expect([...TAB_CITATION_KEYS]).toStrictEqual(UI_TAB_KEYS);
  });

  test('include encounters, plural, which is the emitted key and not the tab id', () => {
    // `citations.ts` maps the key `encounters` to the tab id `encounter`. Emitting the tab id would
    // match nothing.
    expect(TAB_CITATION_KEYS).toContain('encounters');
    expect(TAB_CITATION_KEYS as readonly string[]).not.toContain('encounter');
  });

  test.each(['ai-resource-summary-sse', 'ai-fhir-request-tools'])('are all listed in %s', (id) => {
    const prompt = promptFor(id);
    for (const key of TAB_CITATION_KEYS) {
      expect(prompt).toContain(key);
    }
  });

  test.each(['ai-resource-summary-sse', 'ai-fhir-request-tools'])(
    '%s shows a bracketed example the UI regex actually matches',
    (id) => {
      const matches = [...promptFor(id).matchAll(TAB_CITE_RE)];
      expect(matches.length).toBeGreaterThan(0);
      expect(TAB_CITATION_KEYS as readonly string[]).toContain(matches[0][1]);
    }
  );
});

describe('the source-citation protocol', () => {
  test('the summary prompt shows a [doc:Sn] example the UI regex matches', () => {
    const matches = [...SUMMARY.matchAll(DOC_CITE_RE)];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0][1]).toBe('S1');
  });

  test('the summary prompt explains that Sn indexes the list it is given', () => {
    expect(SUMMARY).toMatch(/numbered list of the sources/i);
    expect(SUMMARY).toMatch(/first/i);
  });

  test('the summary prompt forbids inventing an index', () => {
    // A marker that resolves to the wrong record is worse than no marker: it reads as a fact.
    expect(SUMMARY).toMatch(/never invent or guess a number/i);
  });

  test('the translator prompt forbids source citations outright', () => {
    // Its prose only reaches the user when the loop made no tool calls, so it never has sources.
    expect(TRANSLATOR).toMatch(/never write a \[doc:\.\.\.\] marker/i);
    expect([...TRANSLATOR.matchAll(DOC_CITE_RE)]).toStrictEqual([]);
  });
});

describe('the literal-marker rule', () => {
  test.each(['ai-resource-summary-sse', 'ai-fhir-request-tools'])('%s forbids backticks and code blocks', (id) => {
    // The production bug this prevents: `CitedMarkdown` rewrites only string children of the
    // markdown tree, so a marker inside a code span stays a `<code>` element and the clinician is
    // shown the brackets.
    const prompt = promptFor(id);
    expect(prompt).toMatch(/never put one in backticks/i);
    expect(prompt).toMatch(/code block/i);
  });

  test.each(['ai-resource-summary-sse', 'ai-fhir-request-tools'])('%s asks for markers inline, not in a list', (id) => {
    expect(promptFor(id)).toMatch(/directly\s+after the statement it supports/i);
  });
});

describe('the visualizer prompt', () => {
  test('forbids citation markers, because its output is code and is never parsed for them', () => {
    expect(VISUALIZER).toMatch(/write no citation markers/i);
  });

  test('teaches no protocol of its own', () => {
    expect([...VISUALIZER.matchAll(DOC_CITE_RE)]).toStrictEqual([]);
    expect([...VISUALIZER.matchAll(TAB_CITE_RE)]).toStrictEqual([]);
  });
});

describe('what the prompts do not promise', () => {
  test('the summary prompt names the statements that cannot be cited', () => {
    // The chat's patient-mode empty state used to say "Every claim is cited". That is not
    // achievable for an empty search, a failed request, or a total worked out across records, and a
    // prompt that demanded it would get an invented marker instead of an honest gap — so the copy
    // now reads "Claims are cited to the records they came from", and this list is why.
    expect(SUMMARY).toMatch(/no source to cite/i);
    expect(SUMMARY).toMatch(/came back empty/i);
    expect(SUMMARY).toMatch(/request failed/i);
  });
});

describe('the document-search tool', () => {
  test('the translator prompt names the tool and says when to reach for it', () => {
    // A tool the model is handed but never told about is a tool it does not call: the index would
    // be built, queryable, and still never queried.
    expect(TRANSLATOR).toContain('search_documents');
    expect(TRANSLATOR).toMatch(/written inside a document rather than/i);
  });

  test('the translator prompt distinguishes it from a DocumentReference search', () => {
    // The two are easy to confuse and answer different questions: one says a document exists, the
    // other says what is in it.
    expect(TRANSLATOR).toMatch(/tells you a document exists/i);
  });

  test('the summary prompt says how a document passage names its source', () => {
    // Document hits share the one `[doc:Sn]` numbering by being `DocumentReference` references in
    // the same source list. If the prompt stops saying so, passages stop being cited while
    // everything else still is — which looks like the RAG results being untrustworthy.
    expect(SUMMARY).toContain('DocumentReference');
    expect(SUMMARY).toMatch(/in the numbered source list like any other/i);
  });

  test('the summary prompt does not let an old letter be read as the current value', () => {
    expect(SUMMARY).toMatch(/never present a value read out of\s+an old letter as the current one/i);
  });
});
