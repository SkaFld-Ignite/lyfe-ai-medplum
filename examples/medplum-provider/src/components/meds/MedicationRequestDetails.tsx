// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Group, Paper, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import type { MedicationOrderExtensions } from '@medplum/core';
import {
  formatCodeableConcept,
  formatHumanName,
  getMedicationOrderIframeUrl,
  getPendingMedicationOrderId,
  getPendingMedicationOrderStatus,
} from '@medplum/core';
import type { Dosage, MedicationRequest, Patient, Practitioner, Quantity } from '@medplum/fhirtypes';
import { useResource } from '@medplum/react';
import { IconExternalLink, IconMaximize, IconPill } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import { getDataSource } from '../../utils/patient-timeline';
import classes from './MedicationRequestDetails.module.css';
import { getQuantityQualifierLabel } from './quantity-qualifiers';

/** Short names for the code and identifier systems a prescription carries. */
const SYSTEM_LABELS: Record<string, string> = {
  'http://www.nlm.nih.gov/research/umls/rxnorm': 'RxNorm',
  'http://hl7.org/fhir/sid/ndc': 'NDC',
  'https://drchrono.com/medications': 'DrChrono',
};

/**
 * A short, readable name for a code system: a known name, else its host and path.
 * @param system - The system URI.
 * @returns The label.
 */
