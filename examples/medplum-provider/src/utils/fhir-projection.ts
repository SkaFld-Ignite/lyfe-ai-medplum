// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Compact projections of FHIR search results, for the Lyfe AI agent loop.
 *
 * ## Why this exists
 *
 * `fhir_request` used to hand the model the bundle exactly as Medplum returned it. One real
 * measurement, the floating panel answering "Show me all my patients for this week":
 *
 * ```
 * bundle entries : 83  (43 Appointment + 40 included Patient)
 * raw JSON       : 169,567 chars  ≈ 42,391 tokens
 * ```
 *
 * Almost none of that is information. `meta`, `text.div`, `extension`, `fullUrl`, and the long
 * tail of FHIR's optional scaffolding are the bulk of the bytes, and the model has to read every
 * one of them before it can say "you have 43 appointments". That is where the two minutes went.
 *
 * So each entry is projected to the fields that actually answer a question about that resource
 * type — for an Appointment: when, who with, where, why; for a Condition: the code and the onset —
 * and everything else is dropped.
 *
 * ## The two rules this module is bound by
 *
 * **1. Citations must survive.** `Sn` is a 1-based index into the `resources` array the UI builds
 * by walking tool results in order (`extractResourceRefs` in `./spaceMessaging.ts`), and the
 * summary bot recomputes the same list from the stored tool messages
 * (`collectCitableSources` in `bots/shared/spaces-ai.ts`). Both read `Bundle.entry[].resource` and
 * take `reference` if present, else `resourceType/id`. So a projection must:
 *
 * - keep the bundle's `entry` array, with the surviving rows in their original order;
 * - keep `resourceType` and `id` on every projected resource;
 * - never introduce a top-level `reference` key on a projected resource, because both readers
 *   prefer it over `resourceType/id` and would then cite the wrong record.
 *
 * {@link projectResource} enforces the last one at runtime rather than by convention.
 *
 * The one thing that *does* change the citation list is {@link projectBundle} dropping `_include`d
 * rows, which is why the UI now numbers citations off the projected bundle rather than the raw
 * one: both sides read the same bytes. See that function for why those rows go.
 *
 * **2. Clinical content is never silently truncated.** Dropping `meta` is safe; dropping a
 * medication's dose is a wrong answer that looks like a fact. Hence `dosageInstruction` is
 * forwarded whole when it has no `text` to stand in for it, `Observation.component` is kept (it is
 * where a blood pressure's systolic and diastolic live), and a resource type with no projection
 * defined here is forwarded **as-is**. An unknown type passed through whole is slow; a mangled one
 * is wrong.
 */
import type { Bundle, BundleEntry, Resource } from '@medplum/fhirtypes';

/** A projected resource. Open-ended: each type contributes its own fields. */
export type ProjectedResource = Record<string, unknown> & { resourceType: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds an object from entries, dropping anything with no content.
 *
 * "No content" is `undefined`, `null`, `''`, and an empty array — the four shapes FHIR uses for
 * "not stated". An empty array costs two characters and says nothing, and there are a lot of them.
 * @param entries - Candidate key/value pairs.
 * @returns The object with only the meaningful pairs.
 */
function compact(entries: [string, unknown][]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * The human-readable text of a `CodeableConcept`.
 *
 * `text` first, then the first coding's `display`, then its bare `code`. The code is a worse
 * answer than a display string but a much better one than nothing: `73211009` at least lets the
 * model say which code it saw.
 * @param value - A `CodeableConcept`, or anything else.
 * @returns The text, or undefined when there is none.
 */
export function codeableText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.text === 'string' && value.text !== '') {
    return value.text;
  }
  const coding = Array.isArray(value.coding) ? value.coding : [];
  for (const entry of coding) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.display === 'string' && entry.display !== '') {
      return entry.display;
    }
    if (typeof entry.code === 'string' && entry.code !== '') {
      return entry.code;
    }
  }
  return undefined;
}

/**
 * The texts of a list of `CodeableConcept`s.
 * @param value - An array of `CodeableConcept`s, or anything else.
 * @returns One string per concept that had any text, or undefined when none did.
 */
