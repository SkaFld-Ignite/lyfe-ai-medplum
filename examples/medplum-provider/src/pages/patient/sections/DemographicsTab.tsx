// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Group, RingProgress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { formatAddress, formatHumanName, getExtension } from '@medplum/core';
import type { Address, Patient } from '@medplum/fhirtypes';
import type { Icon } from '@tabler/icons-react';
import {
  IconAlertOctagon,
  IconCake,
  IconHome,
  IconLanguage,
  IconMapPin,
  IconMessage,
  IconPencil,
  IconPhone,
  IconUser,
  IconUserCircle,
  IconWorld,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { getAge, getInitials } from '../../../components/patients/patient-roster-utils';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatient } from '../../../hooks/usePatient';
import { formatFhirDate } from '../../../utils/clinic-time';
import classes from './Demographics.module.css';
import { conceptLabel, humanize } from './section-utils';

const RACE_URL = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race';
const ETHNICITY_URL = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity';

type Tone = 'blue' | 'violet' | 'rose' | 'teal' | 'amber' | 'pink';

function usCoreText(patient: Patient, url: string): string | undefined {
  const ext = getExtension(patient, url);
  return (
    ext?.extension?.find((e) => e.url === 'text')?.valueString ??
    ext?.extension?.find((e) => e.url === 'ombCategory')?.valueCoding?.display
  );
}

function phone(patient: Patient, use?: string): string | undefined {
  return patient.telecom?.find((t) => (t.system === 'phone' || t.system === 'sms') && (!use || t.use === use))?.value;
}

function emails(patient: Patient): string[] {
  return (patient.telecom ?? []).filter((t) => t.system === 'email' && t.value).map((t) => t.value as string);
}

function Field(props: { label: string; value?: ReactNode }): JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap" gap="md" className={classes.field}>
      <Text className={classes.fieldLabel}>{props.label}</Text>
      {props.value ? (
        <Text className={classes.fieldValue}>{props.value}</Text>
      ) : (
        <Text className={classes.fieldEmpty}>Not on file</Text>
      )}
    </Group>
  );
}