export function systemLabel(system: string | undefined): string {
  if (!system) {
    return 'Code';
  }
  if (SYSTEM_LABELS[system]) {
    return SYSTEM_LABELS[system];
  }
  return system.replace(/^https?:\/\//, '');
}

interface MedicationRequestDetailsProps {
  medicationRequest: MedicationRequest;
  medicationOrderExtensions: MedicationOrderExtensions;
  onOpenInScriptSure: () => void;
}

/**
 * Format dispense quantity: numeric value plus NCI potency-unit label (not UCUM).
 * @param quantity - FHIR Quantity on dispenseRequest.
 * @returns Human-readable quantity string.
 */
function formatQuantityWithQualifier(quantity: Quantity | undefined): string {
  if (!quantity) {
    return '—';
  }
  const parts: string[] = [];
  if (quantity.comparator) {
    parts.push(quantity.comparator);
  }
  if (quantity.value !== undefined) {
    parts.push(String(quantity.value));
  }
  const rawUnit = quantity.unit?.trim();
  const code = quantity.code?.trim();
  const qualifierKey = rawUnit || code || '';
  const nciLabel = qualifierKey ? getQuantityQualifierLabel(qualifierKey) : undefined;
  const human = nciLabel || rawUnit || (code && quantity.system ? `${quantity.system}|${code}` : code) || '';
  if (human) {
    parts.push(human);
  }
  return parts.join(' ').trim() || '—';
}

function formatDosageLine(dosage: Dosage, index: number): JSX.Element {
  const label = `Dose / sig ${index + 1}`;
  const bits: string[] = [];
  if (dosage.text) {
    bits.push(dosage.text);
  }
  if (dosage.patientInstruction) {
    bits.push(`Patient: ${dosage.patientInstruction}`);
  }
  if (dosage.timing?.repeat) {
    const r = dosage.timing.repeat;
    let timingSummary: string | undefined;
    if (r.frequency !== undefined && r.period !== undefined) {
      timingSummary = `${r.frequency} per ${r.period} ${r.periodUnit ?? ''}`.trim();
    } else if (r.boundsDuration?.value !== undefined) {
      timingSummary = `${r.boundsDuration.value} ${r.boundsDuration.unit ?? ''}`.trim();
    } else if (r.boundsRange?.low?.value !== undefined || r.boundsRange?.high?.value !== undefined) {
      timingSummary = `${r.boundsRange?.low?.value ?? '?'}–${r.boundsRange?.high?.value ?? '?'}`;
    }
    if (timingSummary) {
      bits.push(`Timing: ${timingSummary}`);
    }
  }
  if (dosage.timing?.code?.text) {
    bits.push(`Schedule: ${dosage.timing.code.text}`);
  }
  if (dosage.route) {
    bits.push(`Route: ${formatCodeableConcept(dosage.route)}`);
  }
  const doseQty = dosage.doseAndRate?.[0]?.doseQuantity;
  if (doseQty) {
    bits.push(`Amount: ${formatQuantityWithQualifier(doseQty)}`);
  }
  const body = bits.length > 0 ? bits.join(' · ') : '—';
  return (
    <div key={index} className={classes.row}>
      <Text className={classes.label}>{label}</Text>
      <Text size="sm" flex={1}>
        {body}
      </Text>
    </div>
  );
}

function DetailRow(props: { label: string; children: ReactNode }): JSX.Element {
  const { label, children } = props;
  return (
    <div className={classes.row}>
      <Text className={classes.label}>{label}</Text>
      <Stack gap={4} flex={1} miw={0}>
        {children}
      </Stack>
    </div>
  );
}

export function MedicationRequestDetails(props: MedicationRequestDetailsProps): JSX.Element {
  const { medicationRequest, medicationOrderExtensions, onOpenInScriptSure } = props;
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const requesterRes = useResource(medicationRequest.requester) as Practitioner | undefined;
  const patientRes = useResource(medicationRequest.subject) as Patient | undefined;

  const pendingId = getPendingMedicationOrderId(medicationRequest, medicationOrderExtensions);
  const pendingStatus = getPendingMedicationOrderStatus(medicationRequest, medicationOrderExtensions);
  const storedIframeUrl = getMedicationOrderIframeUrl(medicationRequest, medicationOrderExtensions);

  const medText =
    medicationRequest.medicationCodeableConcept?.text ||
    formatCodeableConcept(medicationRequest.medicationCodeableConcept) ||
    '—';

  const requesterName =
    medicationRequest.requester?.display ||
    (requesterRes?.resourceType === 'Practitioner' ? formatHumanName(requesterRes.name?.[0]) : undefined);

  const dispQty = medicationRequest.dispenseRequest?.quantity;
  const rawQualifier = dispQty?.unit?.trim() || dispQty?.code?.trim();
  const qualifierHint = getQuantityQualifierTooltip(rawQualifier);

  const openFullRecord = (): void => {
    if (medicationRequest.id) {
      navigate(`/MedicationRequest/${medicationRequest.id}`)?.catch(console.error);
    }
  };

  const ordered = formatFhirDate(medicationRequest.authoredOn || medicationRequest.meta?.lastUpdated, timeZone);
  const fromDrChrono = getDataSource(medicationRequest) === 'drchrono';

  return (
    <ScrollArea h="100%" type="scroll">
      <Paper p="lg" h="100%" className={classes.root}>
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <Group gap={14} wrap="nowrap" align="flex-start" miw={0}>
              <span className={classes.icon}>
                <IconPill size={22} />
              </span>
              <Stack gap={6} miw={0}>
                <Text className={classes.title}>{medText}</Text>
                <Group gap={6}>
                  <Badge size="sm" radius="sm" color={medicationStatusColor(medicationRequest.status)} variant="light">
                    {medicationRequest.status ?? 'unknown'}
                  </Badge>
                  {fromDrChrono && (
                    <Badge size="sm" radius="sm" color="teal" variant="light" tt="none">
                      From DrChrono
                    </Badge>
                  )}
                  <Text className={classes.subtle}>
                    Last updated {formatFhirDate(medicationRequest.meta?.lastUpdated, timeZone) ?? '—'}
                  </Text>
                </Group>
              </Stack>
            </Group>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                leftSection={<IconMaximize size={15} />}
                onClick={openFullRecord}
                disabled={!medicationRequest.id}
              >
                View full record
              </Button>
              {(pendingId || storedIframeUrl) && (
                <Button size="xs" leftSection={<IconExternalLink size={15} />} onClick={onOpenInScriptSure}>
                  Open in ScriptSure
                </Button>
              )}
            </Group>
          </Group>

          <div className={classes.facts}>
            <div className={classes.fact}>
              <Text className={classes.factLabel}>Ordered</Text>
              <Text className={classes.factValue}>{ordered ?? '—'}</Text>
            </div>
            <div className={classes.fact}>
              <Text className={classes.factLabel}>Prescriber</Text>
              <Text className={classes.factValue}>{requesterName ?? '—'}</Text>
            </div>
            <div className={classes.fact}>
              <Text className={classes.factLabel}>Quantity</Text>
              <Text className={classes.factValue}>{dispQty ? formatQuantityWithQualifier(dispQty) : '—'}</Text>
            </div>
            <div className={classes.fact}>
              <Text className={classes.factLabel}>Refills</Text>
              <Text className={classes.factValue}>
                {medicationRequest.dispenseRequest?.numberOfRepeatsAllowed ?? '—'}
              </Text>
            </div>
          </div>

          {medicationRequest.statusReason && (
            <Paper p="sm" withBorder bg="var(--mantine-color-red-light)">
              <Text size="sm" fw={600}>
                Status reason
              </Text>
              <Text size="sm">
                {medicationRequest.statusReason.text || formatCodeableConcept(medicationRequest.statusReason)}
              </Text>
            </Paper>
          )}

          <Text className={classes.subtle}>
            Intent: {medicationRequest.intent ?? '—'}
            {medicationRequest.priority ? ` · Priority: ${medicationRequest.priority}` : ''}
            {medicationRequest.reportedBoolean !== undefined
              ? ` · Reported (secondary record): ${medicationRequest.reportedBoolean ? 'yes' : 'no'}`
              : ''}
          </Text>

          {(pendingStatus || pendingId) && (
            <Text size="sm">
              <Text span fw={600}>
                e-Prescribing:
              </Text>{' '}
              {pendingStatus && `pending status ${pendingStatus}`}
              {pendingStatus && pendingId ? ' · ' : ''}
              {pendingId && `order #${pendingId}`}
            </Text>
          )}

          <div className={classes.card}>
            <Text className={classes.cardTitle}>Prescription</Text>
            {medicationRequest.category && medicationRequest.category.length > 0 && (
              <DetailRow label="Category">
                {medicationRequest.category.map((c, i) => (
                  <Text key={i} size="sm">
                    {formatCodeableConcept(c)}
                  </Text>
                ))}
              </DetailRow>
            )}

            {patientRes?.resourceType === 'Patient' && (
              <DetailRow label="Patient">
                <Text size="sm">{formatHumanName(patientRes.name?.[0])}</Text>
              </DetailRow>
            )}

            {medicationRequest.reasonCode && medicationRequest.reasonCode.length > 0 && (
              <DetailRow label="Reason">
                {medicationRequest.reasonCode.map((r, i) => (
                  <Text key={i} size="sm">
                    {r.text || formatCodeableConcept(r)}
                  </Text>
                ))}
              </DetailRow>
            )}

            {medicationRequest.dosageInstruction?.map((d, i) => formatDosageLine(d, i))}

            <DetailRow label="Dispense">
              <>
                {dispQty && (
                  <Group gap="xs" align="center" wrap="wrap">
                    <Text size="sm">
                      <Text span fw={600}>
                        Quantity:{' '}
                      </Text>
                      {formatQuantityWithQualifier(dispQty)}
                    </Text>
                    {qualifierHint && (
                      <Tooltip label={qualifierHint} multiline w={280} withArrow>
                        <Text size="xs" c="dimmed" style={{ cursor: 'help', textDecoration: 'underline dotted' }}>
                          What is this code?
                        </Text>
                      </Tooltip>
                    )}
                  </Group>
                )}
                {medicationRequest.dispenseRequest?.validityPeriod && (
                  <Text size="sm">
                    Validity:{' '}
                    {medicationRequest.dispenseRequest.validityPeriod.start
                      ? formatFhirDate(medicationRequest.dispenseRequest.validityPeriod.start, timeZone)
                      : '?'}
                    {' – '}
                    {medicationRequest.dispenseRequest.validityPeriod.end
                      ? formatFhirDate(medicationRequest.dispenseRequest.validityPeriod.end, timeZone)
                      : '?'}
                  </Text>
                )}
                {medicationRequest.dispenseRequest?.expectedSupplyDuration?.value !== undefined && (
                  <Text size="sm">
                    <Text span fw={600}>
                      Days supply:{' '}
                    </Text>
                    {medicationRequest.dispenseRequest.expectedSupplyDuration.value}{' '}
                    {medicationRequest.dispenseRequest.expectedSupplyDuration.unit === 'days' ||
                    medicationRequest.dispenseRequest.expectedSupplyDuration.code === 'd'
                      ? 'days'
                      : (medicationRequest.dispenseRequest.expectedSupplyDuration.unit ??
                        medicationRequest.dispenseRequest.expectedSupplyDuration.code ??
                        '')}
                  </Text>
                )}
                {medicationRequest.dispenseRequest?.numberOfRepeatsAllowed !== undefined && (
                  <Text size="sm">Refills allowed: {medicationRequest.dispenseRequest.numberOfRepeatsAllowed}</Text>
                )}
                {medicationRequest.dispenseRequest?.performer && (
                  <Text size="sm">
                    Intended dispenser:{' '}
                    {medicationRequest.dispenseRequest.performer.display ||
                      medicationRequest.dispenseRequest.performer.reference}
                  </Text>
                )}
                {!dispQty &&
                  medicationRequest.dispenseRequest?.numberOfRepeatsAllowed === undefined &&
                  !medicationRequest.dispenseRequest?.validityPeriod && (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
              </>
            </DetailRow>

            {medicationRequest.substitution && (
              <DetailRow label="Substitution">
                <Text size="sm">
                  {formatSubstitutionAllowed(medicationRequest.substitution.allowedBoolean)}
                  {medicationRequest.substitution.reason && (
                    <> · {formatCodeableConcept(medicationRequest.substitution.reason)}</>
                  )}
                </Text>
              </DetailRow>
            )}

            {medicationRequest.note && medicationRequest.note.length > 0 && (
              <DetailRow label="Notes">
                {medicationRequest.note.map((n, i) => (
                  <Text key={i} size="sm">
                    {n.text}
                  </Text>
                ))}
              </DetailRow>
            )}

            {medicationRequest.medicationCodeableConcept?.coding &&
              medicationRequest.medicationCodeableConcept.coding.length > 0 && (
                <DetailRow label="Medication codes">
                  <Group gap={6}>
                    {medicationRequest.medicationCodeableConcept.coding.map((c, i) => (
                      <span
                        key={i}
                        className={classes.code}
                        title={c.display ? `${c.display} · ${c.system}` : c.system}
                      >
                        {systemLabel(c.system)} {c.code}
                      </span>
                    ))}
                  </Group>
                </DetailRow>
              )}

            {medicationRequest.identifier && medicationRequest.identifier.length > 0 && (
              <DetailRow label="Identifiers">
                <Group gap={6}>
                  {medicationRequest.identifier.map((id, i) => (
                    <span key={i} className={classes.code} title={id.system}>
                      {systemLabel(id.system)} #{id.value}
                    </span>
                  ))}
                </Group>
              </DetailRow>
            )}
          </div>
        </Stack>
      </Paper>
    </ScrollArea>
  );
}

function getQuantityQualifierTooltip(rawQualifier: string | undefined): string | undefined {
  if (!rawQualifier) {
    return undefined;
  }
  const labeled = getQuantityQualifierLabel(rawQualifier);
  if (labeled) {
    return `Code ${rawQualifier} is a DAW/NCI “quantity qualifier” (${labeled}), not a UCUM unit like “mg” or “mL”. It describes how to count the dispensed amount (e.g. tablets).`;
  }
  if (/^C\d+$/i.test(rawQualifier)) {
    return `Unlabeled code “${rawQualifier}” is a quantity-qualifier / NCI potency-unit code stored on the dispense quantity, not a UCUM unit.`;
  }
  return undefined;
}

function formatSubstitutionAllowed(allowed: boolean | undefined): string {
  if (allowed === true) {
    return 'Allowed';
  }
  if (allowed === false) {
    return 'Not allowed';
  }
  return '—';
}

function medicationStatusColor(status: string | undefined): string {
  switch (status) {
    case 'active':
      return 'blue';
    case 'draft':
      return 'yellow';
    case 'on-hold':
      return 'orange';
    case 'cancelled':
    case 'entered-in-error':
      return 'red';
    case 'completed':
    case 'stopped':
      return 'green';
    case 'unknown':
      return 'gray';
    default:
      return 'gray';
  }
}
