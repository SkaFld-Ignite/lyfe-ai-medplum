// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading HL7 C-CDA documents (CCDs, progress notes, referrals) for display.
 *
 * What a clinician must see is each section's narrative `<text>` block: C-CDA
 * defines it as the human-readable, attested content, while the coded `<entry>`
 * elements are for machines. So sections are rendered from their narrative,
 * faithfully (tables, lists, paragraphs, emphasis), rather than reduced to a
 * summary. The narrative is converted to a small tree of known node kinds and
 * rendered as React elements; nothing from the document is ever injected as
 * HTML, so a hostile document cannot run script.
 */

export type NarrativeNode =
  | { kind: 'text'; text: string }
  | { kind: 'br' }
  | { kind: 'paragraph'; children: NarrativeNode[] }
  | { kind: 'content'; children: NarrativeNode[]; bold?: boolean; italic?: boolean; underline?: boolean }
  | { kind: 'list'; ordered: boolean; caption?: NarrativeNode[]; items: NarrativeNode[][] }
  | { kind: 'table'; caption?: NarrativeNode[]; head: NarrativeNode[][][]; body: NarrativeNode[][][] };

export interface CdaSection {
  title: string;
  /** LOINC section code, e.g. 48765-2 for allergies. */
  code?: string;
  narrative: NarrativeNode[];
  /** True when the section says it has no information (nullFlavor or empty narrative). */
  empty: boolean;
  subsections: CdaSection[];
}

export interface CdaDocument {
  title: string;
  date?: Date;
  patient?: { name?: string; gender?: string; birthDate?: Date };
  authors: string[];
  custodian?: string;
  sections: CdaSection[];
}

function children(el: Element | null | undefined, name: string): Element[] {
  return el ? Array.from(el.children).filter((c) => c.localName === name) : [];
}

function child(el: Element | null | undefined, name: string): Element | undefined {
  return children(el, name)[0];
}

function path(el: Element | null | undefined, ...names: string[]): Element | undefined {
  let current = el ?? undefined;
  for (const name of names) {
    current = child(current, name);
  }
  return current;
}

function clean(text: string | null | undefined): string | undefined {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value || undefined;
}

/**
 * Parses an HL7 v3 timestamp such as `20260915`, `202609151030` or `20260915103000-0700`.
 * @param value - The HL7 TS value.
 * @returns The date, or undefined when missing or malformed.
 */
