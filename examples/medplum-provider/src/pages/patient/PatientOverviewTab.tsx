// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Box, Button, Modal, Skeleton, Stack, UnstyledButton } from '@mantine/core';
import { formatDate } from '@medplum/core';
import { createPharmaciesSection, getDefaultSections, PatientSummary } from '@medplum/react';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCalendarCheck,
  IconClipboardHeart,
  IconHeart,
  IconPill,
  IconShieldCheck,
  IconStethoscope,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { DrugInteractionsCard } from '../../components/ai/DrugInteractionsCard';
import { AiSummaryCard } from '../../components/patient-overview/AiSummaryCard';
import { OverviewSection } from '../../components/patient-overview/OverviewSection';
import classes from '../../components/patient-overview/PatientOverview.module.css';
import { ProfileCard } from '../../components/patient-overview/ProfileCard';
import { RiskBanner } from '../../components/patient-overview/RiskBanner';
import { VisitTimeline } from '../../components/patient-overview/VisitTimeline';
import { VitalCard } from '../../components/patient-overview/VitalCard';
import { usePharmacyDialog } from '../../components/pharmacy/usePharmacyDialog';
import { usePatient } from '../../hooks/usePatient';
import { usePatientOverview } from '../../hooks/usePatientOverview';
import { POLYPHARMACY_THRESHOLD } from '../../utils/patient-overview';
import { OrderLabsPage } from '../labs/OrderLabsPage';
import { getPatientPageTabOrThrow, patientPathPrefix } from './PatientPage.utils';

/**
 * The patient's Lyfe-style overview: clinical flags, the latest vitals with trends, the active
 * clinical profile and the visit timeline, then Medplum's full PatientSummary (with its order-labs
 * and pharmacy dialogs) as the chart summary.
 * @returns The overview tab.
 */
export function PatientOverviewTab(): JSX.Element | null {
  const navigate = useNavigate();
  const patient = usePatient();
  const patientId = patient?.id ?? '';
  const { overview, loading, error, reload } = usePatientOverview(patientId);
  const [isLabsModalOpen, setIsLabsModalOpen] = useState(false);
  const PharmacyDialogComponent = usePharmacyDialog();

  const closeLabsModal = useCallback(() => setIsLabsModalOpen(false), []);
  const sections = useMemo(
    () =>
      getDefaultSections(() => setIsLabsModalOpen(true)).map((s) =>
        s.key === 'pharmacies' ? createPharmaciesSection(PharmacyDialogComponent) : s
      ),
    [PharmacyDialogComponent]
  );

  if (!patient?.id) {
    return null;
  }

  const base = patientPathPrefix(patientId);
  const go = (path: string) => () => navigate(`${base}/${path}`)?.catch(console.error);
  const medsPath = getPatientPageTabOrThrow('meds').url.replace('%patient.id', patientId);

  return (
    <div className={classes.page}>
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not load the overview">
          {error}{' '}
          <Button variant="subtle" color="red" size="compact-sm" onClick={reload}>
            Retry
          </Button>
        </Alert>
      )}

      {loading || !overview ? (
        <Stack gap="md" aria-busy="true" aria-label="Loading overview">
          <Skeleton h={58} radius={12} />
          <Skeleton h={250} radius={12} />
          <Skeleton h={240} radius={12} />
        </Stack>
      ) : (
        <>
          <RiskBanner flags={overview.flags} />

          <OverviewSection
            icon={<IconHeart size={16} />}
            tone="rose"
            title="Vital Signs"
            subtitle={
              overview.vitalsDate ? `Recorded ${formatDate(overview.vitalsDate.toISOString())}` : 'Most recent reading'
            }
            right={
              <UnstyledButton className={classes.viewAll} onClick={go('vitals')}>
                View all
                <span className={classes.viewAllArrow}>
                  <IconArrowRight size={11} />
                </span>
              </UnstyledButton>
            }
          >
            <div className={classes.vitalsGrid}>
              <VitalCard vital={overview.vitals.bp} />
              <VitalCard vital={overview.vitals.hr} />
              <VitalCard vital={overview.vitals.spo2} />
              <VitalCard vital={overview.vitals.weight} />
            </div>
          </OverviewSection>

          <OverviewSection
            icon={<IconStethoscope size={16} />}
            tone="slate"
            title="Active Clinical Profile"
            subtitle="Conditions, medications, and allergies"
            right={
              <Box className={classes.countPills} visibleFrom="sm">
                <span>{overview.conditions.length} Conditions</span>
                <span>{overview.medications.length} Meds</span>
                <span>{overview.allergies.length} Allergies</span>
              </Box>
            }
          >
            <div className={classes.profileGrid}>
              <ProfileCard
                label="Conditions"
                icon={<IconClipboardHeart size={20} />}
                tone="purple"
                items={overview.conditions}
                suffix="active"
                pill={
                  overview.conditions.length >= 3
                    ? { label: `${overview.conditions.length} chronic`, severity: 'watch' }
                    : undefined
                }
                emptyText="No active conditions"
                onOpen={go('conditions')}
              />
              <ProfileCard
                label="Medications"
                icon={<IconPill size={20} />}
                tone="blue"
                items={overview.medications}
                suffix="active"
                pill={
                  overview.medications.length > POLYPHARMACY_THRESHOLD
                    ? { label: 'Polypharmacy', severity: 'watch' }
                    : undefined
                }
                emptyText="No active medications"
                onOpen={go(medsPath)}
              />
              <ProfileCard
                label="Allergies"
                icon={<IconShieldCheck size={20} />}
                tone={overview.severeAllergyCount > 0 ? 'rose' : 'emerald'}
                items={overview.allergies}
                suffix="recorded"
                pill={
                  overview.severeAllergyCount > 0
                    ? { label: `${overview.severeAllergyCount} severe`, severity: 'critical' }
                    : undefined
                }
                emptyText="No allergy records — verify with patient"
                onOpen={go('allergies')}
              />
            </div>
          </OverviewSection>

          <OverviewSection
            icon={<IconCalendarCheck size={16} />}
            tone="indigo"
            title="Visit Timeline"
            subtitle="Continuity of care at a glance"
          >
            <VisitTimeline
              lastVisit={overview.lastVisit}
              nextVisit={overview.nextVisit}
              onSchedule={() => navigate('/scheduling')?.catch(console.error)}
            />
          </OverviewSection>
        </>
      )}

      {/* Outside the overview's loading guard on purpose: the summary is a separate
          read with its own states, and a slow Composition search should not hold
          back the vitals and the clinical profile. */}
      <AiSummaryCard patientId={patientId} />

      {/* Next to the AI summary rather than on the Medications page: this is the
          chart's advisory-AI area, and the medications page is a fill layout
          whose whole height is the prescription list. The review reads the
          patient's active MedicationRequests itself, so it is correct here. */}
      <DrugInteractionsCard patientId={patientId} />

      <OverviewSection
        icon={<IconClipboardHeart size={16} />}
        tone="slate"
        title="Chart summary"
        subtitle="Insurance, problems, medications, labs, vitals and pharmacies on file"
      >
        <Box className={classes.summaryBody}>
          <PatientSummary
            patient={patient}
            onClickResource={(resource) =>
              navigate(`/Patient/${patientId}/${resource.resourceType}/${resource.id}`)?.catch(console.error)
            }
            sections={sections}
          />
        </Box>
      </OverviewSection>

      <Modal opened={isLabsModalOpen} onClose={closeLabsModal} size="xl" centered title="Order Labs">
        <OrderLabsPage onSubmitLabOrder={closeLabsModal} />
      </Modal>
    </div>
  );
}
