# Inbound webhooks

How an EHR pushes changes into Lyfe, and how to add the next one.

---

## 1. The shape

```
POST https://<worker>/api/webhooks/<provider>/<organizationId>
GET  https://<worker>/api/webhooks/<provider>/<organizationId>?msg=<challenge>
```

One route. `<provider>` selects an adapter from the registry in
`src/webhooks/adapters/index.ts`; `<organizationId>` selects the clinic whose
secret the request is checked against. Neither is a branch in the code — both
are lookups.

A delivery that verifies becomes one or more **intents**, and `dispatch.ts`
turns an intent into the Inngest event that already exists for it. So an inbound
event joins the pipeline the UI already starts:

```
chart.import.requested → zus.import.requested → rag.ingest.requested → summary.generate.requested
```

rather than running beside it. (`lyfe-provider-ui` had a second, parallel path —
webhook → Svix → direct database writes — with its own idempotency and its own
bugs, next to a well-built Inngest processor that only the dead-letter replay
could reach.)

## 2. Per-tenant configuration is data

There is **no new resource type and no new profile**. A clinic's webhook settings
live on the `Basic` resource that already holds its integration credentials, one
per `(Organization, integration)` pair — see
`examples/medplum-provider/bots/shared/credentials.ts`.

| Field              | Bucket               | Meaning                                                                          |
| ------------------ | -------------------- | -------------------------------------------------------------------------------- |
| `webhookSecret`    | secret (AES-256-GCM) | What the provider authenticates with                                             |
| `webhookRequester` | config               | Profile the resulting work runs as, e.g. `Practitioner/abc`                      |
| `webhookEvents`    | config               | Optional comma-separated allow-list. Empty means every event the adapter can map |

These three are merged into **every** integration's field allow-list
(`WEBHOOK_CONFIG_FIELDS` / `WEBHOOK_SECRET_FIELDS`), so a provider added to
`DECLARED_SCHEMAS` is webhook-capable the moment it exists.

`webhookRequester` is a lookup key, not a grant. The receiver re-resolves that
profile's own `ProjectMembership` and refuses the delivery unless it is scoped to
the same organization that owns the record, so naming another clinic's
practitioner buys nothing.

## 3. Adding a provider

1. Write `src/webhooks/adapters/<provider>.ts` implementing `InboundAdapter`:
   `verify`, `deliveryId`, `eventName`, `toIntents`, and `challenge` if the
   provider has an ownership handshake.
2. Add it to the `ADAPTERS` array in `src/webhooks/adapters/index.ts`.
3. Add its credential fields to `DECLARED_SCHEMAS` if it needs any. The webhook
   fields come for free.

That is the whole list. Routing, verification dispatch, tenant resolution,
idempotency, the Inngest events and `server.ts` are untouched. An adapter never
talks to Medplum, never sends an event and never decides which clinic a request
belongs to — it is a pure function of `(headers, body, secret)`, which is what
makes the tenant boundary impossible to reimplement per provider.

## 4. What the status codes mean

Providers read the status code and nothing else.

| Code | Meaning                                                                                | Provider's reaction    |
| ---- | -------------------------------------------------------------------------------------- | ---------------------- |
| 200  | We own this event — including "deliberately ignored" and "we do not recognise this"    | Done                   |
| 400  | Authentic but unusable: no delivery id, no event name, unparseable body                | Retries, then gives up |
| 401  | Not authentic                                                                          | Retries, then gives up |
| 404  | Unknown provider, or a clinic with no such integration                                 | Retries, then gives up |
| 5xx  | Our fault, possibly temporary — a missing secret, a bad requester, Inngest unreachable | Retries                |

The rule underneath: **never answer 200 for an event we did not take
responsibility for.** A 200 destroys the event.

---

## 5. DrChrono: the contract, as verified

Read off the live documentation at
`https://app.drchrono.com/api-docs/#section/Webhooks` on **2026-10-02**.

