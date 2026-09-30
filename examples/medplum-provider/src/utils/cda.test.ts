// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import type { NarrativeNode } from './cda';
import { isXmlContentType, parseCda, parseHl7Date } from './cda';

const SAMPLE_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <code code="11506-3" displayName="Progress note"/>
  <title>Progress Notes</title>
  <effectiveTime value="20260915103000-0700"/>
  <recordTarget><patientRole><patient>
    <name><given>Sania</given><family>Aamir</family></name>
    <administrativeGenderCode code="F" displayName="Female"/>
    <birthTime value="19870817"/>
  </patient></patientRole></recordTarget>
  <author><assignedAuthor><assignedPerson><name><prefix>Dr.</prefix><given>Jason</given><family>Yip</family></name></assignedPerson></assignedAuthor></author>
  <custodian><assignedCustodian><representedCustodianOrganization><name>Garden Grove Clinic</name></representedCustodianOrganization></assignedCustodian></custodian>
  <component><structuredBody>
    <component><section>
      <code code="48765-2" displayName="Allergies"/>
      <title>Allergies</title>
      <text>
        <table>
          <thead><tr><th>Substance</th><th>Reaction</th></tr></thead>
          <tbody><tr><td>Penicillin</td><td><content styleCode="Bold">Hives</content></td></tr></tbody>
        </table>
      </text>
    </section></component>
    <component><section>
      <title>Assessment and Plan</title>
      <text>
        <paragraph>Fatty liver, stable.</paragraph>
        <list listType="ordered"><item>Repeat LFTs</item><item>Fibroscan in <content styleCode="Italics">6 months</content></item></list>
        Follow up<br/>as needed
      </text>
      <component><section><title>Diet</title><text>Low fat.</text></section></component>
    </section></component>
    <component><section nullFlavor="NI"><title>Immunizations</title><text>No Information</text></section></component>
    <component><section><title>Results</title><text/></section></component>
  </structuredBody></component>
</ClinicalDocument>`;

function textOf(nodes: NarrativeNode[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
          return n.text;
        case 'br':
          return '\n';
        case 'list':
          return n.items.map(textOf).join('|');
        case 'table':
          return [...n.head, ...n.body].map((row) => row.map(textOf).join(',')).join(';');
        default:
          return textOf(n.children);
      }
    })
    .join('');
}

describe('parseCda', () => {
  const doc = parseCda(SAMPLE_CCD);

  test('reads the header', () => {
    expect(doc?.title).toBe('Progress Notes');
    expect(doc?.date?.toISOString()).toBe('2026-09-15T17:30:00.000Z');
    expect(doc?.patient?.name).toBe('Sania Aamir');
    expect(doc?.patient?.gender).toBe('Female');
    expect(doc?.patient?.birthDate?.getFullYear()).toBe(1987);
    expect(doc?.authors).toEqual(['Dr. Jason Yip']);
    expect(doc?.custodian).toBe('Garden Grove Clinic');
  });

  test('keeps every section in order, with nested sections', () => {
    expect(doc?.sections.map((s) => s.title)).toEqual(['Allergies', 'Assessment and Plan', 'Immunizations', 'Results']);
    expect(doc?.sections[0].code).toBe('48765-2');
    expect(doc?.sections[1].subsections.map((s) => s.title)).toEqual(['Diet']);
  });

  test('parses tables, lists, paragraphs, emphasis and line breaks', () => {
    const allergies = doc?.sections[0].narrative ?? [];
    expect(allergies.find((n) => n.kind === 'table')).toMatchObject({ kind: 'table' });
    expect(textOf(allergies).trim()).toBe('Substance,Reaction;Penicillin,Hives');
    const bold = JSON.stringify(allergies);
    expect(bold).toContain('"bold":true');

    const plan = doc?.sections[1].narrative ?? [];
    expect(plan.find((n) => n.kind === 'list')).toMatchObject({ kind: 'list', ordered: true });
    expect(textOf(plan)).toContain('Repeat LFTs|Fibroscan in 6 months');
    expect(textOf(plan)).toMatch(/Follow up\nas needed/);
  });

  test('marks sections without information as empty', () => {
    expect(doc?.sections[2].empty).toBe(true); // nullFlavor
    expect(doc?.sections[3].empty).toBe(true); // empty <text/>
    expect(doc?.sections[1].empty).toBe(false);
  });

  test('drops elements it does not render, including script', () => {
    const xml = SAMPLE_CCD.replace('Fatty liver, stable.', 'Fatty liver<script>alert(1)</script>, stable.');
    const plan = parseCda(xml)?.sections[1].narrative ?? [];
    // Unknown elements keep their text but never become elements.
    expect(JSON.stringify(plan)).not.toContain('script');
  });

  test('rejects malformed XML and non-CDA XML', () => {
    expect(parseCda('<ClinicalDocument><unclosed>')).toBeUndefined();
    expect(parseCda('<note><to>x</to></note>')).toBeUndefined();
  });

  test('reads an unstructured document body as one section', () => {
    const xml =
      '<ClinicalDocument xmlns="urn:hl7-org:v3"><title>Scan</title><component><nonXMLBody><text>Plain words</text></nonXMLBody></component></ClinicalDocument>';
    expect(parseCda(xml)?.sections).toEqual([
      { title: 'Document', narrative: [{ kind: 'text', text: 'Plain words' }], empty: false, subsections: [] },
    ]);
  });
});

describe('parseHl7Date', () => {
  test('handles dates, times and offsets', () => {
    expect(parseHl7Date('20260915')?.getDate()).toBe(15);
    expect(parseHl7Date('202609151030+0000')?.toISOString()).toBe('2026-09-15T10:30:00.000Z');
    expect(parseHl7Date('bad')).toBeUndefined();
    expect(parseHl7Date(undefined)).toBeUndefined();
  });
});

describe('isXmlContentType', () => {
  test('recognises XML types only', () => {
    expect(isXmlContentType('application/xml')).toBe(true);
    expect(isXmlContentType('text/xml; charset=utf-8')).toBe(true);
    expect(isXmlContentType('application/hl7-cda+xml')).toBe(true);
    expect(isXmlContentType('application/pdf')).toBe(false);
    expect(isXmlContentType(undefined)).toBe(false);
  });
});
