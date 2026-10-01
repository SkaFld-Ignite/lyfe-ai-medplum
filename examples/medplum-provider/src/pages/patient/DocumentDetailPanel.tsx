// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Badge, Box, Button, Flex, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { getDisplayString, getReferenceString } from '@medplum/core';
import type { Attachment, DocumentReference, Patient, Reference } from '@medplum/fhirtypes';
import { useCachedBinaryUrl, useMedplum } from '@medplum/react-hooks';
import {
  IconBrowserShare,
  IconEditCircle,
  IconExternalLink,
  IconFileText,
  IconPrinter,
  IconX,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { XmlDocumentPreview } from '../../components/cda/XmlDocumentPreview';
import { SendFaxModal } from '../../components/fax/SendFaxModal';
import { DOCUMENT_SOURCES } from '../../components/patient-documents/documents-config';
import {
  CsvPreview,
  DocxPreview,
  DownloadOnlyPreview,
  SpreadsheetPreview,
  TextPreview,
  TiffPreview,
} from '../../components/patient-documents/RichFilePreview';
import { useAttachmentBlob } from '../../hooks/useAttachmentBlob';
import { useAttachmentPreviewUrl } from '../../hooks/useAttachmentPreviewUrl';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { isXmlContentType } from '../../utils/cda';
import { formatFhirDate } from '../../utils/clinic-time';
import { getAttachmentContentType } from '../../utils/document-file-type';
import { showErrorNotification } from '../../utils/notifications';
import { FILE_NOT_COPIED_MESSAGE, openAttachment } from '../../utils/open-attachment';
import { getDataSource } from '../../utils/patient-timeline';
import type { PreviewKind } from '../../utils/preview-kind';
import { getPreviewKind } from '../../utils/preview-kind';
import classes from './DocumentDetailPanel.module.css';
import { getDocumentTypeDisplay } from './DocumentReference.utils';
import { EditDocumentDetailsModal } from './EditDocumentDetailsModal';

// Subtle 1px frame drawn around attachment previews (PDF iframe, images, video). Theme-aware so the
// frame stays subtle in both schemes: gray-3 in light, dark-4 in dark (matching the dividers).
const PREVIEW_BORDER =
  '1px solid color-mix(in srgb, light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4)) 50%, transparent)';

interface DocumentDetailPanelProps {
  item: WithId<DocumentReference>;
  patientRef?: Reference<Patient>;
  onDocumentChange: () => void;
  onDocumentDeleted: () => void;
  /** Shows a close button in the header, for when the panel is a dialog of its own. */
  onClose?: () => void;
}

export function DocumentDetailPanel({
  item,
  patientRef,
  onDocumentChange,
  onDocumentDeleted,
  onClose,
}: DocumentDetailPanelProps): JSX.Element {
  const [faxModalOpened, setFaxModalOpened] = useState(false);
  const [editModalOpened, setEditModalOpened] = useState(false);

  const storedAttachment = getAttachment(item);
  // Older imports stored files without a content type; infer it from the name so they still preview.
  const attachment = storedAttachment && {
    ...storedAttachment,
    contentType: getAttachmentContentType(item, storedAttachment),
  };
  const attachmentUrl = useCachedBinaryUrl(attachment?.url);
  const framed = isPdfLike(attachment);
  // PDFs and text render in an iframe, which Medplum-hosted URLs cannot be loaded into directly.
  const {
    previewUrl: framedUrl,
    loading: framedLoading,
    error: framedError,
  } = useAttachmentPreviewUrl(framed ? attachmentUrl : undefined, attachment?.contentType);
  const name = getDisplayString(item);
  const referenceString = getReferenceString(item);

  const medplum = useMedplum();
  const fileUrl = attachmentUrl ?? attachment?.url;
  const handleOpenInBrowser = (): void => {
    if (fileUrl) {
      openAttachment(medplum, fileUrl, { contentType: attachment?.contentType }).catch(showErrorNotification);
    }
  };

  const timeZone = useClinicTimeZone();
  const source = DOCUMENT_SOURCES.find((s) => s.source === getDataSource(item));
  const subtitle = [getDocumentTypeDisplay(item), item.date && `Dated ${formatFhirDate(item.date, timeZone)}`]
    .filter(Boolean)
    .join(' · ');
  const metadata = (
    <aside className={classes.details} aria-label="Document details">
      <Text className={classes.detailsTitle}>Details</Text>
      <DocumentMetadata item={item} contentType={storedAttachment?.contentType} timeZone={timeZone} />
    </aside>
  );

  return (
    <>
      <Box className={classes.panel}>
        <header className={classes.header}>
          <Group gap={12} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <span className={classes.fileIcon}>
              <IconFileText size={22} />
            </span>
            <Stack gap={2} miw={0}>
              <Text className={classes.title}>{name === referenceString ? 'Untitled Document' : name}</Text>
              <Group gap={8}>
                {subtitle && <Text className={classes.subtitle}>{subtitle}</Text>}
                {source && (
                  <Badge variant="light" color={source.color} size="sm" radius="sm" tt="none">
                    {source.badge}
                  </Badge>
                )}
              </Group>
            </Stack>
          </Group>

          <Group gap={8} wrap="nowrap">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconEditCircle size={15} />}
              onClick={() => setEditModalOpened(true)}
            >
              Edit details
            </Button>
            {attachment?.url && (
              <Button
                variant="default"
                size="xs"
                leftSection={<IconBrowserShare size={15} />}
                onClick={handleOpenInBrowser}
              >
                Open
              </Button>
            )}
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPrinter size={15} />}
              onClick={() => setFaxModalOpened(true)}
            >
              Fax
            </Button>
            {onClose && (
              <Tooltip label="Close" position="bottom" openDelay={500}>
                <ActionIcon variant="subtle" color="gray" size={30} onClick={onClose} aria-label="Close">
                  <IconX size={18} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </header>

        <Box className={classes.body}>
          <Box className={classes.viewer}>
            {framed && (
              <>
                {framedError && (
                  <NoPreview
                    onOpen={framedError === 'invalid' ? handleOpenInBrowser : undefined}
                    message={
                      framedError === 'invalid'
                        ? "This file is damaged or isn't a real PDF, so it can't be previewed."
                        : "This file hasn't been copied into Lyfe yet. Re-import the patient to fetch it."
                    }
                  />
                )}
                {framedLoading && (
                  <Flex flex={1} justify="center" align="center">
                    <Loader size="sm" />
                  </Flex>
                )}
                {framedUrl && (
                  <Box className={classes.frame}>
                    <iframe
                      title="Attachment"
                      width="100%"
                      height="100%"
                      src={framedUrl + '#navpanes=0'}
                      allowFullScreen={true}
                      style={{ display: 'block', border: 0 }}
                    />
                  </Box>
                )}
              </>
            )}
            {!framed &&
              (attachment ? (
                <AttachmentPreview attachment={attachment} url={attachmentUrl} onOpen={handleOpenInBrowser} />
              ) : (
                <Flex justify="center" align="center" h={300}>
                  <Text c="dimmed">No preview available for this document</Text>
                </Flex>
              ))}
          </Box>
          {metadata}
        </Box>
      </Box>

      <SendFaxModal
        opened={faxModalOpened}
        onClose={() => setFaxModalOpened(false)}
        defaultAttachment={attachment}
        defaultPatient={patientRef}
      />

      <EditDocumentDetailsModal
        item={item}
        opened={editModalOpened}
        onClose={() => setEditModalOpened(false)}
        onSaved={onDocumentChange}
        onDeleted={onDocumentDeleted}
      />
    </>
  );
}

function getAttachment(doc: DocumentReference): Attachment | undefined {
  return doc.content?.[0]?.attachment;
}

/**
 * Preview for a file whose bytes have to be decoded in the page.
 *
 * Downloading is deliberately a step of its own: the decoders are loaded only
 * once a file that needs them is opened, and a download that fails still leaves
 * the file reachable rather than showing an empty frame.
 * @param props - The preview inputs.
 * @param props.kind - Which decoder to use.
 * @param props.url - The attachment URL.
 * @param props.contentType - The file's content type.
 * @param props.onOpen - Opens or saves the original file.
 * @returns The rendered preview.
 */
function DecodedPreview(props: {
  kind: PreviewKind;
  url: string;
  contentType: string | undefined;
  onOpen: () => void;
}): JSX.Element {
  // A file we will not render needs no download at all.
  const needsBytes = props.kind !== 'download';
  const { blob, loading, error } = useAttachmentBlob(needsBytes ? props.url : undefined);

  if (props.kind === 'download') {
    return <DownloadOnlyPreview contentType={props.contentType} onDownload={props.onOpen} />;
  }
  if (loading) {
    return (
      <Flex justify="center" align="center" h={300}>
        <Loader size="sm" />
      </Flex>
    );
  }
  if (error || !blob) {
    return <NoPreview onOpen={props.onOpen} message={FILE_NOT_COPIED_MESSAGE} />;
  }
  if (props.kind === 'docx') {
    return <DocxPreview blob={blob} onDownload={props.onOpen} />;
  }
  if (props.kind === 'spreadsheet') {
    return <SpreadsheetPreview blob={blob} onDownload={props.onOpen} />;
  }
  if (props.kind === 'text') {
    return <TextPreview blob={blob} onDownload={props.onOpen} />;
  }
  if (props.kind === 'csv') {
    return <CsvPreview blob={blob} onDownload={props.onOpen} />;
  }
  return <TiffPreview blob={blob} onDownload={props.onOpen} />;
}

/**
 * Whether this file goes in the big framed viewer at the top of the panel.
 *
 * Only PDF. Text, JSON and CSV used to be framed too, and rendered as an empty
 * panel: Chrome *downloads* a `text/*` iframe rather than displaying it, so
 * there was nothing to see and no error to explain it. They are drawn as text
 * and as tables instead — see `getPreviewKind`, which this defers to so the two
 * cannot disagree about what a file is.
 * @param attachment - The attachment.
 * @returns True for files the framed viewer can actually show.
 */
function isPdfLike(attachment: Attachment | undefined): boolean {
  return getPreviewKind(attachment?.contentType) === 'framed';
}

function getAuthor(doc: DocumentReference): string | undefined {
  const author = doc.author?.[0];
  return author?.display ?? author?.reference;
}

function DocumentMetadata({
  item,
  contentType,
  timeZone,
}: {
  item: WithId<DocumentReference>;
  contentType: string | undefined;
  timeZone: string;
}): JSX.Element {
  const documentType = getDocumentTypeDisplay(item);
  const documentCategory =
    item.category
      ?.map((c) => c.coding?.[0]?.display || c.text)
      .filter(Boolean)
      .join(', ') || undefined;

  // Author row reflects the document's own author field; the Added/Last updated lines attribute to
  // the audit meta.author (original = oldest version, current = the loaded resource).
  const author = getAuthor(item);
  const currentAuthor = authorLabel(item.meta?.author);
  const lastUpdated = item.meta?.lastUpdated;
  const date = item.date || item.meta?.lastUpdated;

  return (
    <Stack gap={12}>
      {documentType && <MetadataRow label="Type" value={documentType} />}
      {documentCategory && <MetadataRow label="Category" value={documentCategory} />}
      {contentType && <MetadataRow label="Content type" value={contentType} />}
      <MetadataRow
        label="Author"
        value={
          author ?? (
            <Text span c="dimmed">
              No author attributed
            </Text>
          )
        }
      />
      {date && <MetadataRow label="Added" value={formatFhirDate(date, timeZone)} />}
      {lastUpdated && (
        <MetadataRow
          label="Last updated"
          value={
            <>
              {formatFhirDate(lastUpdated, timeZone)}
              {currentAuthor && <Text span>{` by ${currentAuthor}`}</Text>}
            </>
          }
        />
      )}
    </Stack>
  );
}

function authorLabel(ref: Reference | undefined): string | undefined {
  return ref?.display ?? ref?.reference;
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className={classes.field}>
      <Text className={classes.fieldLabel}>{label}</Text>
      <Text className={classes.fieldValue} component="div">
        {value}
      </Text>
    </div>
  );
}

