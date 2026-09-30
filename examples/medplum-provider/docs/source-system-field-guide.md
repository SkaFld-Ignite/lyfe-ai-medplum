# How DrChrono and Zus hold Sania's chart

Field notes taken from the two source systems directly, against the pilot
patient (DrChrono `120118105`, Zus `a9ebcab2-70f5-4ba6-976f-16cda8ac6a13`),
before redesigning the Medplum patient view. The point is not to copy either
UI — it is to know what data actually exists, what each system calls it, and
how the two relate things, so the Medplum chart can be judged against reality
rather than against a guess.

---

## 1. DrChrono

### 1.1 Chart header — always visible, every page

Two rows that never scroll away:

| | |
|---|---|
| Identity | `Sania Aamir` · Female · 39 years old (08/17/1987) · **Chart ID `AASA000002`** |
| Row 2 | Provider · Address · Phone · Email · **Prev Appt** · **Next Appt** · OnPatient status · Date Added |

Worth noting: **Prev Appt / Next Appt live in the header.** The first thing a
clinician sees is when they last saw this person and when they are due back.

### 1.2 The flag chip row — how DrChrono relates context

Directly under the header, a row of coloured chips:

- `Tien Truong PA-C` — care team
- `HMO: OPTUM ONECARE MEDICAL` — **the payer**
- `REFERRAL/PCP: THUY NGUYEN P714-620-7001 F714-620-7091` — referring provider, with phone and fax
- `Adult Immunization Schedule Age: 27-49` — care-gap prompt

These are **patient flags**, free-text banners a practice defines. This is the
single most important structural finding about DrChrono: *the payer, the
referring PCP and the care team are carried as free-text flags, not as
structured fields.* Any mapping that only reads structured tables will miss
what the practice actually looks at.

### 1.3 Chart sidebar — the full organising structure

```
Patient Summary      Demographics         Appointments
Clinical Dashboard   Documents            Eligibility
Tasks (0)            Problem List (11)    Medication List (8)
Send eRx             Allergy List (3)     Drug Interactions (0)
CQMs                 Intake Data          Lab Orders
Immunizations        Patient Cost Estimator
Growth Charts        OnPatient Access     Education Resources
Communication        Family History       Imaging Orders
Implantable Devices  App Directory        Health Gorilla
```

Counts are rendered as badges on the nav item itself, so the sidebar doubles
as a summary: 11 problems, 8 medications, 3 allergies, 0 tasks.

### 1.4 Demographics

Sub-tabs: **Demographics · Insurances · Authorizations · Patient Flags · Payments**

`Patient Profile` sections: Patient Info, Previous Names, Occupations,
Smoking Status, then Contact Info and Previous Addresses.

Patient Info fields: photo, Active badge, Primary Provider, Date of Birth /
Approx. Age, Sex, Preferred Name, Suffix, Title, Ethnicity, Ethnicity
Subcategories, Race, Race Subcategory, Tribal Affiliation, Gender Identity,
Sexual Orientation, Pronouns, Patient SSN, Preferred Language, Marital Status,
Student Status.

Contact Info fields: Cell / Home / Office Phone, Email, Alternate Email, Home
Address, Mail Address, Preferred Contact Method, Email Reminder Language, Time
Zone, Contact Setting, Emergency Contact Name / Phone / Relationship.

### 1.5 Insurance — and why the Medplum chart says "Unknown Payor"

Insurances sub-tabs: **Primary · Secondary · Tertiary · Auto Accident ·
Worker's Comp · Durable Med Eqpt**.

Columns DrChrono uses: Insurance Type, Insurance company, Payer ID, Ins ID #,
Ins Group #, Claim Office #, Plan Name, Insurance Notes, Default?

**For Sania, all of it is empty.** Two rows exist — `Primary Professional` and
`Secondary Professional` — with no company, no payer id, no plan name, and
"Patient has no insurance history". The only payer information in DrChrono is
the free-text flag `HMO: OPTUM ONECARE MEDICAL`.

Three separate problems follow from this, all confirmed against live data:

1. **The `/insurances` endpoint is a payer directory, not patient coverage.**
   It requires a `payer_type`, and the value the importer passes (`emdeon`) is
   a *clearinghouse*. It then returns DrChrono's global payer catalogue and
   **ignores `patient=` entirely** — QualCare Inc., Medicare Plus Blue,
   Guardian Life, HIP New York. No `payer_type` value tried maps to "this
   patient's insurance"; that data is not exposed on this endpoint at all.