function codeableTexts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const texts = value.map(codeableText).filter((text): text is string => !!text);
  return texts.length > 0 ? texts : undefined;
}

/**
 * A reference, as one string the model can both read and resolve.
 *
 * `Jane Doe (Patient/abc)` rather than `{reference, display}`: the display name is what the answer
 * needs and the reference is what a follow-up request needs, and one string costs less than the
 * object. The reference is kept even when there is no display, because without it the model cannot
 * ask a second question about the same record.
 * @param value - A `Reference`, or anything else.
 * @returns The one-line form, or undefined when there is nothing to show.
 */
export function referenceText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const reference = typeof value.reference === 'string' ? value.reference : undefined;
  const display = typeof value.display === 'string' && value.display !== '' ? value.display : undefined;
  if (display && reference) {
    return `${display} (${reference})`;
  }
  return display ?? reference;
}

/**
 * A `HumanName` as one line.
 * @param value - A `HumanName`, or anything else.
 * @returns The name, or undefined when there is nothing to show.
 */
function humanName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.text === 'string' && value.text !== '') {
    return value.text;
  }
  const given = Array.isArray(value.given) ? value.given.filter((g): g is string => typeof g === 'string') : [];
  const family = typeof value.family === 'string' ? value.family : '';
  const joined = [...given, family].filter(Boolean).join(' ').trim();
  return joined || undefined;
}

/**
 * The first `HumanName` in a `name` array, as one line.
 * @param value - A `name` array, or a single `HumanName`.
 * @returns The first usable name, or undefined.
 */
function firstName(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return humanName(value);
  }
  for (const entry of value) {
    const name = humanName(entry);
    if (name) {
      return name;
    }
  }
  return undefined;
}

/**
 * A `Quantity` as `"<value> <unit>"`.
 * @param value - A `Quantity`, or anything else.
 * @returns The quantity as one string, or undefined.
 */
function quantityText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const amount = value.value;
  const unit = (typeof value.unit === 'string' && value.unit) || (typeof value.code === 'string' && value.code) || '';
  if (amount === undefined || amount === null) {
    return unit || undefined;
  }
  if (typeof amount !== 'string' && typeof amount !== 'number') {
    return unit || undefined;
  }
  return unit ? `${amount} ${unit}` : String(amount);
}

/**
 * A `Period` as `"<start> → <end>"`, or whichever end is present.
 * @param value - A `Period`, or anything else.
 * @returns The period as one string, or undefined.
 */
function periodText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = typeof value.start === 'string' ? value.start : undefined;
  const end = typeof value.end === 'string' ? value.end : undefined;
  if (start && end) {
    return `${start} → ${end}`;
  }
  return start ?? end;
}

/**
 * An `Address` as one line.
 * @param value - An `address` array, or a single `Address`.
 * @returns The address as one string, or undefined.
 */
function addressText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value.find(isRecord) : value;
  if (!isRecord(first)) {
    return undefined;
  }
  if (typeof first.text === 'string' && first.text !== '') {
    return first.text;
  }
  const line = Array.isArray(first.line) ? first.line.filter((l): l is string => typeof l === 'string') : [];
  const parts = [...line, first.city, first.state, first.postalCode].filter(
    (part): part is string => typeof part === 'string' && part !== ''
  );
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * The first `ContactPoint` of a given system, as its bare value.
 * @param value - A `telecom` array.
 * @param system - The `ContactPoint.system` to look for, e.g. `phone`.
 * @returns The contact value, or undefined.
 */
function contactValue(value: unknown, system: string): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const entry of value) {
    if (isRecord(entry) && entry.system === system && typeof entry.value === 'string' && entry.value !== '') {
      return entry.value;
    }
  }
  return undefined;
}

/**
 * The one `x`-typed value a `[x]` choice element carries.
 *
 * FHIR spells a polymorphic element as `onsetDateTime` / `onsetAge` / `onsetString` / …, so the
 * only way to read "the onset, whatever form it took" is to look for the prefix. Returning it as a
 * flat string collapses eight possible spellings into one field the model can rely on.
 * @param resource - The resource.
 * @param prefix - The element name without its type suffix, e.g. `onset`.
 * @returns A readable form of whichever variant is present.
 */
