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
 * The prompt text lives in `spaces-prompts.ts`, as data with no side effects, so that a test can
 * check it: the inline citation protocol in there is a contract with the chat UI's parser, and
 * there is no other way to verify it.
 *
 * Those prompts are a working starting point, not finished clinical content. They are operator
 * content: what Spaces refuses, how it phrases a summary, which charts it reaches for. Edit them in
 * the Medplum app, or edit that file and re-run — but note the idempotence rule, which is the
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
import { SPACES_PROMPT_SEEDS } from './spaces-prompts.ts';

/** Must match SPACES_PROMPT_SYSTEM in bots/shared/spaces-ai.ts. */
const PROMPT_SYSTEM = 'http://medplum.com/ai-spaces';

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

  for (const seed of SPACES_PROMPT_SEEDS) {
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
