// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Box, Button, Divider, Flex, Group, Loader, Paper, Stack, Text, Tooltip } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { formatDate, getDisplayString, getReferenceString } from '@medplum/core';
import type { Attachment, DocumentReference, Patient, Reference } from '@medplum/fhirtypes';
import { useCachedBinaryUrl, useMedplum } from '@medplum/react-hooks';
import { IconBrowserShare, IconEditCircle, IconExternalLink, IconPrinter } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { XmlDocumentPreview } from '../../components/cda/XmlDocumentPreview';
import { SendFaxModal } from '../../components/fax/SendFaxModal';
import {
  DocxPreview,
  DownloadOnlyPreview,
  SpreadsheetPreview,
  TiffPreview,
} from '../../components/patient-documents/RichFilePreview';
import { useAttachmentBlob } from '../../hooks/useAttachmentBlob';
import { useAttachmentPreviewUrl } from '../../hooks/useAttachmentPreviewUrl';
import { isXmlContentType } from '../../utils/cda';
import { getAttachmentContentType } from '../../utils/document-file-type';
import { showErrorNotification } from '../../utils/notifications';
import { FILE_NOT_COPIED_MESSAGE, openAttachment } from '../../utils/open-attachment';
import type { PreviewKind } from '../../utils/preview-kind';
import { getPreviewKind } from '../../utils/preview-kind';
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
}

export function DocumentDetailPanel({
  item,
  patientRef,
  onDocumentChange,
  onDocumentDeleted,
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

  return (
    <>
      <Box h="100%" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <Paper h="100%">
          <Flex direction="column" h="100%">
            <Box p="md">
              <Group justify="space-between" align="center">
                <Stack gap={4} style={{ flex: 1 }}>
                  <Text fw={700} size="lg">
                    {name === referenceString ? 'Untitled Document' : name}
                  </Text>
                </Stack>

                <Group gap="xs">
                  <Tooltip label="Edit Document Details" position="bottom" openDelay={500}>
                    <ActionIcon
                      variant="transparent"
                      radius="xl"
                      size={32}
                      className="outline-icon-button"
                      onClick={() => setEditModalOpened(true)}
                    >
                      <IconEditCircle size={16} />
                    </ActionIcon>
                  </Tooltip>
                  {attachment?.url && (
                    <Tooltip label="Open in Browser" position="bottom" openDelay={500}>
                      <ActionIcon
                        variant="transparent"
                        radius="xl"
                        size={32}
                        className="outline-icon-button"
                        onClick={handleOpenInBrowser}
                      >
                        <IconBrowserShare size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Tooltip label="Fax Document" position="bottom" openDelay={500}>
                    <ActionIcon
                      variant="transparent"
                      radius="xl"
                      size={32}
                      className="outline-icon-button"
                      onClick={() => setFaxModalOpened(true)}
                    >
                      <IconPrinter size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </Box>

            <Divider />

            {framed ? (
              <>
                <Box p="md" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
                    <Box
                      style={{
                        flex: 1,
                        borderRadius: 4,
                        overflow: 'hidden',
                        border: PREVIEW_BORDER,
                      }}
                    >
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
                </Box>

                <Box px="md">
                  <Divider />
                </Box>

                <Box p="md">
                  <DocumentMetadata item={item} contentType={storedAttachment?.contentType} />
                </Box>
              </>
            ) : (
              <Box style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                <Box p="md">
                  {attachment ? (
                    <AttachmentPreview attachment={attachment} url={attachmentUrl} onOpen={handleOpenInBrowser} />
                  ) : (
                    <Flex justify="center" align="center" h={300}>
                      <Text c="dimmed">No preview available for this document</Text>
                    </Flex>
                  )}
                </Box>

                <Box px="md">
                  <Divider />
                </Box>

                <Box p="md">
                  <DocumentMetadata item={item} contentType={storedAttachment?.contentType} />
                </Box>
              </Box>
            )}
          </Flex>
        </Paper>
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
  return <TiffPreview blob={blob} onDownload={props.onOpen} />;
}

function isPdfLike(attachment: Attachment | undefined): boolean {
  const ct = attachment?.contentType;
  if (!ct) {
    return false;
  }
  // XML (e.g. C-CDA) is rendered as a readable document rather than framed as source.
  return ct === 'application/pdf' || ct === 'application/json' || (ct.startsWith('text/') && !isXmlContentType(ct));
}

function getAuthor(doc: DocumentReference): string | undefined {
  const author = doc.author?.[0];
  return author?.display ?? author?.reference;
}

function DocumentMetadata({
  item,
  contentType,
}: {
  item: WithId<DocumentReference>;
  contentType: string | undefined;
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
    <Stack gap="sm">
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
      {date && <MetadataRow label="Added" value={formatDate(date)} />}
      {lastUpdated && (
        <MetadataRow
          label="Last updated"
          value={
            <>
              {formatDate(lastUpdated)}
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
    <Group align="flex-start" gap="lg" wrap="nowrap">
      <Text fw={500} size="sm" c="dimmed" style={{ width: '150px', flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" component="div" style={{ flex: 1, minWidth: 0 }}>
        {value}
      </Text>
    </Group>
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
  if (kind === 'docx' || kind === 'spreadsheet' || kind === 'tiff' || kind === 'download') {
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

  if (contentType?.startsWith('video/')) {
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
