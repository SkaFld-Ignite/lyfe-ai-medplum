# lyfe-worker

Runs Lyfe's DrChrono and Zus imports, the document RAG index, and the AI
patient summary as Inngest functions — chained, so importing a patient indexes
their documents and writes their summary without anyone asking for either.

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

## The chain runs itself

Importing a patient is one action, not four. Nobody clicks "index documents"
and nobody clicks "generate summary":

```
POST /api/imports/bulk
        │
        ▼
lyfe/chart.import.requested ──▶ drchrono-chart-import
                                   ├──▶ lyfe/zus.import.requested ──▶ zus-record-import
                                   │                                     │ (wrote something)
                                   │                                     ▼
                                   └──▶ lyfe/rag.ingest.requested ◀──────┘
                                                 │
                                                 ▼
                                        rag-document-index
                                                 │
                                                 ▼
                                   lyfe/summary.generate.requested
                                                 │
                                                 ▼
                                        patient-ai-summary  (debounced 10m per patient)
```

Three properties hold this together, and each is there because its absence was
a real failure somewhere:

- **Every link is an event, never an inline call.** A stage hands off with
  `step.sendEvent` and returns, so a failure downstream can never reach back
  and mark the stage before it as failed. A chart that imported perfectly is
  reported as imported, whatever the indexer or the model does afterwards.
- **Indexing happens twice per patient, on purpose.** Once when the chart
  lands, once when the network record does — and most documents come from the
  network, which for a fresh enrolment arrives on the 30m/2h/6h ladder, hours
  later. Re-ingest _replaces_ a document's chunks rather than appending them,
  so the second run converges on the same index plus whatever arrived.
- **The summary is debounced on the patient**, 10 minutes with a 30-minute
  ceiling, so the two index completions of one import cost one model call
  rather than two. Inngest's own `debounce`, not a lock of ours — see
  `src/functions/patient-summary.ts` for why that number, and
  `SUMMARY_DEBOUNCE_PERIOD=off` in `.env.example` for the escape hatch if this
  Inngest plan refuses the registration.

### The summary reads the documents, and the worker is what feeds it

This is the reason the chain is ordered index-then-summarise rather than the
other way round, and it is worth being precise about because the two halves
live in different places.

`bots/patient-ai-summary.ts` builds a prompt with a RECENT DOCUMENTS block —
`[D1]`…`[D10]`, each a short excerpt, each citable. It does **not** read those
excerpts. It cannot: they come from `lyfe_rag`, and the same file is also
deployed into the Medplum server's `vmcontext` runtime, which has no database
access and should not acquire any for a schema Medplum does not own.

So `patient-summary.ts` reads them and passes them in as `BotEvent` input:

|                                 | documents                       | RECENT DOCUMENTS block      |
| ------------------------------- | ------------------------------- | --------------------------- |
| in the worker (the chain)       | ten most recent, 600 chars each | rendered, citable as `[Dn]` |
| deployed bot, Subscription path | none passed                     | "None extracted yet"        |
| app refresh / explicit call     | none passed                     | "None extracted yet"        |

Selected by **recency, not similarity** — chunk 0 of each document, ordered by
document date. A summary asks no question, so there is nothing for a
nearest-neighbour search to be near, and recency makes the summary reproducible:
the same chart yields the same ten excerpts. It also costs one indexed query
instead of an embedding round trip.

Two bounds matter. Ten documents at 600 characters are
`CITATION_LIMITS.documents` and `DOCUMENT_EXCERPT_CHARS` from the prompt module
itself, passed into the query rather than restated, because asking for more than
the prompt will render buys a longer prompt and nothing else — and this block
shares a context window with the whole structured chart. And the excerpts are
read **inside** the model step, never as a step of their own: Inngest persists
step output to memoise it, so a `step.run` returning excerpts would write the
text of clinical documents into the event store, which is exactly what
`src/events.ts` says this worker never does.

An index that is unconfigured, unreachable or empty yields no excerpts and the
summary is written from structured FHIR alone — a thinner summary, not a missing
one. The run reports the document count so a thin summary is still a visible
one.

Nothing in the chain treats "empty" as "failed". A patient with no documents
closes its index Task as complete and still gets a summary, because the summary
is written from structured FHIR and documents are additional context. A summary
that cannot be produced leaves the chart with no summary yet; it never leaves an
import marked failed.

A **backfill** is still an operator's decision, and still `POST /api/rag/ingest`
below. What is automatic is the patient who just imported.

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