2. **One fabricated Coverage exists in Medplum because of it**: payor
   `QualCare Inc.`, identifier `https://drchrono.com/insurances|undefined` —
   the literal string "undefined". That is the first row of the payer
   directory recorded as Sania's insurance. It predates the guard now in
   `importCoverage`, which filters rows lacking a numeric `id`/`patient`.

3. **The 16 real Coverages come from Zus** — Cal Optima Health Plan, Medi Cal,
   OPTUM CARE NETWORK-MEDI-CAL, PROSPECT HEALTH PLAN, MONARCH FAMILY
   HEALTHCARE, CALOPTIMA/OPTUM-MONARCH — sourced via Carequality and
   CommonWell. They display as "Unknown Payor" for a different reason:
   Medplum's `CoverageItem` calls `useResource(coverage.payor[0])` and reads
   `.name` off the **resolved Organization**. Our payors are display-only
   (`{ display: "Cal Optima Health Plan" }`) with no `reference`, so nothing
   resolves and the component falls back to its placeholder. It never looks at
   `display`.

   The fix is the FHIR-correct model rather than a UI patch: create
   `Organization` resources for payers and have `Coverage.payor` reference
   them.

### 1.6 Appointments — where the visit's *name* lives

Two separate tables, **Future Appointments** and **Past Appointments**, with
columns:

`Scheduled Time · Provider · Reason · Notes · Office · Exam Room ·
Appointment Status · Billing Status · # Reminders · Profile · Actions`

**`Reason` is the visit name.** For Sania: "follow up- fatty liver",
"fatty liver", "fatty liver, abnormal LFTs", "post-gen surgeon",
"NOCSC EGD CS", "EGD procedure results, H. Pylori gastritis, diarrhea".
A clinician scanning this list reads the reason, not the date.

Other things this table shows that are easy to miss:

- **Appointment Status and Billing Status are different columns.** A visit can
  be `CANCELLATIONS` clinically and `Cancelled` for billing, and the practice
  defines its own status words (`NOTE COMPLETE`, `CANCELLATIONS`).
- **Profile** is a coloured appointment template — "In Clinic
  Appointments-Joane", "In Clinic Appointments-Tien", "Patient Ready 8" —
  with a colour swatch that the schedule is read by.
- **Exam Room** is tracked per visit (`TIEN-PA`).
- **Notes** are collapsed behind a Show/Hide toggle and carry operational
  history: *"8/19 Called pt to rs 9/14 to 9/15 w Joane due to Tien on..."*,
  *"9/8 Eligibility and approval on file - Corinne"*.

**Against Medplum:** the reason did survive the import —
`Appointment.description` = "follow up- fatty liver" and
`Encounter.reasonCode[0].text` = "fatty liver". But **`Encounter.type` is
null**, and that is what Medplum's visit list titles each row from, so every
visit renders as the literal word "Visit". The information is present and
simply not being shown.

### 1.7 Clinical Dashboard — DrChrono's one-page chart

A single scrolling page, which is the closest thing DrChrono has to the view
we are designing. In order:

1. **Summary Of Care Provided** — `Appointment · Summary of Care · Summary of Care requested and not available · Type`
2. **Ongoing Problems** — `Problem · ICD-10-CM · ICD-9-CM · SNOMED · Diagnosis Date · Status · Notes`
3. **Allergies** — `Allergy · Reaction · RxNorm Code · Snomed Code · Notes`
4. **Active Medications** — `Medication · RxNorm · Strength · SIG · SIG Note · Dispense · Refills · Order Type · Date`
5. **Lab Results** / **Legacy Lab Results**
6. **Active DSI Rule** / **Resolved DSI Rule**
7. **Import Structured Clinical Record** (C-CDA upload)
8. Links: Care Plan · Care Team Members · Functional Status · Mental Status · Create Syndromic HL7 Message for CDC · Import CCR Lab Result

Observations worth carrying into the Medplum design:

- The section is called **"Ongoing Problems"**, not "Conditions", and each
  problem carries **three code systems side by side** — ICD-10-CM, ICD-9-CM
  and SNOMED — with a **Diagnosis Date**. Sania has 11, all Active:
  epigastric abdominal tenderness (R10.816), fatty liver (K76.0), NASH
  (K75.81), GERD without esophagitis (K21.9), abnormal LFTs (R94.5), diarrhea
  (R19.7), and so on. The problem list *is* the clinical story here.
- Medications carry **`Order Type: "Prescribed by other Dr"`** — provenance
  about who prescribed, which matters for a list merged from several sources.
- **DSI = Decision Support Intervention**: the care-gap engine, with the
  developer (CDC) and release date attributed, and a `Dismiss Alert` action.
  The "Adult Immunization Schedule Age: 27-49" chip in the header is this.
