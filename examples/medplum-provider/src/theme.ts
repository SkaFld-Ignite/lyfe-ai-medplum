// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColorsTuple } from '@mantine/core';
import { createTheme } from '@mantine/core';

// Mantine colour tuples are ten shades running light to dark, which maps one to
// one onto the Tailwind scale the Lyfe platform is built from. Each entry below
// is the Tailwind value at the same position, so the palettes stay identical
// without either side having to translate.

// Lyfe's accent, Tailwind `blue`. Shade 6 (#2563eb) is what the platform uses
// for the active nav item and the logo tile.
const primary: MantineColorsTuple = [
  '#eff6ff',
  '#dbeafe',
  '#bfdbfe',
  '#93c5fd',
  '#60a5fa',
  '#3b82f6',
  '#2563eb',
  '#1d4ed8',
  '#1e40af',
  '#1e3a8a',
];

// Lyfe's neutral, Tailwind `slate` — a cooler grey than Mantine's default.
// Overriding `gray` rather than registering a new colour is deliberate: the
// Medplum AppShell expresses every border, muted label, hover state and the
// main content background in terms of `--mantine-color-gray-*`, so this single
// override re-tints the whole shell without touching a component.
const gray: MantineColorsTuple = [
  '#f8fafc',
  '#f1f5f9',
  '#e2e8f0',
  '#cbd5e1',
  '#94a3b8',
  '#64748b',
  '#475569',
  '#334155',
  '#1e293b',
  '#0f172a',
];

/** Inter, self-hosted through the `@fontsource-variable/inter` package so no font request leaves the app. */
const FONT_FAMILY =
  "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Lyfe's elevation scale: soft, layered, slate-tinted shadows rather than Mantine's grey ones.
const shadows = {
  xs: '0 1px 2px 0 hsl(220 40% 14% / 0.04)',
  sm: '0 1px 2px -1px hsl(220 40% 14% / 0.06), 0 1px 3px 0 hsl(220 40% 14% / 0.04)',
  md: '0 4px 6px -2px hsl(220 40% 14% / 0.05), 0 2px 4px -2px hsl(220 40% 14% / 0.04)',
  lg: '0 10px 24px -6px hsl(220 40% 14% / 0.08), 0 4px 10px -4px hsl(220 40% 14% / 0.05)',
  xl: '0 20px 40px -12px hsl(220 40% 14% / 0.12), 0 8px 16px -8px hsl(220 40% 14% / 0.06)',
};

export const lyfeTheme = createTheme({
  colors: { primary, gray },
  primaryColor: 'primary',
  primaryShade: 6,

  fontFamily: FONT_FAMILY,
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  black: '#171d2b',

  // Lyfe's base radius is 0.625rem (10px); the scale steps around it.
  defaultRadius: 'md',
  radius: { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '18px' },
  shadows,
  cursorType: 'pointer',
  focusRing: 'auto',

  // Carried over unchanged from the stock Medplum provider theme — these set the
  // app's type scale and are unrelated to branding.
  headings: {
    fontFamily: FONT_FAMILY,
    fontWeight: '650',
    sizes: {
      h1: {
        fontSize: '1.125rem',
        fontWeight: '500',
        lineHeight: '2.0',
      },
    },
  },
  fontSizes: {
    xs: '0.6875rem',
    sm: '0.875rem',
    md: '0.875rem',
    lg: '1.0rem',
    xl: '1.125rem',
  },

  // Component defaults, so every page (Medplum's own screens included) picks up the Lyfe look
  // without per-page styling.
  components: {
    Button: { defaultProps: { radius: 'md' }, styles: { root: { fontWeight: 550 } } },
    ActionIcon: { defaultProps: { radius: 'md' } },
    Paper: { defaultProps: { radius: 'md' } },
    Card: { defaultProps: { radius: 'lg', withBorder: true, shadow: 'xs', padding: 'lg' } },
    Badge: { defaultProps: { radius: 'sm' }, styles: { root: { letterSpacing: '0.02em' } } },
    TextInput: { defaultProps: { radius: 'md' } },
    PasswordInput: { defaultProps: { radius: 'md' } },
    NumberInput: { defaultProps: { radius: 'md' } },
    Textarea: { defaultProps: { radius: 'md' } },
    Select: { defaultProps: { radius: 'md', comboboxProps: { shadow: 'lg', radius: 'md' } } },
    MultiSelect: { defaultProps: { radius: 'md', comboboxProps: { shadow: 'lg', radius: 'md' } } },
    Autocomplete: { defaultProps: { radius: 'md', comboboxProps: { shadow: 'lg', radius: 'md' } } },
    Menu: { defaultProps: { radius: 'md', shadow: 'lg' } },
    Popover: { defaultProps: { radius: 'md', shadow: 'lg' } },
    Tooltip: { defaultProps: { radius: 'sm', withArrow: true, openDelay: 200 } },
    Modal: {
      defaultProps: { radius: 'lg', shadow: 'xl', overlayProps: { backgroundOpacity: 0.35, blur: 3 } },
      styles: { title: { fontWeight: 650 } },
    },
    Drawer: { defaultProps: { overlayProps: { backgroundOpacity: 0.3, blur: 2 } } },
    Table: { defaultProps: { highlightOnHover: true, verticalSpacing: 'sm', horizontalSpacing: 'md' } },
    SegmentedControl: { defaultProps: { radius: 'md' } },
    Notification: { defaultProps: { radius: 'md' } },
    Alert: { defaultProps: { radius: 'md' } },
  },
});
