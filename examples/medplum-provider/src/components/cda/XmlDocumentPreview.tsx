// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Code, Flex, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import type { Attachment } from '@medplum/fhirtypes';
import { IconExternalLink } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { useAttachmentText } from '../../hooks/useAttachmentText';
import { parseCda } from '../../utils/cda';
import { FILE_NOT_COPIED_MESSAGE } from '../../utils/open-attachment';
import { CdaDocumentView } from './CdaDocumentView';

export interface XmlDocumentPreviewProps {
  attachment: Attachment;
  /** URL to read the file from, e.g. a presigned URL; defaults to the attachment's own. */
  url?: string;
  onOpen: () => void;
}

/**
 * Previews an XML attachment: a C-CDA document as readable sections, anything else as XML source.
 * @param props - The attachment and how to open it.
 * @returns The preview.
 */
export function XmlDocumentPreview(props: XmlDocumentPreviewProps): JSX.Element {
  const { attachment, url, onOpen } = props;
  const { text, loading, error } = useAttachmentText(attachment, url);
  const cda = useMemo(() => (text ? parseCda(text) : undefined), [text]);

  if (loading) {
    return (
      <Flex justify="center" align="center" h={300}>
        <Loader size="sm" />
      </Flex>
    );
  }
  if (error || text === undefined) {
    return (
      <Stack justify="center" align="center" gap="sm" h={300}>
        <Text c="dimmed" ta="center" maw={420}>
          {error === 'unreachable'
            ? "This file's host doesn't allow it to be previewed here."
            : FILE_NOT_COPIED_MESSAGE}
        </Text>
        {error === 'unreachable' && (
          <Button variant="default" size="xs" leftSection={<IconExternalLink size={14} />} onClick={onOpen}>
            Open file
          </Button>
        )}
      </Stack>
    );
  }
  if (cda) {
    return <CdaDocumentView document={cda} />;
  }
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        This XML file is not a C-CDA clinical document, so it is shown as is.
      </Text>
      <ScrollArea.Autosize mah={600}>
        <Code block>{text}</Code>
      </ScrollArea.Autosize>
    </Stack>
  );
}