- **DrChrono has no lab results at all for Sania** — "No lab result has been
  recorded for this patient". Every lab we hold comes from Zus. This confirms
  the 403/404s the importer logged on the lab endpoints are not a permissions
  problem to chase: there is nothing there.

---

## 2. Zus

Zus is not a second EHR. It is an aggregator, and **its entire interface is
organised around that fact**. Where DrChrono shows one value per field, Zus
shows every value it has seen, who reported it, and when — then marks the one
it considers canonical. That difference is the most useful thing in this
document, because the Medplum chart merges two sources and inherits exactly
the same problem.

### 2.1 Sidebar

```
Overview        GPS Summary   Demographics   Conditions
Medications     Diagnostics   Vitals         Encounters & Notes
Documents       Allergies     Immunizations  Care Team
```

Header: name · DOB (age) · sex · phone · email · **`Last updated 9/27/2026`**
with a sync glyph, and a global **"Search the ZAP"** box.

### 2.2 Demographics — the three-layer model

Three tabs, and the layering is the point:

1. **Contact Information** — the merged view. Every phone, email and address
   the patient has ever had, each row carrying a **SOURCES** column
   (`Carequality, CommonWell`, `1st Party Data`, `Collective-medical`,
   `Surescripts`, `Unknown Organization (Zus Network)`) and a ✓ on the value
   Zus treats as current. Sania has 3 phone variants, **4 email variants**
   (`saina817@`, `AAMIR-74S@`, `SAINA817@`, `sania817@`) and multiple
   addresses.
2. **Sources** — the raw record-linkage ledger: `DATE · SOURCE · PATIENT
   DETAILS · CONTACT INFO`, one row per identity match. This is where you see
   that CommonWell returned "Sania Aamir" at *12122 Peacock Ct, Garden Grove*
   and "SANIA AAMIR" at *1675 W Pampas Ln Apt 16, Anaheim* and *Apt 23*, all
   matched to the same person.
3. **Zus Records** — the 1st-party record the practice itself maintains:
   Profile, Contact Info, Insurance Coverage, Insurance Subscriber.

**Zus's own insurance record is empty**, exactly like DrChrono's. Every payer
we hold came from the networks, not from the practice.

### 2.3 Overview — the one-screen summary worth stealing from

