# lyfe-ai-medplum

Fork of the Medplum monorepo. Lyfe's provider platform is being rebuilt here on
`examples/medplum-provider`, replacing the Next.js + Prisma + Supabase app in
`lyfe-provider-ui`.

**Linear project:** [Medplum Platform Migration](https://linear.app/lyfe-ai/project/medplum-platform-migration-6fde7dfc6a64)

## Every task has a Linear issue

Non-negotiable, and it applies to Claude as much as to a person.

1. **Before starting work**, there is a Linear issue for it. If one does not
   exist, create it in the `Lyfe AI` team first.
2. **Branch from the issue.** Linear generates the branch name — copy it off the
   issue (`muhammadtalha/lyf2-209-move-bulk-loop-server-side`). The identifier in
   the branch name is what links the PR.
3. **Every PR references the issue** in its title or body: `Fixes LYF2-209`,
   `Closes LYF2-209`, or bare `LYF2-209` to link without auto-closing.
4. Merging a PR with a magic word moves the issue to Done automatically.

Nothing merges without an issue behind it. Four PRs merged before this rule
existed and there was no way to tell from Linear that anyone was working on
them.

> **Known gap:** Linear's GitHub sync currently points at
> `Lyfe-AI/lyfe-ai-medplum`, but `origin` here is
> `SkaFld-Ignite/lyfe-ai-medplum`. Until those match, magic words will not link.
> Tracked in LYF2-215.

## Architecture rules

These come from the migration brief and override any Medplum default that
conflicts with them.

1. **Use Medplum's way.** If Medplum supports something, use it. No parallel
   implementation of a thing the platform already does.
2. **No new data types.** Everything is FHIR R4. No bespoke tables, no bespoke
   job records. A job is a `Task`. An office is a `Location`. A payer is an
   `Organization`.
3. **Minimum custom logic.** Build the thin layer; let the server do the rest.
4. **No changes to the source data model.** DrChrono and Zus stay as they are.

## Conventions that cost real time to learn

- **Provenance is `meta.tag`**, system `https://lyfe.com/source`, defined once in
  `bots/shared/source.ts`. Never write the literal anywhere else — a one-character
  drift silently empties whole screens *and* breaks Zus echo prevention.
- **No `Promise.all` around Medplum searches inside a bot.** Concurrent searches
  auto-batch, and the batch flush uses `setTimeout`, which the `vmcontext`
  sandbox does not have. The bot hangs forever with no error. Await sequentially.
- **Normalise ids through `refKey`/`lookup`** at every cross-reference site.
  DrChrono returns an appointment `id` as a string and references it as a number.
- **DrChrono timestamps are naive clinic wall-clock.** Always pass `ctx.timeZone`
  to `toInstant()`. Date-only fields (`YYYY-MM-DD`) must not go through it at all.
- **A reference from Zus points into Zus's project and dangles here.** Check that
  it resolves before trusting it; see `bots/shared/payers.ts` for the pattern.
- **No `Zus-Account` header on Zus writes** — reads take it, writes 403 with an
  impersonation error.
- **Read `docs/source-system-field-guide.md`** before mapping a new resource
  type, and add what you learn back to it.

## Where things live

```
examples/medplum-provider/
  bots/           # Medplum Bots — all ingestion runs here
    shared/       # source tags, progress/Task reporting, payers, zus-push, directory
  src/pages/      # directory/, imports/, onboarding/, patients/, schedule/
  src/services/   # thin UI service layer over MedplumClient
scripts/
  setup-tenancy.ts  # AccessPolicy + compartment definitions
docs/
  source-system-field-guide.md
```