function SectionCard(props: {
  icon: Icon;
  tone: Tone;
  title: string;
  pill?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const SectionIcon = props.icon;
  return (
    <Box component="section" aria-label={props.title} className={classes.card} data-tone={props.tone}>
      <Group gap={8} className={classes.cardHeader}>
        <span className={classes.chip}>
          <SectionIcon size={14} />
        </span>
        <Text className={classes.cardTitle}>{props.title}</Text>
        {props.pill}
      </Group>
      <Box className={classes.cardBody}>{props.children}</Box>
    </Box>
  );
}

function Fact(props: { icon: Icon; tone: Tone; label: string; value?: string; sub?: string }): JSX.Element {
  const FactIcon = props.icon;
  return (
    <Group gap="sm" wrap="nowrap" className={classes.fact} data-tone={props.tone}>
      <span className={classes.factTile}>
        <FactIcon size={16} />
      </span>
      <Box miw={0}>
        <Text className={classes.factLabel}>{props.label}</Text>
        <Text className={props.value ? classes.factValue : classes.fieldEmpty} truncate="end">
          {props.value ?? 'Not on file'}
        </Text>
        {props.sub && <Text className={classes.factSub}>{props.sub}</Text>}
      </Box>
    </Group>
  );
}

function addressText(address: Address | undefined): string | undefined {
  return address ? formatAddress(address) || undefined : undefined;
}

/**
 * The Lyfe "Patient Demographics" section: a read-only profile of the Patient resource with a
 * completeness ring, quick facts and grouped field cards. Editing goes through Medplum's edit form.
 * @returns The demographics tab.
 */
export function DemographicsTab(): JSX.Element | null {
  const patient = usePatient();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  if (!patient?.id) {
    return null;
  }

  const name = patient.name?.[0] ? formatHumanName(patient.name[0]) : undefined;
  const dob = formatFhirDate(patient.birthDate, timeZone);
  const age = getAge(patient.birthDate, timeZone);
  const gender = humanize(patient.gender);
  const language = conceptLabel(
    patient.communication?.find((c) => c.preferred)?.language ?? patient.communication?.[0]?.language
  );
  const race = usCoreText(patient, RACE_URL);
  const ethnicity = usCoreText(patient, ETHNICITY_URL);
  const marital = conceptLabel(patient.maritalStatus);
  const [email, altEmail] = emails(patient);
  const emergency = patient.contact?.[0];
  const current = patient.address?.filter((a) => !a.period?.end) ?? [];
  const home = current.find((a) => a.use === 'home' || !a.use);
  const mail = current.find((a) => a.type === 'postal' && a !== home);
  const previous = patient.address?.filter((a) => a.period?.end || a.use === 'old') ?? [];

  const tracked = [
    name,
    dob,
    gender,
    race,
    ethnicity,
    marital,
    language,
    phone(patient),
    email,
    addressText(home),
    emergency?.name,
  ];
  const filled = tracked.filter(Boolean).length;
  const percent = Math.round((filled / tracked.length) * 100);

  return (
    <Stack gap={20} p="md">
      <Box className={classes.hero}>
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
          <Group gap="md" wrap="nowrap" miw={0}>
            <span className={classes.avatar}>{getInitials(patient)}</span>
            <Box miw={0}>
              <Text className={classes.eyebrow}>Patient profile</Text>
              <Title order={2} className={classes.heroTitle}>
                Patient Demographics
              </Title>
              <Text size="sm" c="dimmed">
                Read-only demographic and contact information.
              </Text>
            </Box>
          </Group>
          <Group gap="md" wrap="nowrap">
            <Group gap={10} wrap="nowrap" visibleFrom="lg">
              <RingProgress
                size={48}
                thickness={5}
                roundCaps
                sections={[{ value: percent, color: '#2563eb' }]}
                rootColor="#e2e8f0"
                label={
                  <Text ta="center" fz={10} fw={700}>
                    {percent}%
                  </Text>
                }
              />
              <Box>
                <Text className={classes.factLabel}>Profile</Text>
                <Text fz={12} fw={600}>
                  {filled} of {tracked.length} fields
                </Text>
              </Box>
            </Group>
            <Button
              variant="default"
              leftSection={<IconPencil size={14} />}
              onClick={() => navigate(`/Patient/${patient.id}/edit`)?.catch(console.error)}
            >
              Edit details
            </Button>
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm" className={classes.facts}>
          <Fact icon={IconUser} tone="blue" label="Name" value={name} />
          <Fact
            icon={IconCake}
            tone="violet"
            label="Date of birth"
            value={dob}
            sub={age !== '—' ? `${age} years old` : undefined}
          />
          <Fact
            icon={IconUserCircle}
            tone={patient.gender === 'female' ? 'rose' : 'blue'}
            label="Gender"
            value={gender}
          />
          <Fact icon={IconLanguage} tone="teal" label="Language" value={language} />
        </SimpleGrid>
      </Box>

      <div className={classes.grid}>
        <SectionCard icon={IconUser} tone="blue" title="Basic information">
          <Field label="Full name" value={name} />
          <Field label="Date of birth" value={dob} />
          <Field label="Gender" value={gender} />
          <Field label="Race" value={race} />
          <Field label="Ethnicity" value={ethnicity} />
          <Field label="Marital status" value={marital} />
          <Field label="Preferred language" value={language} />
        </SectionCard>
        <SectionCard icon={IconPhone} tone="teal" title="Contact info">
          <Field label="Cell phone" value={phone(patient, 'mobile') ?? phone(patient)} />
          <Field label="Home phone" value={phone(patient, 'home')} />
          <Field label="Office phone" value={phone(patient, 'work')} />
          <Field label="Email" value={email} />
          <Field label="Alternate email" value={altEmail} />
        </SectionCard>
        <SectionCard icon={IconMessage} tone="violet" title="Communication preferences">
          <Field label="Preferred language" value={language} />
          <Field
            label="Preferred contact method"
            value={humanize(patient.telecom?.find((t) => t.rank === 1)?.system)}
          />
        </SectionCard>
        <SectionCard
          icon={IconAlertOctagon}
          tone="rose"
          title="Emergency contact"
          pill={emergency ? <span className={classes.rosePill}>On file</span> : undefined}
        >
          <Field label="Name" value={emergency?.name ? formatHumanName(emergency.name) : undefined} />
          <Field label="Phone" value={emergency?.telecom?.find((t) => t.system === 'phone')?.value} />
          <Field label="Relationship" value={conceptLabel(emergency?.relationship?.[0])} />
        </SectionCard>
        <SectionCard icon={IconHome} tone="amber" title="Address">
          <Field label="Home address" value={addressText(home)} />
          <Field label="Mail address" value={addressText(mail)} />
        </SectionCard>
        <SectionCard
          icon={IconMapPin}
          tone="pink"
          title="Previous addresses"
          pill={<span className={classes.countPill}>{previous.length}</span>}
        >
          {previous.length === 0 ? (
            <Text className={classes.dashed}>No previous address records</Text>
          ) : (
            previous.map((a, i) => (
              <Group key={i} gap={8} wrap="nowrap" className={classes.field}>
                <IconWorld size={14} color="#94a3b8" />
                <Text className={classes.fieldValue} ta="left">
                  {addressText(a)}
                </Text>
              </Group>
            ))
          )}
        </SectionCard>
      </div>
    </Stack>
  );
}