A card grid, with an AI **"Generate Patient Summary"** action ("Generate a
5-minute briefing for this patient", quota `0/10`) across the top.

- **Conditions** — grouped by **body system** (`ENDOCRINE, NUTRITIONAL AND
  METABOLIC`, `GENITOURINARY SYSTEM`, `NERVOUS SYSTEM`), each with
  **`[Last Dx 2026]`**.
- **Medications** — plain list, ✓ on reconciled entries.
- **Select Labs** — not all labs; a curated few, with "Recorded:" dates.
- **ED & IP Visits** — emergency and inpatient encounters **called out as
  their own card**, with facility, exact times and a **document count**
  (`📄 3 documents`). These are the high-signal events and Zus refuses to bury
  them in a flat visit list.
- **Most Recent Vitals** — BP / HR / Temp / RR / SpO2 / Ht / Wt, one column of
  values, one of dates.
- **Records Provided by Zus Health** — enrolment tier (`ZAP Pro - Intelligent
  Refresh`), `Last synced 9/27/26 at 6:03 PM`, a **Request records** action,
  and expandable `EHR Data` / `Pharmacy Data`.

### 2.4 Conditions — and the provenance drawer

List controls: `Range: Current` · `Sort: Last Diagnosed (New To Old)` ·
`Filters (0)`. Columns: `NAME · LATEST DIAGNOSIS · ONSET DATE · TYPE`,
grouped by body system, **`TYPE` = Acute or Chronic**.

Clicking a row opens a right-hand drawer — this is the screen worth copying:

```
CONDITION
Anemia

DETAILS
  Latest Diagnosis       8/25/2025
  Recorder               —
  Provider Organization  —
  Onset Date             11/2/2020
  Type                   Acute
  Status                 Active
  Abatement Date         —
  ICD-10                 D64.9  Anemia, unspecified
  HCC                    —
  Note                   —

HISTORY
  8/25/2025   PHS ORANGE COUNTY SERVICE AREA      📄  ›
  8/25/2025   Garden Grove Hospital - Prime           ›
```

**One clinical fact, many reporters.** Zus collapses the same condition
reported by several organisations into a single row, and the `History` block
names each organisation that reported it with a link through to the source
document. It also tracks **read/unread state per record** ("Unread" toggle),
and carries **HCC** alongside ICD-10 for risk adjustment.

### 2.5 Encounters & Notes — how Zus names a visit

Columns: `DATE · CLASS · LOCATION · PROVIDER · 📄 · DETAILS`

- **`CLASS`** is `Ambulatory` / `Emergency` / `Virtual`.
- **`DETAILS` is the diagnosis list** — *"Fever, unspecified, Acute upper
  respiratory infection, unspecified, Frequency of micturition"*, *"Female
  infertility, unspecified, Chronic salpingitis, Polycystic ovarian
  syndrome"*. **That is how Zus names a visit: by what was found.** The ED
  visit also shows **`Discharge: Home`**.
- `LOCATION` carries a speciality (`Orange Coast Memorial E.D.` /
  `Speciality: Emergency Department`).

Worth noticing, and slightly uncomfortable: **our own DrChrono encounters
appear in this list with no location, no provider and no details** — just a
date, `Ambulatory`, and a ✓ marking them 1st-party. Everything we push to Zus
is thinner than what every other organisation pushes.

### 2.6 Care Team — honest evidence about network data quality

`PROVIDER · ROLE · SPECIALTY · LAST UPDATED`, **31 records**, and a good
share of it is junk: `None Pcp`, `PCP NO DOCTOR`, `G49066`, `I00988`,
`ML4133550` as provider names, and roles spelled both `Primary Care Physician`
and `primary care physician`.

Any UI that renders aggregated network data needs to expect this. Zus's answer
is to show it plainly with a `LAST UPDATED` column and let the reader judge.

---

## 3. What this means for the Medplum chart

Not a design yet — the observations that should drive one, and the defects
this exercise already turned up.

### 3.1 Defects found, with evidence

| What | Evidence | Where the fix belongs |
|---|---|---|
| Every visit is titled "Visit" | `Encounter.reasonCode[0].text` holds "fatty liver", "EGD procedure results, H. Pylori gastritis, diarrhea" — but `Encounter.type` is null, and that is what the list titles rows from | Set `Encounter.type` from the DrChrono reason at import, and have the visit list fall back to `reasonCode` |
| Insurance reads "Unknown Payor · ID: N/A" | 16 Coverages carry real payer names as `payor[0].display` with no `reference`; Medplum's `CoverageItem` calls `useResource(payor)` and reads `.name` off a resolved `Organization`, ignoring `display` | Create `Organization` resources for payers and reference them — the FHIR-correct model, not a UI patch |
| One fabricated Coverage | `payor = "QualCare Inc."`, identifier `https://drchrono.com/insurances\|undefined` — the first row of DrChrono's **global payer directory**, which `/insurances` returns while ignoring `patient=` | Delete it; the guard in `importCoverage` already blocks new ones |
| Whole summary panel said "Forbidden" | `Goal` missing from the clinic AccessPolicy; `CarePlan` and `FamilyMemberHistory` were also written-but-unreadable | Fixed — commit `90cea8283` |

### 3.2 The structural lesson

DrChrono and Zus disagree about what a chart *is*, and the Medplum view has to
be both:

- **DrChrono is a system of record.** One value per field, authored here,
  edited here. Its chart is a set of worklists with counts in the nav.
- **Zus is a system of reference.** Many values per fact, none authored here,
  every one attributed. Its chart is a reconciliation surface.

Our Medplum chart holds both at once — 217 DrChrono resources and 3,819 Zus
resources on the same patient — which makes it the second kind whether we
design for it or not. Concretely, that argues for:

1. **Source attribution on every clinical row**, not just a tag in the data.
   Zus proves this is usable rather than noisy.
2. **A provenance drawer per record**, modelled on Zus's Condition drawer: the
   merged view up top, then a `History` block naming every organisation that
   reported the same fact, with a link to the source document.
3. **Naming records by clinical content** — a visit by its reason/diagnoses, a
   condition by its ICD-10 display — never by its resource type.
4. **Grouping conditions by body system**, with Acute/Chronic and both onset
   and latest-diagnosis dates. A flat 11-row list of ICD codes is the DrChrono
   view; the grouped view is materially easier to read.
5. **Separating ED and inpatient encounters** from routine visits, with their
   document counts, as Zus's Overview does.
6. **Showing the sync state of each integration on the chart** — Zus puts
   "Last synced 9/27/26 at 6:03 PM" and a "Request records" button right on
   the patient. We have this data in the import Tasks already.
7. **Expecting bad aggregated data.** 31 care-team entries with names like
   `ML4133550` are what the networks actually return.

### 3.3 One thing we should fix about what we *send*

Our DrChrono encounters show up inside Zus with no location, no provider and
no details, while every other contributing organisation supplies all three.
Whatever we push to Zus is thinner than what we receive, and that asymmetry is
visible to anyone else querying the network for this patient.