export function choiceText(resource: Record<string, unknown>, prefix: string): string | undefined {
  for (const [key, value] of Object.entries(resource)) {
    if (!key.startsWith(prefix) || key === prefix || value === undefined || value === null) {
      continue;
    }
    const suffix = key.slice(prefix.length);
    if (suffix !== suffix[0].toUpperCase() + suffix.slice(1)) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (isRecord(value)) {
      return (
        periodText(value) ??
        codeableText(value) ??
        quantityText(value) ??
        referenceText(value) ??
        (typeof value.value === 'string' ? value.value : undefined)
      );
    }
  }
  return undefined;
}

/**
 * The participants of an Appointment or Encounter, grouped by what they are.
 *
 * Grouped rather than listed, because "who is the patient" and "who is the clinician" are
 * different questions and a flat `participant` array makes the model work out which is which from
 * the reference prefix on every row.
 * @param value - The `participant` array.
 * @returns `patient`, `practitioners` and `location` strings, any of which may be absent.
 */
function participants(value: unknown): {
  patient?: string;
  practitioners?: string[];
  location?: string;
} {
  if (!Array.isArray(value)) {
    return {};
  }
  let patient: string | undefined;
  let location: string | undefined;
  const practitioners: string[] = [];
  for (const entry of value) {
    const actor = isRecord(entry) ? (entry.actor ?? entry.individual) : undefined;
    const text = referenceText(actor);
    const reference = isRecord(actor) && typeof actor.reference === 'string' ? actor.reference : '';
    if (!text) {
      continue;
    }
    if (reference.startsWith('Patient/') || reference.startsWith('RelatedPerson/')) {
      patient ??= text;
    } else if (reference.startsWith('Location/')) {
      location ??= text;
    } else {
      practitioners.push(text);
    }
  }
  return { patient, practitioners: practitioners.length > 0 ? practitioners : undefined, location };
}

/**
 * The medication a request or statement is for.
 *
 * Checks `contained` as a last resort: a `medicationReference` of `#med-1` is useless on its own,
 * and the contained `Medication` holding the actual drug name would otherwise be dropped by the
 * allowlist along with everything else not named in the projection.
 * @param resource - The `MedicationRequest` or `MedicationStatement`.
 * @returns The medication's name, or undefined.
 */
function medicationText(resource: Record<string, unknown>): string | undefined {
  const fromConcept = codeableText(resource.medicationCodeableConcept);
  if (fromConcept) {
    return fromConcept;
  }
  const reference = resource.medicationReference;
  const direct = referenceText(reference);
  const id = isRecord(reference) && typeof reference.reference === 'string' ? reference.reference : '';
  if (id.startsWith('#') && Array.isArray(resource.contained)) {
    const contained = resource.contained.find((c) => isRecord(c) && c.id === id.slice(1));
    const name = isRecord(contained) ? codeableText(contained.code) : undefined;
    if (name) {
      return name;
    }
  }
  return direct;
}

/**
 * The dosage, never lossily.
 *
 * `text` is the human sig and is what a clinician reads, so it is preferred. When it is absent the
 * whole `dosageInstruction` element is forwarded untouched, because the dose lives in
 * `doseAndRate[].doseQuantity` and a projection that guessed at it and got it wrong would be a
 * dosing error dressed up as an answer.
 * @param value - The `dosageInstruction` array (or `MedicationStatement.dosage`).
 * @returns The sig strings, or the untouched elements.
 */
function dosage(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  return value.map((entry) => {
    if (isRecord(entry) && typeof entry.text === 'string' && entry.text !== '') {
      return entry.text;
    }
    return entry;
  });
}

/**
 * An Observation's value, whichever `value[x]` it used.
 * @param resource - The `Observation`.
 * @returns The value as one string, or undefined.
 */
function observationValue(resource: Record<string, unknown>): string | undefined {
  return choiceText(resource, 'value');
}

