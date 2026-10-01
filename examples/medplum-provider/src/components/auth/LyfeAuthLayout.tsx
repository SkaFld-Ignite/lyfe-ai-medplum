// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from '@mantine/core';
import { IconActivity, IconShieldCheck, IconSparkles, IconStethoscope } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import classes from './LyfeAuth.module.css';

const BRAND_FEATURES = [
  { icon: IconStethoscope, label: 'AI-augmented clinical decisions' },
  { icon: IconShieldCheck, label: 'HIPAA-compliant & SOC 2 ready' },
  { icon: IconActivity, label: 'Real-time EHR sync with DrChrono' },
];

const BRAND_STATS = [
  { value: '3.5×', label: 'Faster charting' },
  { value: '62%', label: 'Less burnout' },
  { value: 'FHIR', label: 'R4 compliant' },
];

function BrandMark({ size }: { size: 'lg' | 'sm' }): JSX.Element {
  return (
    <span className={classes.mark} data-size={size} aria-hidden>
      L
    </span>
  );
}

export interface LyfeAuthHeadingProps {
  /** The small pill above the title, e.g. "Sign in". */
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
}

/**
 * The Lyfe card heading: a pill, a title and a line of help text.
 * @param props - The heading text.
 * @returns The heading.
 */
export function LyfeAuthHeading(props: LyfeAuthHeadingProps): JSX.Element {
  return (
    <div className={classes.heading}>
      <span className={classes.eyebrow}>
        <IconSparkles size={12} className={classes.eyebrowIcon} />
        {props.eyebrow}
      </span>
      <h1 className={classes.title}>{props.title}</h1>
      <Text className={classes.subtitle}>{props.subtitle}</Text>
    </div>
  );
}

/**
 * The Lyfe sign-in screen, copied from the old Lyfe app: a brand panel on the left and the form
 * card on the right. The form itself is passed in (Medplum's SignInForm or RegisterForm), so every
 * authentication step stays Medplum's.
 * @param props - The layout props.
 * @param props.children - The auth form.
 * @returns The auth layout.
 */
export function LyfeAuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={classes.root}>
      <aside className={classes.hero}>
        <div className={classes.orbTop} aria-hidden />
        <div className={classes.orbBottom} aria-hidden />
        <div className={classes.dots} aria-hidden />

        <div className={classes.brand}>
          <BrandMark size="lg" />
          <span className={classes.brandName}>LyfeAI</span>
        </div>

        <div className={classes.heroBody}>
          <span className={classes.heroPill}>
            <IconSparkles size={14} />
            AI-powered healthcare platform
          </span>
          <h2 className={classes.heroTitle}>Care, augmented by intelligence.</h2>
          <p className={classes.heroText}>
            Save hours per day with AI-driven documentation, decision support, and seamless EHR integration trusted by
            forward-looking clinics.
          </p>
          <ul className={classes.features}>
            {BRAND_FEATURES.map((f) => (
              <li key={f.label}>
                <span className={classes.featureIcon}>
                  <f.icon size={16} />
                </span>
                {f.label}
              </li>
            ))}
          </ul>
        </div>

        <div className={classes.stats}>
          {BRAND_STATS.map((s) => (
            <div key={s.label}>
              <p className={classes.statValue}>{s.value}</p>
              <p className={classes.statLabel}>{s.label}</p>
            </div>
          ))}
        </div>
      </aside>

      <main className={classes.panel}>
        <div className={classes.panelOrb} aria-hidden />
        <div className={classes.column}>
          <div className={classes.mobileBrand}>
            <BrandMark size="sm" />
            <span className={classes.mobileBrandName}>LyfeAI</span>
          </div>

          <div className={classes.cardShell}>
            <div className={classes.halo} aria-hidden />
            <div className={classes.card}>
              <div className={classes.cardOrb} aria-hidden />
              <div className={classes.formSlot}>{children}</div>
            </div>
          </div>

          <p className={classes.secure}>
            <IconShieldCheck size={14} className={classes.secureIcon} />
            Protected by enterprise-grade encryption · HIPAA compliant
          </p>
        </div>
      </main>
    </div>
  );
}
