// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box } from '@mantine/core';
import { PatientExportForm } from '@medplum/react';
import { IconDownload } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useParams } from 'react-router';
import { PatientTabShell } from '../../components/patient-shell/PatientTabShell';

export function ExportTab(): JSX.Element | null {
  const { patientId } = useParams();
  return (
    <PatientTabShell
      icon={<IconDownload size={20} />}
      title="Export"
      description="Download this patient's record as FHIR, a patient summary or C-CDA"
    >
      <Box p="lg" maw={640}>
        <PatientExportForm patient={{ reference: `Patient/${patientId}` }} />
      </Box>
    </PatientTabShell>
  );
}
