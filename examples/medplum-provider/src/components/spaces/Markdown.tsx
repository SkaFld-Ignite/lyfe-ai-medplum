// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Code, List, Table, Text, Title } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Rewrites the text leaves of a markdown node's children. Used to turn the assistant's
 * inline `[doc:S1]` / `[meds]` citation tokens into clickable pills without standing up a
 * second markdown renderer — see `../lyfe-ai/CitedMarkdown`.
 */
export type MarkdownTransform = (children: ReactNode) => ReactNode;

interface MarkdownProps {
  children: string;
  /** Applied to the children of every node that can hold inline prose. Defaults to identity. */
  transform?: MarkdownTransform;
}

const identity: MarkdownTransform = (children) => children;

function buildComponents(transform: MarkdownTransform): Components {
  return {
    p: ({ children }) => (
      <Text component="p" m={0} style={{ lineHeight: 1.6 }}>
        {transform(children)}
      </Text>
    ),
    a: ({ href, children }) => (
      <Anchor href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </Anchor>
    ),
    strong: ({ children }) => (
      <Text component="span" fw={700}>
        {transform(children)}
      </Text>
    ),
    em: ({ children }) => (
      <Text component="span" fs="italic">
        {transform(children)}
      </Text>
    ),
    code: ({ className, children }) => {
      const isBlock = (className ?? '').includes('language-');
      if (isBlock) {
        return (
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {children}
          </Code>
        );
      }
      return <Code style={{ fontSize: '0.9em' }}>{children}</Code>;
    },
    ul: ({ children }) => (
      <List size="sm" spacing={4} withPadding>
        {children}
      </List>
    ),
    ol: ({ children }) => (
      <List type="ordered" size="sm" spacing={4} withPadding>
        {children}
      </List>
    ),
    li: ({ children }) => <List.Item>{transform(children)}</List.Item>,
    h1: ({ children }) => (
      <Title order={3} mt="xs" mb={4}>
        {children}
      </Title>
    ),
    h2: ({ children }) => (
      <Title order={4} mt="xs" mb={4}>
        {children}
      </Title>
    ),
    h3: ({ children }) => (
      <Title order={5} mt="xs" mb={4}>
        {children}
      </Title>
    ),
    h4: ({ children }) => (
      <Title order={6} mt="xs" mb={4}>
        {children}
      </Title>
    ),
    table: ({ children }) => (
      <Table withTableBorder withColumnBorders mt="xs">
        {children}
      </Table>
    ),
    thead: ({ children }) => <Table.Thead>{children}</Table.Thead>,
    tbody: ({ children }) => <Table.Tbody>{children}</Table.Tbody>,
    tr: ({ children }) => <Table.Tr>{children}</Table.Tr>,
    th: ({ children }) => <Table.Th>{children}</Table.Th>,
    td: ({ children }) => <Table.Td>{transform(children)}</Table.Td>,
  };
}

const defaultComponents = buildComponents(identity);

export function Markdown({ children, transform }: MarkdownProps): JSX.Element {
  const components = useMemo(() => (transform ? buildComponents(transform) : defaultComponents), [transform]);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
