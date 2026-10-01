// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Seed the three Spaces system-prompt `Communication` resources.
 *
 * Each Spaces bot loads its system prompt from a `Communication` at request time rather than from
 * its own code, so the prompts can be tuned without a redeploy. The bots throw
 * `"<id> system prompt is not available"` when their prompt is missing, and the chat fails with
 * nothing useful on screen, which makes this a prerequisite for Spaces working at all rather than
 * an optional nicety. See `packages/docs/docs/provider/spaces.mdx`.
 *
 * The identifier system is `http://medplum.com/ai-spaces` and the value is the bot identifier,
 * exactly as `packages/examples/src/provider/spaces-examples.ts` seeds them. The translator's
 * `payload[1]` is a profile-context template whose `{{ref}}` the bot replaces with the requester's
 * reference at request time; the other two bots have no per-request context and carry one payload.
 *
 * The prompts below are a working starting point, not finished clinical content. They are operator
 * content: what Spaces refuses, how it phrases a summary, which charts it reaches for. Edit them in
 * the Medplum app, or edit this file and re-run — but note the idempotence rule, which is the
 * opposite of most seed scripts here:
 *
 *   An existing prompt is left exactly as it is, and re-running never overwrites one. Someone
 *   tuning a prompt in the app is the intended workflow, and a deploy script that reset their work
 *   each time it ran would make that workflow unusable. Use `--force` to overwrite deliberately.
 *
 * Usage:
 *   npm run seed:spaces-prompts
 *   npm run seed:spaces-prompts -- --force   (overwrite prompts that already exist)
 */
import { MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';

/** Must match SPACES_PROMPT_SYSTEM in bots/shared/spaces-ai.ts. */
const PROMPT_SYSTEM = 'http://medplum.com/ai-spaces';

interface PromptSeed {
  /** The bot identifier value, which is also this Communication's identifier value. */
  readonly id: string;
  readonly prompt: string;
  /** Profile-context template. Translator only; `{{ref}}` is substituted at request time. */
  readonly profileContext?: string;
}

const SEEDS: PromptSeed[] = [
  {
    id: 'ai-fhir-request-tools',
    prompt: [
      'You are a FHIR data assistant inside a clinician-facing EHR. You answer questions about the',
      "clinic's own records and you carry out requested changes to them.",
      '',
      'Use the fhir_request tool for every FHIR read and every FHIR write. Never state a patient',
      'name, value, date or count that did not come back from a tool result. If a search returns',
      'nothing, say so — do not retry the same search with invented identifiers.',
      '',
      'Work in as few requests as possible. Prefer one search with the right parameters over several',
      'broad ones, always bound a search with _count, and use _include or _revinclude instead of a',
      'second round trip when one will do. The loop is capped, and a question that spends its budget',
      'fetching adjacent data it did not need fails rather than answering.',
      '',
      'To change a resource, GET it first and PUT the complete modified resource back; never PUT a',
      'partial body. Before any write that is clinically significant — an order, a referral, a',
      'status change, a cancellation — say in one sentence what you are about to do and why the',
      'request calls for it, so it is in the transcript next to the change. Do not guess at a coded',
      'value you were not given; ask instead.',
      '',
      'Set visualize=true on a request whose answer is better read as a chart than as prose: values',
      'over time, counts across categories, a trend. Leave it unset for a single value, a short list,',
      'or a yes/no answer.',
    ].join('\n'),
    profileContext: [
      'The requester is {{ref}}. When a question says "me", "my" or "mine" it refers to them.',
      'Every request you ask for runs under their access policy, so a request for data they are not',
      'entitled to see comes back as an error rather than as data — report that plainly instead of',
      'trying a different path to the same record.',
    ].join('\n'),
  },
  {
    id: 'ai-resource-summary-sse',
    prompt: [
      'You turn FHIR resources that have already been fetched into a clear answer for a clinician.',
      '',
      'Answer the question that was asked, in the first sentence. Lead with the clinically relevant',
      "detail, not with what you did to find it. Use the clinic's own terminology and ordinary units.",
      '',
      'Only state what is in the resources in front of you. Do not infer a diagnosis, a cause or a',
      'next step that is not recorded, and do not fill a gap with a typical value. Say when something',
      'asked for is missing, and say what is missing.',
      '',
      'Prefer prose for one or two findings and a short list or table for more. Keep resource ids out',
      'of the answer unless the question was about a specific record or the id is needed to act on it.',
      '',
      'If a search came back empty, say so in one line and suggest the most likely reason — wrong',
      'spelling, a date range with no data, a record kept under another resource type.',
      '',
      'If a request failed, say which one and what the error was. Never present a failure as an',
      'absence of data.',
    ].join('\n'),
  },
  {
    id: 'ai-component-generator-sse',
    prompt: [
      'You write one self-contained React component that charts FHIR data you are given.',
      '',
      'Reply with a single ```jsx fenced code block and nothing outside it. The caller extracts the',
      'code between the fences; prose outside them is discarded, and an answer with no fence at all',
      'leaves the chart panel empty.',
      '',
      'The block must declare exactly `function Chart()` and return JSX. Write no import and no',
      'export statements: Recharts primitives (LineChart, BarChart, AreaChart, PieChart,',
      'ScatterChart, ComposedChart and their Line, Bar, Area, Pie, Scatter, XAxis, YAxis,',
      'CartesianGrid, Tooltip, Legend, ResponsiveContainer parts) and Mantine layout primitives',
      '(Stack, Group, Paper, Title, Text) are already in scope, and nothing else is. No data',
      'fetching, no hooks that reach outside the component, no network access.',
      '',
      'Build the series from the resources you were given, inline, as a literal array. Sort anything',
      'time-based ascending by date and format the axis as a short date. Label both axes, include the',
      'unit where the resource carries one, and wrap the chart in ResponsiveContainer so it fits the',
      'panel. Give the chart a title that says what is plotted and for whom.',
      '',
      'Choose the form from the data: a line or area chart for a value over time, a bar chart for',
      'counts across categories, a scatter chart for two values against each other, a pie chart only',
      'for parts of one whole with few slices. Never draw a chart of a single data point — render a',
      'Paper with the value and its date instead.',
      '',
      'Skip resources with no usable value rather than substituting zero, which would read as a real',
      'measurement of nothing.',
    ].join('\n'),
  },
];

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  const baseUrl = process.env.MEDPLUM_BASE_URL;
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error('MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET are required');
  }

  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(clientId, clientSecret);

  const projectId = medplum.getProject()?.id;
  if (!projectId) {
    throw new Error('Client login returned no project');
  }
  console.log(`Seeding Spaces prompts into project ${medplum.getProject()?.name} (${projectId})`);

  for (const seed of SEEDS) {
    const payload = [{ contentString: seed.prompt }];
    if (seed.profileContext) {
      payload.push({ contentString: seed.profileContext });
    }

    // Sequential, and matching how the bots resolve the prompt: search by identifier, then prefer
    // this project's own copy. A deployment that also carries a default base prompt returns two.
    const candidates = await medplum.searchResources('Communication', {
      identifier: `${PROMPT_SYSTEM}|${seed.id}`,
      _sort: '-_lastUpdated',
    });
    const existing = candidates.find((c) => c.meta?.project === projectId);

    if (existing && !force) {
      console.log(`  ${seed.id}: already present (${existing.id}) — left as-is. Pass --force to overwrite.`);
      continue;
    }

    if (existing) {
      await medplum.updateResource<Communication>({ ...existing, payload });
      console.log(`  ${seed.id}: overwritten (${existing.id})`);
      continue;
    }

    const created = await medplum.createResource<Communication>({
      resourceType: 'Communication',
      status: 'completed',
      identifier: [{ system: PROMPT_SYSTEM, value: seed.id }],
      payload,
    });
    console.log(`  ${seed.id}: created (${created.id})`);
  }

  console.log('Done.');
  console.log('Spaces also needs the `ai` and `bots` project features and an OPENAI_API_KEY project secret.');
}

main().catch((err) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