Neither is the index, and neither is the summary. That one event is the whole
import: expect four runs per patient in the dev server — the chart, the Zus
pull, the index, and the summary ten minutes behind it.

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

## Document RAG

`rag-document-index` indexes a patient's `DocumentReference`s so the AI can
answer from the documents, not just the structured chart. It runs on its own
whenever a patient is imported — see "The chain runs itself" — and the endpoints
below are for backfills and for re-indexing on demand.

### It lives here because Medplum cannot host it

Medplum's `$ai` operation has no embeddings endpoint — it proxies chat
completions — and it is gated behind a project feature plus an API key that has
not been issued. The worker has neither constraint: it already runs on Railway
with AWS credentials and an admin Medplum client. So everything is **Bedrock
only**: `amazon.titan-embed-text-v2:0` for embeddings at 1024 dimensions, and
Textract for OCR. No OpenAI, no new credentials.

### `lyfe_rag` is an index, not a data model change

This is the condition the whole thing rests on, and it is enforced by what the
schema is allowed to contain rather than by convention:

> **Nothing in `lyfe_rag` is a source of truth.** Every row is rebuildable from
> a `DocumentReference` and its `Binary`. It is the same category as a search
> index.

Which means `DROP SCHEMA lyfe_rag CASCADE` followed by a re-ingest loses
exactly nothing, and that is the supported way to change the chunk size or the
embedding dimension — not an in-place migration of data that was never
authoritative.

The test to apply to any column added here: _can it be recomputed by re-reading
FHIR?_ Chunk text, embeddings, titles, dates and page counts all can. Anything
that cannot has turned the index into a record, and the rule has been broken.

It is its own schema, not `public`, because Medplum owns `public` and migrates
it on every upgrade. A table called `document_chunks` in `public` is a name
collision waiting for a release.

### Running it

```bash
# Index one patient's documents
curl -X POST http://localhost:3020/api/rag/ingest \
  -H "Authorization: Bearer $MEDPLUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"patientIds":["<patient-id>"]}'

# Search them
curl -X POST http://localhost:3020/api/rag/search \
  -H "Authorization: Bearer $MEDPLUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"patientId":"<patient-id>","query":"most recent ejection fraction"}'

# How much of a patient is indexed
curl -X POST http://localhost:3020/api/rag/status \
  -H "Authorization: Bearer $MEDPLUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"patientId":"<patient-id>"}'
```

The migration needs no separate step: `ensureRagSchema()` is idempotent,
memoised per process, and runs as the first step of every ingest. It has to work
this way — `RAG_DATABASE_URL` is a Railway internal host that does not resolve
from a laptop, so the only process that can reach the database is the one that
uses it.

### Multi-tenant isolation is not optional

`/api/rag/search` returns the text of clinical documents, which makes it the
most sensitive endpoint in this service. Two rules, both enforced in code and
pinned by tests:

- the caller's **own Medplum token** is verified by asking Medplum who it
  belongs to — the same `identify` the bulk-import endpoint uses, not a copy
- the **organization comes from that identity**, resolved from the caller's
  `ProjectMembership` by the worker's admin client, and goes straight into the
  SQL `WHERE` clause as a bind parameter

The body is trusted for `patientId` and `query` and nothing else. That is safe
for exactly one reason: the retrieval query filters on organization **and**
patient, so a patient id belonging to another clinic matches zero rows. A
retrieval that can return another organization's chunks is a PHI breach, and the
failure would be invisible in a single-tenant dev environment — which is why
`src/rag/retrieve.test.ts` asserts the predicate rather than leaving it to
review.

### Degradation when Textract is not granted

The AWS credentials on this service were provisioned for Bedrock. That Bedrock
works says nothing about whether the same IAM identity holds
`textract:AnalyzeDocument`, and the first anyone would know is at runtime.

So the first permission failure latches, and every later OCR call refuses
immediately rather than rediscovering it 734 times. Scanned PDFs and images are
recorded as `skipped` with the reason; C-CDA XML, plain text and PDFs with a
real text layer — most of the corpus — keep indexing. `/health` and the ingest's
Task output both report it, so the gap is a number rather than a mystery.

## What is still Medplum's

The import logic itself did not move. `bots/drchrono-import.ts` and
`bots/zus-import.ts` were always plain functions over a `MedplumClient`, so
they are imported here as-is. This service supplies orchestration; the mapping,
the FHIR writes and the source-system handling stay exactly where they were.
