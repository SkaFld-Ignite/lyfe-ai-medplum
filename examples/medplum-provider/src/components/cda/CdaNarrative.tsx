// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { List, Table, Text } from '@mantine/core';
import type { JSX } from 'react';
import type { NarrativeNode } from '../../utils/cda';
import classes from './CdaDocumentView.module.css';

function Inline({ nodes }: { nodes: NarrativeNode[] }): JSX.Element {
  return (
    <>
      {nodes.map((node, i) => (
        <NarrativeItem key={i} node={node} />
      ))}
    </>
  );
}

function NarrativeItem({ node }: { node: NarrativeNode }): JSX.Element | null {
  switch (node.kind) {
    case 'text':
      return <>{node.text}</>;
    case 'br':
      return <br />;
    case 'paragraph':
      return (
        <Text size="sm" className={classes.paragraph}>
          <Inline nodes={node.children} />
        </Text>
      );
    case 'content':
      return (
        <Text
          span
          inherit
          fw={node.bold ? 600 : undefined}
          fs={node.italic ? 'italic' : undefined}
          td={node.underline ? 'underline' : undefined}
        >
          <Inline nodes={node.children} />
        </Text>
      );
    case 'list':
      return (
        <div className={classes.block}>
          {node.caption && (
            <Text size="sm" fw={600} mb={4}>
              <Inline nodes={node.caption} />
            </Text>
          )}
          <List type={node.ordered ? 'ordered' : 'unordered'} size="sm" spacing={2}>
            {node.items.map((item, i) => (
              <List.Item key={i}>
                <Inline nodes={item} />
              </List.Item>
            ))}
          </List>
        </div>
      );
    case 'table':
      return (
        <div className={classes.block}>
          {node.caption && (
            <Text size="sm" fw={600} mb={4}>
              <Inline nodes={node.caption} />
            </Text>
          )}
          <Table.ScrollContainer minWidth={480}>
            <Table striped withTableBorder withColumnBorders fz="sm" verticalSpacing={6}>
              {node.head.length > 0 && (
                <Table.Thead>
                  {node.head.map((row, r) => (
                    <Table.Tr key={r}>
                      {row.map((cell, c) => (
                        <Table.Th key={c}>
                          <Inline nodes={cell} />
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Thead>
              )}
              <Table.Tbody>
                {node.body.map((row, r) => (
                  <Table.Tr key={r}>
                    {row.map((cell, c) => (
                      <Table.Td key={c}>
                        <Inline nodes={cell} />
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </div>
      );
    default:
      return null;
  }
}

/**
 * Renders a CDA section narrative. Loose text and inline content between block elements are
 * grouped into paragraphs.
 * @param props - The narrative nodes.
 * @param props.nodes - Parsed narrative.
 * @returns The narrative.
 */
export function CdaNarrative({ nodes }: { nodes: NarrativeNode[] }): JSX.Element {
  const blocks: JSX.Element[] = [];
  let inline: NarrativeNode[] = [];
  const flush = (): void => {
    if (inline.some((n) => n.kind !== 'br' && !(n.kind === 'text' && !n.text.trim()))) {
      blocks.push(
        <Text key={`t${blocks.length}`} size="sm" className={classes.paragraph}>
          <Inline nodes={inline} />
        </Text>
      );
    }
    inline = [];
  };
  for (const node of nodes) {
    if (node.kind === 'paragraph' || node.kind === 'list' || node.kind === 'table') {
      flush();
      blocks.push(<NarrativeItem key={`b${blocks.length}`} node={node} />);
    } else {
      inline.push(node);
    }
  }
  flush();
  return <>{blocks}</>;
}
