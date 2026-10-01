# lyfe-worker

Runs Lyfe's DrChrono and Zus imports as Inngest functions.

## Why this exists

The imports were Medplum Bots on the `vmcontext` runtime, which executes
**inside the Medplum server process**. That capped concurrency at what one
instance could hold — about six patients at a time — so a thousand-patient day
was measured in days, and a bot could not run longer than its timeout.

Three workload shapes made that untenable:

| Workload                   | Duration     | Why the bot runtime could not do it               |
| -------------------------- | ------------ | ------------------------------------------------- |
| DrChrono chart             | ~2 min       | fine, but only ~6 at once                         |
| Zus pull, enrolled patient | up to 19 min | near the execution ceiling                        |
| Zus **fresh** enrolment    | hours        | far past any ceiling; nothing should be held open |

Inngest handles all three: horizontal execution, per-clinic concurrency, and
`step.sleep` so an hours-long wait suspends the run instead of holding a worker.

## Visibility lives in two places, on purpose

Inngest and Medplum answer different questions, and both get asked.

- **Inngest** — "why did forty imports fail last night?" Run history, step
  timings, retries, replay. Keyed on function runs.
- **Medplum `Task`** — "did Maria Gonzalez import, and did her labs land?"
  Keyed on the patient, stored beside the clinical data, and read by the
  existing `/imports` page, which keeps working unchanged.

Neither replaces the other, so every run writes both, and they are cross-linked:

- the `Task` carries the Inngest **run id** (`https://lyfe.com/inngest/run`)
- the Inngest run carries the **patient id** it wrote

Without that link you have two dashboards and no way between them.

## Running it locally

```bash
cp .env.example .env          # fill in MEDPLUM_* values
npm run dev                   # this worker, on :3020
npm run inngest               # Inngest Dev Server, on :8288
```

Then open http://localhost:8288 and send an event:

```json
{
  "name": "lyfe/chart.import.requested",
  "data": { "organizationId": "<id>", "requester": "Practitioner/<id>", "drchronoPatientId": "120118105" }
}
```

The Zus pull is not a separate thing to ask for: a finished chart import always
emits `lyfe/zus.import.requested` for that patient. Whether the patient may be
enrolled is decided inside the importer from the office their encounters are at
(the Directory page's Zus column), and an ineligible one closes as skipped.

## Required: the worker's client must be org-scoped

The worker authenticates as a `ClientApplication`. A machine client has no
logged-in user to inherit a clinic from, so its `ProjectMembership` must carry
the clinic access policy **with an `organization` parameter**:

```json
"access": [{
  "policy": { "reference": "AccessPolicy/<clinic-policy>" },
  "parameter": [
    { "name": "organization", "valueReference": { "reference": "Organization/<clinic>" } }
  ]
}]
```

Without it every import fails with _"... is not scoped to an organization"_,
thrown by `bots/shared/tenant.ts`. Being a project admin is not enough — the
check looks for the parameter, not for privilege.

## What is still Medplum's

The import logic itself did not move. `bots/drchrono-import.ts` and
`bots/zus-import.ts` were always plain functions over a `MedplumClient`, so
they are imported here as-is. This service supplies orchestration; the mapping,
the FHIR writes and the source-system handling stay exactly where they were.
