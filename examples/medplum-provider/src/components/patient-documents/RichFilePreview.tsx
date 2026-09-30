// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Box, Button, Flex, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconFileUnknown } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { getDownloadReason } from '../../utils/preview-kind';

/**
 * Previews for the file types a browser will not render on its own.
 *
 * Each decoder is loaded on demand rather than imported at module scope. A
 * clinician opening a PDF should not pay for the Word and Excel parsers, and
 * most charts contain no Office files at all — so these arrive only when a
 * document that needs them is actually opened.
 */

/** What every preview here is handed. */
export interface RichFilePreviewProps {
  /** The file's bytes, already downloaded and authorised. */
  blob: Blob;
  /** The file's resolved content type. */
  contentType?: string;
  /** Saves the original file, unchanged. */
  onDownload: () => void;
}

/** Height of the scrollable preview body, matching the framed PDF preview. */
const PREVIEW_MIN_HEIGHT = 320;

/**
 * A file we will not pretend to render, offered for download with a reason.
 * @param props - The preview inputs.
 * @param props.contentType - The file's content type.
 * @param props.onDownload - Saves the file.
 * @returns The download card.
 */
export function DownloadOnlyPreview(props: { contentType?: string; onDownload: () => void }): JSX.Element {
  return (
    <Flex direction="column" align="center" justify="center" gap="md" mih={PREVIEW_MIN_HEIGHT} p="xl">
      <IconFileUnknown size={40} opacity={0.4} />
      <Text size="sm" c="dimmed" ta="center" maw={420}>
        {getDownloadReason(props.contentType)}
      </Text>
      <Button leftSection={<IconDownload size={16} />} variant="light" onClick={props.onDownload}>
        Download file
      </Button>
    </Flex>
  );
}

/**
 * Shown while a decoder and its file are being worked through.
 * @returns The spinner.
 */
function Working(): JSX.Element {
  return (
    <Flex align="center" justify="center" mih={PREVIEW_MIN_HEIGHT}>
      <Loader size="sm" />
    </Flex>
  );
}

/**
 * A decoder failed. The file itself is still offered — a preview that cannot
 * render is an inconvenience, but hiding the file would lose access to it.
 * @param props - The failure inputs.
 * @param props.message - What went wrong, in one line.
 * @param props.onDownload - Saves the file.
 * @returns The failure card.
 */