/**
 * One projection per resource type.
 *
 * A type absent from this table is forwarded whole — see the module comment. Adding a type here is
 * a promise that nothing a clinician would ask about it is left out.
 */
const PROJECTIONS: Record<string, (r: Record<string, unknown>) => Record<string, unknown>> = {
  // When, with whom, where, and why. `description` and `comment` are free text a scheduler typed,
  // which is often the only place the real reason for the visit is written down.
  Appointment: (r) => {
    const { patient, practitioners, location } = participants(r.participant);
    return compact([
      ['status', r.status],
      ['start', r.start],
      ['end', r.end],
      ['type', codeableText(r.appointmentType) ?? codeableTexts(r.serviceType)?.[0]],
      // One "why", taken from the first place a clinic actually wrote one. `minutesDuration` is
      // dropped because `start` and `end` already say it.
      ['reason', codeableTexts(r.reasonCode)?.join('; ') ?? r.description ?? r.comment],
      ['patient', patient],
      ['practitioners', practitioners],
      ['location', location],
    ]);
  },

  // Demographics, plus the two contact fields a scheduling question turns into ("can you call
  // them?"). Not clinical, but cheap, and omitting them would make a reachable answer unreachable.
  // The postal address is not here: it is the single longest field on the resource and no question
  // this chat answers has ever needed it. `GET Patient/<id>` still returns it in full.
  Patient: (r) =>
    compact([
      ['name', firstName(r.name)],
      ['birthDate', r.birthDate],
      ['gender', r.gender],
      ['deceased', choiceText(r, 'deceased')],
      ['phone', contactValue(r.telecom, 'phone')],
      ['email', contactValue(r.telecom, 'email')],
    ]),

  Practitioner: (r) =>
    compact([
      ['name', firstName(r.name)],
      ['gender', r.gender],
      ['phone', contactValue(r.telecom, 'phone')],
      ['email', contactValue(r.telecom, 'email')],
    ]),

  PractitionerRole: (r) =>
    compact([
      ['practitioner', referenceText(r.practitioner)],
      ['organization', referenceText(r.organization)],
      ['specialty', codeableTexts(r.specialty)],
      ['period', periodText(r.period)],
    ]),

  Organization: (r) => compact([['name', r.name]]),

  Location: (r) =>
    compact([
      ['name', r.name],
      ['status', r.status],
      ['address', addressText(r.address)],
    ]),

  Encounter: (r) => {
    const { patient, practitioners, location } = participants(r.participant);
    const encounterLocation = Array.isArray(r.location) ? r.location.find(isRecord) : undefined;
    return compact([
      ['status', r.status],
      ['class', isRecord(r.class) ? (r.class.display ?? r.class.code) : undefined],
      ['type', codeableTexts(r.type)],
      ['period', periodText(r.period)],
      ['reason', codeableTexts(r.reasonCode)],
      ['patient', patient ?? referenceText(r.subject)],
      ['practitioners', practitioners],
      ['location', location ?? referenceText(encounterLocation?.location)],
      ['serviceProvider', referenceText(r.serviceProvider)],
    ]);
  },

  // The code and the onset, as asked for, plus the two statuses that decide whether the problem is
  // still a problem — an active/resolved mix-up is the error this resource type actually produces.
  Condition: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['category', codeableTexts(r.category)],
      ['clinicalStatus', codeableText(r.clinicalStatus)],
      ['verificationStatus', codeableText(r.verificationStatus)],
      ['severity', codeableText(r.severity)],
      ['onset', choiceText(r, 'onset')],
      ['abatement', choiceText(r, 'abatement')],
      ['recordedDate', r.recordedDate],
      ['patient', referenceText(r.subject)],
    ]),

  MedicationRequest: (r) =>
    compact([
      ['medication', medicationText(r)],
      ['status', r.status],
      ['intent', r.intent],
      ['authoredOn', r.authoredOn],
      ['dosage', dosage(r.dosageInstruction)],
      [
        'dispense',
        isRecord(r.dispenseRequest)
          ? compact([
              ['quantity', quantityText(r.dispenseRequest.quantity)],
              ['refills', r.dispenseRequest.numberOfRepeatsAllowed],
              ['validityPeriod', periodText(r.dispenseRequest.validityPeriod)],
            ])
          : undefined,
      ],
      ['reason', codeableTexts(r.reasonCode)],
      ['requester', referenceText(r.requester)],
      ['patient', referenceText(r.subject)],
    ]),

  MedicationStatement: (r) =>
    compact([
      ['medication', medicationText(r)],
      ['status', r.status],
      ['effective', choiceText(r, 'effective')],
      ['dosage', dosage(r.dosage)],
      ['reason', codeableTexts(r.reasonCode)],
      ['patient', referenceText(r.subject)],
    ]),

  // `component` is kept whole-ish rather than summarised away: a blood pressure carries no value of
  // its own, only a systolic and a diastolic component, and a projection that dropped them would
  // report a vital sign as blank.
  Observation: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['status', r.status],
      ['value', observationValue(r)],
      ['effective', choiceText(r, 'effective')],
      ['interpretation', codeableTexts(r.interpretation)],
      [
        'referenceRange',
        Array.isArray(r.referenceRange)
          ? r.referenceRange
              .map((range) => {
                if (!isRecord(range)) {
                  return undefined;
                }
                return (
                  range.text ?? [quantityText(range.low), quantityText(range.high)].filter(Boolean).join(' – ') ?? ''
                );
              })
              .filter(Boolean)
          : undefined,
      ],
      [
        'component',
        Array.isArray(r.component)
          ? r.component
              .filter(isRecord)
              .map((component) =>
                compact([
                  ['code', codeableText(component.code)],
                  ['value', choiceText(component, 'value')],
                ])
              )
              .filter((component) => Object.keys(component).length > 0)
          : undefined,
      ],
      [
        'note',
        Array.isArray(r.note) ? r.note.map((n) => (isRecord(n) ? n.text : undefined)).filter(Boolean) : undefined,
      ],
      ['patient', referenceText(r.subject)],
    ]),

  AllergyIntolerance: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['clinicalStatus', codeableText(r.clinicalStatus)],
      ['verificationStatus', codeableText(r.verificationStatus)],
      ['type', r.type],
      ['category', r.category],
      ['criticality', r.criticality],
      ['onset', choiceText(r, 'onset')],
      ['recordedDate', r.recordedDate],
      [
        'reactions',
        Array.isArray(r.reaction)
          ? r.reaction
              .filter(isRecord)
              .map((reaction) =>
                compact([
                  ['manifestation', codeableTexts(reaction.manifestation)],
                  ['severity', reaction.severity],
                  ['onset', reaction.onset],
                ])
              )
              .filter((reaction) => Object.keys(reaction).length > 0)
          : undefined,
      ],
      ['patient', referenceText(r.patient)],
    ]),

  Immunization: (r) =>
    compact([
      ['vaccine', codeableText(r.vaccineCode)],
      ['status', r.status],
      ['occurrence', choiceText(r, 'occurrence')],
      ['doseQuantity', quantityText(r.doseQuantity)],
      ['lotNumber', r.lotNumber],
      ['site', codeableText(r.site)],
      ['route', codeableText(r.route)],
      ['patient', referenceText(r.patient)],
    ]),

  Procedure: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['status', r.status],
      ['category', codeableText(r.category)],
      ['performed', choiceText(r, 'performed')],
      ['reason', codeableTexts(r.reasonCode)],
      ['outcome', codeableText(r.outcome)],
      ['bodySite', codeableTexts(r.bodySite)],
      ['patient', referenceText(r.subject)],
    ]),

  // `conclusion` is the report. `result` is kept as bare references so the model can fetch the
  // individual Observations if the conclusion is not enough, without them being inlined here.
  DiagnosticReport: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['status', r.status],
      ['category', codeableTexts(r.category)],
      ['effective', choiceText(r, 'effective')],
      ['issued', r.issued],
      ['conclusion', r.conclusion],
      ['conclusionCode', codeableTexts(r.conclusionCode)],
      [
        'result',
        Array.isArray(r.result) ? r.result.map(referenceText).filter((entry): entry is string => !!entry) : undefined,
      ],
      ['patient', referenceText(r.subject)],
    ]),

  // Metadata only. The document's *content* reaches the model through `search_documents`, which is
  // the RAG path; a DocumentReference search is how it learns a document exists.
  DocumentReference: (r) =>
    compact([
      ['type', codeableText(r.type)],
      ['category', codeableTexts(r.category)],
      ['status', r.status],
      ['docStatus', r.docStatus],
      ['date', r.date],
      ['description', r.description],
      [
        'author',
        Array.isArray(r.author) ? r.author.map(referenceText).filter((entry): entry is string => !!entry) : undefined,
      ],
      [
        'content',
        Array.isArray(r.content)
          ? r.content
              .filter(isRecord)
              .map((content) =>
                isRecord(content.attachment)
                  ? compact([
                      ['contentType', content.attachment.contentType],
                      ['title', content.attachment.title],
                    ])
                  : {}
              )
              .filter((content) => Object.keys(content).length > 0)
          : undefined,
      ],
      ['patient', referenceText(r.subject)],
    ]),

  ServiceRequest: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['status', r.status],
      ['intent', r.intent],
      ['priority', r.priority],
      ['authoredOn', r.authoredOn],
      ['occurrence', choiceText(r, 'occurrence')],
      ['reason', codeableTexts(r.reasonCode)],
      ['requester', referenceText(r.requester)],
      ['patient', referenceText(r.subject)],
    ]),

  CarePlan: (r) =>
    compact([
      ['title', r.title],
      ['status', r.status],
      ['intent', r.intent],
      ['category', codeableTexts(r.category)],
      ['description', r.description],
      ['period', periodText(r.period)],
      ['patient', referenceText(r.subject)],
    ]),

  Goal: (r) =>
    compact([
      ['description', codeableText(r.description)],
      ['lifecycleStatus', r.lifecycleStatus],
      ['achievementStatus', codeableText(r.achievementStatus)],
      ['start', choiceText(r, 'start')],
      ['patient', referenceText(r.subject)],
    ]),

  Task: (r) =>
    compact([
      ['code', codeableText(r.code)],
      ['status', r.status],
      ['businessStatus', codeableText(r.businessStatus)],
      ['intent', r.intent],
      ['priority', r.priority],
      ['description', r.description],
      ['authoredOn', r.authoredOn],
      ['owner', referenceText(r.owner)],
      ['patient', referenceText(r.for)],
    ]),

  Coverage: (r) =>
    compact([
      ['status', r.status],
      ['type', codeableText(r.type)],
      ['subscriberId', r.subscriberId],
      [
        'payor',
        Array.isArray(r.payor) ? r.payor.map(referenceText).filter((entry): entry is string => !!entry) : undefined,
      ],
      ['period', periodText(r.period)],
      ['patient', referenceText(r.beneficiary)],
    ]),

  Slot: (r) =>
    compact([
      ['status', r.status],
      ['start', r.start],
      ['end', r.end],
      ['schedule', referenceText(r.schedule)],
      ['serviceType', codeableTexts(r.serviceType)],
    ]),

  Schedule: (r) =>
    compact([
      ['active', r.active],
      ['comment', r.comment],
      ['planningHorizon', periodText(r.planningHorizon)],
      [
        'actor',
        Array.isArray(r.actor) ? r.actor.map(referenceText).filter((entry): entry is string => !!entry) : undefined,
      ],
    ]),
};