export function parseHl7Date(value: string | null | undefined): Date | undefined {
  const match = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(value?.trim() ?? '');
  if (!match) {
    return undefined;
  }
  const [, y, mo = '01', d = '01', h, mi = '00', s = '00', tz] = match;
  if (!h) {
    // A date without a time is a calendar day, not midnight UTC.
    return new Date(Number(y), Number(mo) - 1, Number(d));
  }
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '';
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function personName(nameEl: Element | undefined): string | undefined {
  if (!nameEl) {
    return undefined;
  }
  const parts = ['prefix', 'given', 'family', 'suffix'].flatMap((part) =>
    children(nameEl, part).map((p) => clean(p.textContent))
  );
  return clean(parts.filter(Boolean).join(' ')) ?? clean(nameEl.textContent);
}

function styleFlags(el: Element): { bold?: boolean; italic?: boolean; underline?: boolean } {
  const codes = (el.getAttribute('styleCode') ?? '').split(/\s+/);
  return {
    bold: codes.includes('Bold') || undefined,
    italic: codes.includes('Italics') || undefined,
    underline: codes.includes('Underline') || undefined,
  };
}

function parseRows(el: Element | undefined): NarrativeNode[][][] {
  return children(el, 'tr').map((tr) =>
    Array.from(tr.children)
      .filter((cell) => cell.localName === 'td' || cell.localName === 'th')
      .map((cell) => parseNarrative(cell))
  );
}

function parseNode(node: Node): NarrativeNode[] {
  if (node.nodeType === 3 /* TEXT_NODE */ || node.nodeType === 4 /* CDATA_SECTION_NODE */) {
    // Whitespace collapses to a single space, which still separates the words around it.
    const text = (node.textContent ?? '').replace(/\s+/g, ' ');
    return text ? [{ kind: 'text', text }] : [];
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) {
    return [];
  }
  const el = node as Element;
  switch (el.localName) {
    case 'br':
      return [{ kind: 'br' }];
    case 'paragraph':
      return [{ kind: 'paragraph', children: parseNarrative(el) }];
    case 'content':
    case 'linkHtml':
    case 'sub':
    case 'sup':
      return [{ kind: 'content', children: parseNarrative(el), ...styleFlags(el) }];
    case 'list': {
      const caption = child(el, 'caption');
      return [
        {
          kind: 'list',
          ordered: el.getAttribute('listType') === 'ordered',
          caption: caption ? parseNarrative(caption) : undefined,
          items: children(el, 'item').map((item) => parseNarrative(item)),
        },
      ];
    }
    case 'table': {
      const caption = child(el, 'caption');
      const head = children(el, 'thead').flatMap((thead) => parseRows(thead));
      const body = [
        ...children(el, 'tbody').flatMap((tbody) => parseRows(tbody)),
        ...parseRows(el), // rows placed directly under <table>
        ...children(el, 'tfoot').flatMap((tfoot) => parseRows(tfoot)),
      ];
      return [{ kind: 'table', caption: caption ? parseNarrative(caption) : undefined, head, body }];
    }
    case 'caption':
    case 'footnote':
    case 'footnoteRef':
    case 'renderMultiMedia':
      return [];
    default:
      // Unknown or wrapper elements: keep their content, drop the element.
      return parseNarrative(el);
  }
}

/**
 * Converts a CDA narrative element into display nodes.
 * @param el - A `<text>` element or any element inside it.
 * @returns The display nodes.
 */
export function parseNarrative(el: Element): NarrativeNode[] {
  return Array.from(el.childNodes).flatMap(parseNode);
}

function hasContent(nodes: NarrativeNode[]): boolean {
  return nodes.some((node) => {
    switch (node.kind) {
      case 'text':
        return node.text.trim() !== '';
      case 'br':
        return false;
      case 'list':
        return node.items.some(hasContent);
      case 'table':
        return node.body.length > 0 || node.head.length > 0;
      default:
        return hasContent(node.children);
    }
  });
}

function parseSection(sectionEl: Element): CdaSection {
  const codeEl = child(sectionEl, 'code');
  const textEl = child(sectionEl, 'text');
  const narrative = textEl ? parseNarrative(textEl) : [];
  const subsections = children(sectionEl, 'component')
    .map((component) => child(component, 'section'))
    .filter((s): s is Element => Boolean(s))
    .map(parseSection);
  return {
    title:
      clean(child(sectionEl, 'title')?.textContent) ?? clean(codeEl?.getAttribute('displayName')) ?? 'Untitled section',
    code: codeEl?.getAttribute('code') ?? undefined,
    narrative,
    empty: Boolean(sectionEl.getAttribute('nullFlavor')) || (!hasContent(narrative) && subsections.length === 0),
    subsections,
  };
}

/**
 * Parses a C-CDA XML document for display.
 * @param xml - The document XML.
 * @returns The document, or undefined when the XML is malformed or is not a CDA `ClinicalDocument`.
 */
export function parseCda(xml: string): CdaDocument | undefined {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (root?.localName !== 'ClinicalDocument' || doc.getElementsByTagName('parsererror').length > 0) {
    return undefined;
  }

  const patientEl = path(root, 'recordTarget', 'patientRole', 'patient');
  const genderEl = child(patientEl, 'administrativeGenderCode');
  const authors = children(root, 'author')
    .map((author) => {
      const assigned = child(author, 'assignedAuthor');
      return (
        personName(path(assigned, 'assignedPerson', 'name')) ??
        clean(path(assigned, 'assignedAuthoringDevice', 'softwareName')?.textContent) ??
        clean(path(assigned, 'representedOrganization', 'name')?.textContent)
      );
    })
    .filter((a): a is string => Boolean(a));

  const body = path(root, 'component', 'structuredBody');
  const sections = children(body, 'component')
    .map((component) => child(component, 'section'))
    .filter((s): s is Element => Boolean(s))
    .map(parseSection);

  // An unstructured body carries its content as a single nonXMLBody/text; show it as one section.
  const nonXml = path(root, 'component', 'nonXMLBody', 'text');
  if (sections.length === 0 && nonXml && !nonXml.getAttribute('representation')) {
    const narrative = parseNarrative(nonXml);
    sections.push({ title: 'Document', narrative, empty: !hasContent(narrative), subsections: [] });
  }

  return {
    title:
      clean(child(root, 'title')?.textContent) ??
      clean(child(root, 'code')?.getAttribute('displayName')) ??
      'Clinical document',
    date: parseHl7Date(child(root, 'effectiveTime')?.getAttribute('value')),
    patient: patientEl
      ? {
          name: personName(child(patientEl, 'name')),
          gender: genderEl?.getAttribute('displayName') ?? genderEl?.getAttribute('code') ?? undefined,
          birthDate: parseHl7Date(child(patientEl, 'birthTime')?.getAttribute('value')),
        }
      : undefined,
    authors: [...new Set(authors)],
    custodian: clean(
      path(root, 'custodian', 'assignedCustodian', 'representedCustodianOrganization', 'name')?.textContent
    ),
    sections,
  };
}

/**
 * Whether a content type is XML that may hold a CDA document.
 * @param contentType - The attachment content type.
 * @returns True for XML types.
 */
export function isXmlContentType(contentType: string | undefined): boolean {
  return Boolean(contentType && /(^|\/|\+)xml$/.test(contentType.split(';')[0].trim()));
}