function PreviewFailed(props: { message: string; onDownload: () => void }): JSX.Element {
  return (
    <Stack gap="sm" p="md">
      <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
        {props.message}
      </Alert>
      <Group justify="center">
        <Button leftSection={<IconDownload size={16} />} variant="light" onClick={props.onDownload}>
          Download file
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * A Word document, converted to HTML.
 *
 * Mammoth maps Word's semantics — headings, lists, tables, emphasis — onto HTML
 * rather than trying to reproduce the page. Margins, fonts and page breaks are
 * lost; the clinical content is not, which is the trade worth making for a
 * preview.
 * @param props - The preview inputs.
 * @param props.blob - The file.
 * @param props.onDownload - Saves the original.
 * @returns The rendered document.
 */
export function DocxPreview(props: { blob: Blob; onDownload: () => void }): JSX.Element {
  const [state, setState] = useState<{ html?: string; error?: string }>({});

  useEffect(() => {
    let active = true;
    (async () => {
      const mammoth = await import('mammoth/mammoth.browser.js');
      const buffer = await props.blob.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
      if (active) {
        setState({ html: result.value });
      }
    })().catch(() => {
      if (active) {
        setState({ error: 'This Word file could not be read. It may use features the preview does not support.' });
      }
    });
    return () => {
      active = false;
    };
  }, [props.blob]);

  if (state.error) {
    return <PreviewFailed message={state.error} onDownload={props.onDownload} />;
  }
  if (state.html === undefined) {
    return <Working />;
  }
  return (
    <Box
      p="md"
      mih={PREVIEW_MIN_HEIGHT}
      className="docx-preview"
      // Mammoth emits a closed set of semantic tags from the document's own
      // structure; it does not carry script or style through from the file.
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  );
}

/** One worksheet reduced to the rectangle that actually holds values. */
interface SheetData {
  name: string;
  rows: string[][];
}

/** Cap on rendered rows per sheet, so a 50,000-row export cannot lock the tab. */
const MAX_SHEET_ROWS = 500;

/**
 * A spreadsheet, rendered as tables.
 *
 * ExcelJS rather than SheetJS: the npm build of SheetJS is abandoned at 0.18.5
 * and carries two unfixed high-severity advisories (prototype pollution and
 * ReDoS). These files arrive from an external network and are parsed in a
 * clinician's browser, which is precisely where that risk is not worth an
 * inline preview.
 * @param props - The preview inputs.
 * @param props.blob - The file.
 * @param props.onDownload - Saves the original.
 * @returns The rendered sheets.
 */
export function SpreadsheetPreview(props: { blob: Blob; onDownload: () => void }): JSX.Element {
  const [state, setState] = useState<{ sheets?: SheetData[]; error?: string }>({});

  useEffect(() => {
    let active = true;
    (async () => {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await props.blob.arrayBuffer());
      const sheets: SheetData[] = [];
      workbook.eachSheet((worksheet) => {
        const rows: string[][] = [];
        worksheet.eachRow({ includeEmpty: false }, (row, index) => {
          if (index > MAX_SHEET_ROWS) {
            return;
          }
          const values = Array.isArray(row.values) ? row.values.slice(1) : [];
          rows.push(values.map((v) => cellText(v)));
        });
        sheets.push({ name: worksheet.name, rows });
      });
      if (active) {
        setState({ sheets });
      }
    })().catch(() => {
      if (active) {
        setState({ error: 'This spreadsheet could not be read. It may be an older .xls file or password protected.' });
      }
    });
    return () => {
      active = false;
    };
  }, [props.blob]);

  if (state.error) {
    return <PreviewFailed message={state.error} onDownload={props.onDownload} />;
  }
  if (!state.sheets) {
    return <Working />;
  }
  if (state.sheets.every((s) => s.rows.length === 0)) {
    return <PreviewFailed message="This spreadsheet has no readable content." onDownload={props.onDownload} />;
  }

  return (
    <Stack gap="lg" p="md" mih={PREVIEW_MIN_HEIGHT}>
      {state.sheets.map((sheet) => (
        <Stack key={sheet.name} gap="xs">
          {state.sheets && state.sheets.length > 1 && (
            <Text fw={600} size="sm">
              {sheet.name}
            </Text>
          )}
          <Box style={{ overflowX: 'auto' }}>
            <Table striped withTableBorder withColumnBorders fz="xs">
              <Table.Tbody>
                {sheet.rows.map((row, r) => (
                  <Table.Tr key={r}>
                    {row.map((cell, c) => (
                      <Table.Td key={c}>{cell}</Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
          {sheet.rows.length >= MAX_SHEET_ROWS && (
            <Text size="xs" c="dimmed">
              Showing the first {MAX_SHEET_ROWS} rows. Download the file for the rest.
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * Flatten one ExcelJS cell value to display text.
 *
 * A cell can hold a formula result, a rich-text run list, a hyperlink or an
 * error as well as a primitive, and `String(value)` on those yields
 * "[object Object]".
 * @param value - The cell value.
 * @returns Display text.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toLocaleDateString();
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') {
      return v.text;
    }
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if (v.result !== undefined) {
      return cellText(v.result);
    }
    if (typeof v.error === 'string') {
      return v.error;
    }
    return '';
  }
  // Only primitives reach here: objects are handled above, so this cannot
  // produce "[object Object]".
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/** Cap on TIFF pages drawn, so a long fax cannot lock the tab. */
const MAX_TIFF_PAGES = 20;

/**
 * A TIFF, decoded in the page and drawn to a canvas.
 *
 * No browser decodes TIFF, but fax gateways and imaging systems emit it
 * constantly, so these turn up in real charts — two of them in the first pilot
 * patient's record. Multi-page TIFFs are what fax produces, so every page is
 * drawn rather than just the first.
 *
 * The canvases are created imperatively into a plain `div` rather than rendered
 * as JSX. A decoded page is raw pixel data, and putImageData needs the real
 * canvas element; the container is a plain `div` on purpose, because a
 * component that does not forward its ref leaves this silently drawing into
 * nothing.
 * @param props - The preview inputs.
 * @param props.blob - The file.
 * @param props.onDownload - Saves the original.
 * @returns The rendered pages.
 */
export function TiffPreview(props: { blob: Blob; onDownload: () => void }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ pages?: number; error?: string }>({});

  useEffect(() => {
    let active = true;
    (async () => {
      const UTIF = (await import('utif')).default;
      const bytes = new Uint8Array(await props.blob.arrayBuffer());
      const ifds = UTIF.decode(bytes);
      if (!active) {
        return;
      }
      if (ifds.length === 0) {
        setState({ error: 'This TIFF has no readable pages.' });
        return;
      }
      const host = containerRef.current;
      if (!host) {
        setState({ error: 'The preview could not be drawn. Download the file to open it.' });
        return;
      }

      host.replaceChildren();
      let drawn = 0;
      for (const ifd of ifds.slice(0, MAX_TIFF_PAGES)) {
        UTIF.decodeImage(bytes, ifd);
        const rgba = UTIF.toRGBA8(ifd);
        if (rgba.length === 0 || !ifd.width || !ifd.height) {
          continue;
        }
        const canvas = document.createElement('canvas');
        canvas.width = ifd.width;
        canvas.height = ifd.height;
        canvas.style.maxWidth = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.marginBottom = '12px';
        const context = canvas.getContext('2d');
        context?.putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0);
        host.appendChild(canvas);
        drawn++;
      }
      if (!active) {
        return;
      }
      setState(drawn > 0 ? { pages: ifds.length } : { error: 'This TIFF has no readable pages.' });
    })().catch(() => {
      if (active) {
        setState({ error: 'This TIFF could not be decoded. It may use an uncommon compression.' });
      }
    });
    return () => {
      active = false;
    };
  }, [props.blob]);

  return (
    <Stack gap="xs" p="md" mih={PREVIEW_MIN_HEIGHT}>
      {state.error ? (
        <PreviewFailed message={state.error} onDownload={props.onDownload} />
      ) : (
        <>
          {state.pages === undefined && <Working />}
          <div ref={containerRef} />
          {state.pages !== undefined && state.pages > 1 && (
            <Text size="xs" c="dimmed">
              {state.pages > MAX_TIFF_PAGES
                ? `Showing the first ${MAX_TIFF_PAGES} of ${state.pages} pages. Download the file for the rest.`
                : `${state.pages} pages`}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

/** Cap on characters rendered from a text file, so a huge export cannot lock the tab. */
const MAX_TEXT_CHARS = 200_000;

/**
 * A text file, drawn as text.
 *
 * Deliberately not an iframe. Chrome *downloads* a `text/plain` or `text/csv`
 * iframe rather than displaying it, so the framed path renders an empty panel
 * with no error at all — which is what an HL7 result and a CSV both did.
 * @param props - The preview inputs.
 * @param props.blob - The file.
 * @param props.onDownload - Saves the original.
 * @returns The rendered text.
 */
export function TextPreview(props: { blob: Blob; onDownload: () => void }): JSX.Element {
  const [text, setText] = useState<string>();

  useEffect(() => {
    let active = true;
    props.blob
      .text()
      .then((value) => {
        if (active) {
          setText(value.slice(0, MAX_TEXT_CHARS));
        }
        return value;
      })
      .catch(() => {
        if (active) {
          setText('');
        }
      });
    return () => {
      active = false;
    };
  }, [props.blob]);

  if (text === undefined) {
    return <Working />;
  }
  if (text === '') {
    return <PreviewFailed message="This file is empty." onDownload={props.onDownload} />;
  }
  return (
    <Box p="md" mih={PREVIEW_MIN_HEIGHT}>
      <Text
        component="pre"
        fz="xs"
        ff="monospace"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}
      >
        {text}
      </Text>
    </Box>
  );
}

/**
 * Split one line of CSV into fields.
 *
 * Quoted fields can contain commas, newlines and escaped quotes, so splitting
 * on `,` mangles any real export. This handles quoting; embedded newlines are
 * the one case it does not, which would need a streaming parser for a preview
 * that does not warrant one.
 * @param line - One line of CSV.
 * @returns The fields.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Cap on CSV rows rendered. */
const MAX_CSV_ROWS = 500;

/**
 * A CSV, drawn as the table it is.
 * @param props - The preview inputs.
 * @param props.blob - The file.
 * @param props.onDownload - Saves the original.
 * @returns The rendered table.
 */
export function CsvPreview(props: { blob: Blob; onDownload: () => void }): JSX.Element {
  const [rows, setRows] = useState<string[][]>();

  useEffect(() => {
    let active = true;
    props.blob
      .text()
      .then((value) => {
        const lines = value.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (active) {
          setRows(lines.slice(0, MAX_CSV_ROWS).map(splitCsvLine));
        }
        return value;
      })
      .catch(() => {
        if (active) {
          setRows([]);
        }
      });
    return () => {
      active = false;
    };
  }, [props.blob]);

  if (rows === undefined) {
    return <Working />;
  }
  if (rows.length === 0) {
    return <PreviewFailed message="This file has no readable rows." onDownload={props.onDownload} />;
  }

  const [header, ...body] = rows;
  return (
    <Box p="md" mih={PREVIEW_MIN_HEIGHT} style={{ overflowX: 'auto' }}>
      <Table striped withTableBorder withColumnBorders fz="xs">
        <Table.Thead>
          <Table.Tr>
            {header.map((cell, i) => (
              <Table.Th key={i}>{cell}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {body.map((row, r) => (
            <Table.Tr key={r}>
              {row.map((cell, c) => (
                <Table.Td key={c}>{cell}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}