/**
 * Whether a projection is defined for a resource type.
 * @param resourceType - A FHIR resource type name.
 * @returns True when this module projects that type, false when it forwards it whole.
 */
export function hasProjection(resourceType: string): boolean {
  return Object.hasOwn(PROJECTIONS, resourceType);
}

/**
 * Projects one resource, or returns it untouched when its type has no projection.
 *
 * `OperationOutcome` is deliberately absent from the table: an error payload is small and is the
 * one thing the model must read in full.
 * @param resource - A resource out of a bundle entry.
 * @returns The projected resource, carrying `resourceType` and `id` so it stays citable.
 */
export function projectResource(resource: unknown): unknown {
  if (!isRecord(resource) || typeof resource.resourceType !== 'string') {
    return resource;
  }
  const project = PROJECTIONS[resource.resourceType];
  if (!project) {
    return resource;
  }
  const projected: ProjectedResource = {
    resourceType: resource.resourceType,
    ...(typeof resource.id === 'string' && { id: resource.id }),
    ...project(resource),
  };
  // Both citation readers prefer a `reference` property over `resourceType/id`. No projection
  // above produces one, and this makes that a checked fact rather than a reviewer's job.
  delete projected.reference;
  return projected;
}

/**
 * Projects a search bundle.
 *
 * ## `_include`d entries are dropped
 *
 * FHIR marks each row `search.mode = 'match'` or `'include'`. An `'include'` row is a companion
 * the server volunteered, not a row that answered the question, and it is where most of the
 * duplication lives: `Appointment?_include=Appointment:patient` for one clinic week returned 43
 * matches and 40 whole `Patient` resources, and because the UI cites every bundle entry, those 40
 * became 40 source cards under an answer about a schedule.
 *
 * Nothing is lost by dropping them. A reference is projected as `Display (Type/id)`, so the
 * included Patient's name is already on every Appointment row that pointed at it, and the model
 * can read the whole record with a follow-up `GET Type/id`.
 *
 * This is the one place a projection changes the citation list, so it has to change it on *both*
 * sides: `executeToolCalls` numbers citations off this projected bundle, not off the raw one, and
 * the summary bot recomputes the same list from the stored tool message. The two stay in step
 * because they read the same bytes. Order among the surviving rows is untouched.
 *
 * A bundle with no `'match'` row at all is left whole — a server that does not set `search.mode`
 * must not have its entire result set deleted.
 *
 * An entry with no `resource` (a transaction response, an `OperationOutcome` row) is forwarded
 * untouched.
 *
 * `id` and an `entry` that is present but empty are both preserved, because both citation readers
 * branch on `resourceType === 'Bundle' && entry` and fall through to citing the bundle *itself*
 * when `entry` is missing. Dropping an empty array here would turn a zero-result search into a
 * cited `Bundle/<id>` source card that was never there before.
 * @param bundle - The bundle Medplum returned.
 * @returns The compacted bundle.
 */