|                        | What DrChrono does                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `X-drchrono-signature` | **The secret token itself**, sent verbatim. Not an HMAC of anything                                                      |
| `X-drchrono-event`     | The event name, or `PING`                                                                                                |
| `X-drchrono-delivery`  | This delivery's id                                                                                                       |
| Body                   | `{ receiver, object }` — the webhook's own JSON, and the affected object serialised as the REST API would return it      |
| Timestamp              | **There is none.** Not in a header, not in the body                                                                      |
| Verification           | A **GET** to the callback URL with `?msg=<nonce>`, answered `200 {"secret_token": HMAC_SHA256(secret, msg).hexdigest()}` |
| Retries                | 3, at **+1h, +3h and +7h** after the original event, then manual only                                                    |
| Success                | Any 2xx. Everything else, including 302, is a failure                                                                    |

`lyfe-provider-ui` was wired to none of this: it computed
`HMAC-SHA256(secret, rawBody)` and compared it to the signature header, read the
event from `payload.event`, expected `{event, data, timestamp}`, ignored the
delivery id, and applied a 300-second staleness window to a timestamp that is
never sent. Because its signature check could never pass, the only branch that
ever returned 200 was an unsigned "this is probably a verification ping"
fallback — so every real event was answered `{verified: true}` and discarded.

Two consequences for this implementation:

- **No replay window.** There is nothing to compute one from. Replay safety is
  the delivery id, which is real. A staleness check that cannot fire is worse
  than none, because it reads like protection.
- **The signature is a secret comparison, not a digest comparison.** Constant
  time, whole string, and empty never matches.

---

## 6. Registering the webhook in DrChrono

### Before you start

You need three things:

- **The worker's public base URL** — the same host the app uses for bulk
  imports, i.e. the value of `LYFE_IMPORT_WORKER_URL` in the provider app's
  environment. Everything below calls it `<worker>`.
- **The clinic's Organization id** in Medplum — the bare id, not the
  `Organization/` prefix. Everything below calls it `<organizationId>`.
- A **secret token with real entropy**. Generate one:

  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

  Each clinic gets its own. Never reuse one across clinics — per-tenant
  isolation is the whole point of the organization being in the URL.

### Step 1 — save the secret and the requester on the clinic's record

The webhook secret and the requester live on the clinic's existing DrChrono
integration record, alongside its OAuth credentials. Save them through the
`lyfe-integrations` bot — the same path the Integrations page uses — so they are
encrypted under `LYFE_CREDENTIAL_ENCRYPTION_KEY` and land in the right clinic's
compartment:

```jsonc
// Bot: lyfe-integrations, action: saveCredentials
{
  "action": "saveCredentials",
  "integration": "drchrono",
  "secrets": { "webhookSecret": "<the token you generated>" },
  "config": { "webhookRequester": "Practitioner/<id>" },
}
```

`webhookRequester` must be a profile whose `ProjectMembership` carries exactly
one `organization` access parameter, and it must be **this** clinic's. Any
practitioner already using the product qualifies; a dedicated integration
practitioner per clinic is tidier, because every Task a hook produces will be
attributed to it.

Also save `webhookTenantId` — DrChrono's own id for the practice, which it sends
as `practice_group_id` on every delivery:

```jsonc
"config": { "webhookRequester": "Practitioner/<id>", "webhookTenantId": "222" }
```

This is the one check that catches a callback URL **and** secret copied from
another clinic. That mistake produces deliveries which verify perfectly and
import the wrong practice's patients into the wrong chart, and nothing else in
the request disagrees. A delivery whose `practice_group_id` does not match is
refused with a 403 and queues nothing.

It is optional, and leaving it out only means the check does not run — the
signature is still the trust boundary. If you do not know the value, omit it,
let one delivery through, and read it from the worker log: an unconfigured
clinic logs `this delivery came from DrChrono tenant <id>` precisely so nobody
has to guess it.

Optionally restrict which events do work, independently of what DrChrono sends:

```jsonc
"config": { "webhookEvents": "PATIENT_CREATE,PATIENT_MODIFY,APPOINTMENT_CREATE" }
```

Leave it unset to accept everything the adapter maps.

### Step 2 — create the webhook in the DrChrono console

Go to **<https://app.drchrono.com/api-management/>** and find the API
application the clinic connects through (for Lyfe's own practice group that is
**LYFE-AI**). Each application has exactly one **Webhook** section.