interface AttachmentPreviewProps {
  attachment: Attachment;
  url: string | undefined;
  onOpen: () => void;
}

function AttachmentPreview({ attachment, url, onOpen }: AttachmentPreviewProps): JSX.Element {
  const contentType = attachment.contentType;

  // XML can also arrive inline as `data`, so it is handled before the url check.
  if (isXmlContentType(contentType)) {
    return <XmlDocumentPreview attachment={attachment} url={url} onOpen={onOpen} />;
  }

  if (!url) {
    return (
      <Flex justify="center" align="center" h={300}>
        <Text c="dimmed">No preview available for this document</Text>
      </Flex>
    );
  }

  const kind = getPreviewKind(contentType);

  // Word, Excel and TIFF are decoded in the page, so they need the bytes rather
  // than a URL. Everything else below renders straight from the URL.
  if (
    kind === 'docx' ||
    kind === 'spreadsheet' ||
    kind === 'tiff' ||
    kind === 'text' ||
    kind === 'csv' ||
    kind === 'download'
  ) {
    return <DecodedPreview kind={kind} url={url} contentType={contentType} onOpen={onOpen} />;
  }

  if (contentType?.startsWith('image/')) {
    return (
      <Box
        style={{ display: 'block', maxWidth: 'fit-content', position: 'relative', borderRadius: 4, overflow: 'hidden' }}
      >
        <img
          src={url}
          alt={attachment.title ?? 'Attachment'}
          style={{ width: 'auto', maxWidth: '100%', height: 'auto', display: 'block' }}
        />
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            border: PREVIEW_BORDER,
            borderRadius: 4,
            pointerEvents: 'none',
            boxSizing: 'border-box',
          }}
        />
      </Box>
    );
  }

  if (kind === 'video' || kind === 'audio') {
    return (
      <Box style={{ width: '100%', maxWidth: '100%', position: 'relative', borderRadius: 4, overflow: 'hidden' }}>
        <video style={{ width: '100%', maxWidth: '100%', height: 'auto', display: 'block' }} controls={true}>
          <source type={contentType} src={url} />
        </video>
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            border: PREVIEW_BORDER,
            borderRadius: 4,
            pointerEvents: 'none',
            boxSizing: 'border-box',
          }}
        />
      </Box>
    );
  }

  return <NoPreview onOpen={onOpen} message="No preview available for this file type" />;
}

function NoPreview({ onOpen, message }: { onOpen?: () => void; message: string }): JSX.Element {
  return (
    <Stack justify="center" align="center" gap="sm" h={300}>
      <Text c="dimmed" ta="center" maw={420}>
        {message}
      </Text>
      {onOpen && (
        <Button variant="default" size="xs" leftSection={<IconExternalLink size={14} />} onClick={onOpen}>
          Open file
        </Button>
      )}
    </Stack>
  );
}
