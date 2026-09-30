// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Box, Checkbox, Group, Stack, Text } from '@mantine/core';
import type { JSX } from 'react';

/**
 * DrChrono's seven base scopes, each grantable read and/or write.
 *
 * Mirrors `DRCHRONO_SCOPE_CATALOGUE` in `bots/shared/drchrono-oauth.ts`. The
 * bot validates whatever is saved, so the two lists disagreeing produces a
 * refusal rather than a bad authorize request.
 */
const SCOPES: readonly { base: string; label: string; description: string }[] = [
  { base: 'user', label: 'User', description: 'Who the connected DrChrono account is. Needed to verify a connection.' },
  {
    base: 'calendar',
    label: 'Calendar',
    description:
      'Appointments. Without this DrChrono returns an empty list rather than an error, so imports silently contain no visits.',
  },
  { base: 'patients', label: 'Patients', description: 'Full demographics and the patient chart.' },
  {
    base: 'patients:summary',
    label: 'Patients (summary)',
    description: 'Name, date of birth and contact details only — no clinical content.',
  },
  { base: 'billing', label: 'Billing', description: 'Insurance, line items, payments and transactions.' },
  {
    base: 'clinical',
    label: 'Clinical',
    description: 'Allergies, medications, problems, procedures, vitals, clinical notes and documents.',
  },
  { base: 'labs', label: 'Labs', description: 'Lab orders, results and lab documents.' },
];

/** What a fresh connection requests when the clinic has not narrowed it. */
export const DEFAULT_DRCHRONO_SCOPES = [
  'patients:read',
  'patients:write',
  'clinical:read',
  'clinical:write',
  'calendar:read',
  'calendar:write',
  'billing:read',
  'billing:write',
  'labs:read',
  'labs:write',
  'user:read',
];

export interface DrChronoScopePickerProps {
  /** Currently selected scopes, space or comma separated. Empty means the default set. */
  readonly value: string;
  readonly onChange: (next: string) => void;
}

/**
 * Per-clinic DrChrono permission picker.
 *
 * Changing this only affects the NEXT authorization: an existing access token
 * keeps whatever scopes it was granted, so narrowing or widening requires
 * Reconnect. The note in the footer says so, because otherwise an operator
 * unticks a box, sees no change, and assumes it did not save.
 * @param props - Component props.
 * @param props.value - Currently selected scopes, space or comma separated.
 * @param props.onChange - Called with the updated space-separated selection.
 * @returns The scope picker.
 */
export function DrChronoScopePicker(props: DrChronoScopePickerProps): JSX.Element {
  const selected = new Set(
    props.value.trim() === '' ? DEFAULT_DRCHRONO_SCOPES : props.value.split(/[\s,]+/).filter(Boolean)
  );

  const toggle = (scope: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) {
      next.add(scope);
    } else {
      next.delete(scope);
    }
    // Ordered by the catalogue so the saved string is stable and diffable
    // rather than reflecting the order boxes happened to be clicked.
    const ordered = SCOPES.flatMap((s) => [`${s.base}:read`, `${s.base}:write`]).filter((s) => next.has(s));
    props.onChange(ordered.join(' '));
  };

  return (
    <Stack gap="xs">
      <Group gap="xs" align="center">
        <Text style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--mantine-color-gray-5)' }}>
          PERMISSIONS
        </Text>
        <Badge variant="light" color="gray" radius="sm" size="sm" style={{ fontWeight: 500 }}>
          {selected.size} of {SCOPES.length * 2}
        </Badge>
      </Group>

      <Stack gap={2}>
        {SCOPES.map((scope) => (
          <Box
            key={scope.base}
            px="sm"
            py={8}
            style={{
              border: '1px solid var(--mantine-color-gray-2)',
              borderRadius: 'var(--mantine-radius-md)',
              background: 'var(--mantine-color-gray-0)',
            }}
          >
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} c="gray.9">
                  {scope.label}
                </Text>
                <Text size="xs" c="gray.5" style={{ lineHeight: 1.5 }}>
                  {scope.description}
                </Text>
              </Box>
              <Group gap="md" wrap="nowrap" style={{ flexShrink: 0 }}>
                {(['read', 'write'] as const).map((access) => (
                  <Checkbox
                    key={access}
                    size="xs"
                    label={access}
                    checked={selected.has(`${scope.base}:${access}`)}
                    onChange={(e) => toggle(`${scope.base}:${access}`, e.target.checked)}
                  />
                ))}
              </Group>
            </Group>
          </Box>
        ))}
      </Stack>

      <Text size="xs" c="gray.5">
        Applies to the next authorization. An existing token keeps the scopes it was granted, so use Reconnect after
        changing these.
      </Text>
    </Stack>
  );
}
