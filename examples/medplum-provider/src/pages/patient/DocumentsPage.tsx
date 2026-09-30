// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useDisclosure } from '@mantine/hooks';
import type { DocumentReference } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PatientDocumentsView } from '../../components/patient-documents/PatientDocumentsView';
import { UploadDocumentModal } from './UploadDocumentModal';

/**
 * The patient's Documents tab. `/DocumentReference/:documentId` opens that document's preview.
 * @returns The documents page.
 */
export function DocumentsPage(): JSX.Element {
  const navigate = useNavigate();
  const { patientId, documentId } = useParams() as { patientId: string; documentId?: string };
  const [uploadOpened, { open: openUpload, close: closeUpload }] = useDisclosure(false);
  const [reloadKey, setReloadKey] = useState(0);
  const basePath = `/Patient/${patientId}/DocumentReference`;

  const handleCreated = (doc: DocumentReference): void => {
    setReloadKey((k) => k + 1);
    navigate(`${basePath}/${doc.id}`)?.catch(console.error);
  };

  return (
    <>
      <PatientDocumentsView
        patientId={patientId}
        documentId={documentId}
        reloadKey={reloadKey}
        onOpenDocument={(id) => navigate(`${basePath}/${id}`)?.catch(console.error)}
        onClosePreview={() => navigate(basePath)?.catch(console.error)}
        onUpload={openUpload}
      />
      <UploadDocumentModal
        opened={uploadOpened}
        onClose={closeUpload}
        patient={{ reference: `Patient/${patientId}` }}
        onCreated={handleCreated}
      />
    </>
  );
}