Fill it in:

| Field            | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| **Name**         | anything, e.g. `Lyfe inbound`                             |
| **Callback URL** | `https://<worker>/api/webhooks/drchrono/<organizationId>` |
| **Secret Token** | the token from step 1, exactly                            |
| **Active**       | ticked                                                    |

**Events** — choose _Let me select individual events_ and tick the ones Lyfe
acts on. These map to a chart re-import:

```
APPOINTMENT_CREATE          PATIENT_ALLERGY_CREATE      PATIENT_MEDICATION_CREATE
APPOINTMENT_MODIFY          PATIENT_ALLERGY_MODIFY      PATIENT_MEDICATION_MODIFY
APPOINTMENT_DELETE          PATIENT_PROBLEM_CREATE      PATIENT_FLAG_CREATE
PATIENT_CREATE              PATIENT_PROBLEM_MODIFY      PATIENT_FLAG_MODIFY
PATIENT_MODIFY              CLINICAL_NOTE_LOCK          LAB_ORDER_CREATE
VACCINE_ADMINISTERED        CLINICAL_NOTE_UNLOCK        LAB_ORDER_MODIFY
                                                        LAB_ORDER_DELETE
```

_Send me everything_ also works — the billing and practice-task events
(`LINE_ITEM_*`, `CASH_PAYMENT_DELETE`, `TASK_*`) are acknowledged and
deliberately ignored, with the reason in the response. Selecting individual
events just means less traffic.

Click **Save Changes**. The page confirms with _All changes saved_.

### Step 3 — verify the callback URL

Click **Verify webhook**.

DrChrono sends a `GET` to the callback URL with a `?msg=` nonce, and the worker
answers `{"secret_token": "<hmac>"}`. The line next to the button changes to
**This webhook is verified**.

If it does not, check in this order:

1. `curl "https://<worker>/api/webhooks/drchrono/<organizationId>?msg=hello"` —
   you should get a 200 with a `secret_token` field. A 404 means the
   organization has no DrChrono integration record; a 503 means the secret or
   the requester is missing, and the body says which.
2. The callback URL has no trailing slash and the organization id is the bare
   id.
3. The secret in the console matches the one saved in step 1 exactly — no
   leading or trailing whitespace.

**Verification is required again any time the callback URL changes.**

### Step 4 — confirm the first delivery landed

Click **Ping webhook**. Then click **Deliveries** to open the recent delivery
list; the ping should show a 200.

A ping is a real signed `POST` with `X-drchrono-event: PING`. It is verified like
any other delivery and then acknowledged with:

```json
{ "accepted": false, "event": "PING", "intents": [{ "kind": "ignore", "reason": "verification ping" }] }
```

`accepted: false` is correct — there was no work to do.

Now make a real change: edit a patient's details in DrChrono. Within seconds:

- **Deliveries** shows a 200 for `PATIENT_MODIFY`.
- The worker logs the delivery.
- A `drchrono-import` **Task** appears on the Imports page for that clinic, with
  a batch id of `hook-<deliveryId>`.

If a delivery shows a non-2xx, the response body says why in plain words.
DrChrono will retry it at +1h, +3h and +7h, which is enough time to fix a missing
setting — and you can force a retry immediately with **redeliver** next to the
delivery.

### Step 5 — repeat per clinic

Each clinic gets its own callback URL (its own organization id), its own secret,
and its own webhook in whichever API application it connects through.

---

## 7. Known gaps

- **The legacy endpoint is still live.** The LYFE-AI webhook currently points at
  `https://app.lyfeco.ai/api/webhooks/drchrono`, which answers 200 and discards
  everything. Changing the callback URL to the worker requires re-verifying
  (step 3). Nothing is lost by switching, because nothing was ever captured.
- **Only `chart.import` is reachable today.** The intent union also defines
  `zus.import` and `rag.ingest`, and `dispatch.ts` can already send both, but no
  adapter emits them yet. A Zus adapter is the obvious next one.
- **No dead-letter queue.** A delivery that fails after seven hours of DrChrono
  retries is gone, and the only record is DrChrono's own delivery list.
