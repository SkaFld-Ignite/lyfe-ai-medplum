// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { SignInForm } from '@medplum/react';
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LyfeAuthHeading, LyfeAuthLayout } from '../components/auth/LyfeAuthLayout';

export function SignInPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  return (
    <LyfeAuthLayout>
      <SignInForm
        // Configure according to your settings
        googleClientId={import.meta.env.GOOGLE_CLIENT_ID}
        clientId={import.meta.env.MEDPLUM_CLIENT_ID}
        onSuccess={() => navigate('/')?.catch(console.error)}
        onRegister={
          import.meta.env.MEDPLUM_REGISTER_ENABLED === 'true'
            ? () => navigate('/register')?.catch(console.error)
            : undefined
        }
        projectId={searchParams.get('project') || undefined}
        login={searchParams.get('login') || undefined}
      >
        <LyfeAuthHeading eyebrow="Sign in" title="Welcome back" subtitle="Sign in to continue your clinical workflow" />
      </SignInForm>
    </LyfeAuthLayout>
  );
}
