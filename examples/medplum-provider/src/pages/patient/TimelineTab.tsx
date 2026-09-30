// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Loader } from '@mantine/core';
import type { JSX } from 'react';
import { PatientTimelineView } from '../../components/patient-timeline/PatientTimelineView';
import { usePatient } from '../../hooks/usePatient';

export function TimelineTab(): JSX.Element {
  const patient = usePatient();
  if (!patient?.id) {
    return <Loader />;
  }
  return <PatientTimelineView patientId={patient.id} />;
}
