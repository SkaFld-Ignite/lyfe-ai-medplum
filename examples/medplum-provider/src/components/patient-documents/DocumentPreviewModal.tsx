// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Loader, Modal } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { WithId } from '@medplum/core';
import type { DocumentReference, Patient, Reference } from '@medplum/fhirtypes';
import { useResource } from '@medplum/react';
import type { JSX } from 'react';
import { DocumentDetailPanel } from '../../pages/patient/DocumentDetailPanel';
import classes from './PatientDocuments.module.css';

export interface DocumentPreviewModalProps {
  /** The document to show, or undefined when the modal is closed. */
  documentId?: string;
  /** The loaded row's document, shown immediately instead of re-reading it. */
  document?: WithId<DocumentReference>;
  patient: Reference<Patient>;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}

/**
 * Previews a document in a modal, with its edit, open, fax and delete actions.
 * @param props - The modal props.
 * @returns The modal.
 */
export function DocumentPreviewModal(props: DocumentPreviewModalProps): JSX.Element {
  const { documentId, document, patient, onClose, onChanged, onDeleted } = props;
  const isMobile = useMediaQuery('(max-width: 48em)');
  // A deep link can name a document that is not in the loaded list (e.g. beyond the first page).
  const fetched = useResource<DocumentReference>(
    documentId && !document ? { reference: `DocumentReference/${documentId}` } : undefined
  );
  const item = document ?? fetched;

  return (
    <Modal
      opened={Boolean(documentId)}
      onClose={onClose}
      size="80rem"
      fullScreen={isMobile}
      radius="md"
      title="Document preview"
      classNames={{ body: classes.previewBody }}
    >
      <Box className={classes.previewFrame}>
        {item ? (
          <DocumentDetailPanel
            key={item.id}
            item={item}
            patientRef={patient}
            onDocumentChange={onChanged}
            onDocumentDeleted={onDeleted}
          />
        ) : (
          <Box className={classes.previewLoading}>
            <Loader />
          </Box>
        )}
      </Box>
    </Modal>
  );
}