export function projectBundle(bundle: Bundle): Record<string, unknown> {
  // Only `next`. `self`/`first` repeat the request the model just made; `next` is the one link that
  // tells it there are more rows than it is looking at.
  const next = Array.isArray(bundle.link)
    ? bundle.link.find((link) => isRecord(link) && link.relation === 'next')
    : undefined;

  const projected = compact([
    ['resourceType', 'Bundle'],
    ['id', bundle.id],
    ['type', bundle.type],
    ['total', bundle.total],
    ['next', isRecord(next) ? next.url : undefined],
  ]);

  if (bundle.entry !== undefined) {
    const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
    const hasMatch = entries.some(
      (entry) => isRecord(entry) && isRecord(entry.search) && entry.search.mode === 'match'
    );
    projected.entry = entries
      .filter((entry) => !(hasMatch && isRecord(entry) && isRecord(entry.search) && entry.search.mode === 'include'))
      .map((entry: BundleEntry) => {
        if (!isRecord(entry) || !entry.resource) {
          return entry;
        }
        return { resource: projectResource(entry.resource) };
      });
  }

  return projected;
}

/**
 * Projects a `fhir_request` result for the model.
 *
 * Bundles only. A single-resource read is one resource, not a page of them — it is neither a
 * latency problem nor a citation problem, and leaving it at full fidelity keeps `GET Patient/123`
 * as the escape hatch for anything a projection above does not carry.
 * @param result - Whatever `fhir_request` returned.
 * @returns The value to serialise into the tool message.
 */
export function projectToolResult(result: Resource): unknown {
  if (result.resourceType === 'Bundle') {
    return projectBundle(result);
  }
  return result;
}
