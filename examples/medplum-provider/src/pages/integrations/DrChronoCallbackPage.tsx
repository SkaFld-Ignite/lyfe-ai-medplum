// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Where DrChrono sends the user back after they grant access.
 *
 * A Medplum bot cannot serve an HTTP redirect target, so the SPA has to be the
 * landing point. This page does as little as possible with what it receives:
 * it reads `code` and `state` off the query string and hands both to the bot.
 * The code is a credential, the state is only meaningful to the party that
 * minted it, and neither is worth inspecting here.
 *
 * The exchange is fired exactly once per set of parameters. React 19 StrictMode
 * mounts effects twice in development, and a second exchange would present an
 * authorization code DrChrono has already spent — producing a failure on a flow
 * that actually succeeded. The guard ref is what keeps the happy path honest.
 */
import { Alert, Anchor, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconCircleCheck, IconCircleOff, IconPlugConnected } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LyfePageHeader } from '../../components/brand/LyfePageHeader';
import { completeDrChronoAuthorization } from '../../services/integrations';

/** The outcome of the exchange, once one exists. */
interface ExchangeOutcome {
  /** Whether the clinic is now connected. */
  readonly ok: boolean;
  /** What to tell the operator. */
  readonly message: string;
}

/**
 * Turn DrChrono's `error` query parameter into something an operator can act on.
 *
 * `invalid_scope` gets its own wording because it is the failure this
 * integration has actually hit, and its cause is never what the name suggests:
 * one unrecognized scope token rejects the entire request, so the fix is to
 * correct the list rather than to grant more permissions.
 * @param props - The error parameters DrChrono redirected with.
 * @param props.error - The `error` query parameter.
 * @param props.description - The `error_description` query parameter, when present.
 * @returns A message to show the operator.
 */
function describeAuthorizationError(props: { error: string; description: string | null }): string {
  if (props.error === 'access_denied') {
    return 'The DrChrono authorization was declined, so nothing was connected.';
  }
  if (props.error === 'invalid_scope') {
    return (
      'DrChrono rejected the requested scopes. One unrecognized scope fails the whole request, ' +
      'so this is a configuration problem in the app rather than a missing permission on the account.'
    );
  }
  return props.description
    ? `DrChrono returned "${props.error}": ${props.description}`
    : `DrChrono returned "${props.error}".`;
}

/**
 * Decide whether the redirect is usable at all, from the query string alone.
 *
 * Derived during render rather than pushed into state from an effect: it is a
 * pure function of the URL, and an effect that immediately sets state is both a
 * cascading render and a lie about where the value comes from.
 * @param props - The relevant query parameters.
 * @param props.code - The `code` parameter.
 * @param props.state - The `state` parameter.
 * @param props.error - The `error` parameter, when DrChrono refused.
 * @param props.errorDescription - The `error_description` parameter, when present.
 * @returns The problem to show, or undefined when the redirect looks exchangeable.
 */
function findRedirectProblem(props: {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}): string | undefined {
  if (props.error) {
    return describeAuthorizationError({ error: props.error, description: props.errorDescription });
  }
  if (!props.code || !props.state) {
    return 'This redirect is missing its code or state parameter. Start the connection again from Integrations.';
  }
  return undefined;
}

/**
 * The DrChrono OAuth redirect landing page.
 * @returns The page element.
 */
export function DrChronoCallbackPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [outcome, setOutcome] = useState<ExchangeOutcome>();

  // One exchange per mount, whatever React does with the effect.
  const exchanged = useRef(false);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');
  const problem = findRedirectProblem({ code, state, error, errorDescription });

  useEffect(() => {
    if (problem || exchanged.current || !code || !state) {
      return;
    }
    exchanged.current = true;

    completeDrChronoAuthorization(medplum, { code, state })
      .then((result) => setOutcome({ ok: result.ok, message: result.message }))
      .catch((err: unknown) => setOutcome({ ok: false, message: normalizeErrorString(err) }));
  }, [medplum, code, state, problem]);

  const settled = problem ? { ok: false, message: problem } : outcome;

  return (
    <Stack gap="lg" p="md">
      <LyfePageHeader
        icon={<IconPlugConnected size={20} />}
        eyebrow="Integrations"
        title="DrChrono"
        description="Finishing the authorization DrChrono just sent you back from."
      />

      <Paper shadow="xs" radius="md" p="lg" style={{ border: '1px solid var(--mantine-color-gray-2)' }}>
        <Stack gap="md">
          {!settled && (
            <Group gap="sm">
              <Loader size="sm" />
              <Text size="sm">Completing the DrChrono connection…</Text>
            </Group>
          )}

          {settled && (
            <Alert
              variant="light"
              radius="md"
              color={settled.ok ? 'green' : 'red'}
              icon={settled.ok ? <IconCircleCheck size={16} /> : <IconCircleOff size={16} />}
              title={settled.ok ? 'Connected' : 'Not connected'}
            >
              <Text size="sm">{settled.message}</Text>
            </Alert>
          )}

          <Group gap="xs">
            <Button radius="md" onClick={() => navigate('/integrations')}>
              Back to Integrations
            </Button>
            {settled && !settled.ok && (
              <Anchor size="sm" onClick={() => navigate('/integrations')}>
                Start the connection again
              </Anchor>
            )}
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}
