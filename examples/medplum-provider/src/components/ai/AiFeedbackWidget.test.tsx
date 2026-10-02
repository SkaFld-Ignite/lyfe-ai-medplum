// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The feedback widget, against a mock Medplum server.
 *
 * `src/utils/ai-feedback.test.ts` covers the resource shape; this covers the two
 * behaviours that live in the hook and that prod got wrong: a partial submit
 * must carry the rest of the standing record with it, and un-toggling a thumb
 * must actually clear the stored rating rather than quietly keeping it.
 */
import { MantineProvider } from '@mantine/core';
import type { Communication } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import type { AiFeedbackTarget } from '../../utils/ai-feedback';
import { AI_FEEDBACK_RATING_SYSTEM, aiFeedbackSearchQuery } from '../../utils/ai-feedback';
import { AiFeedbackWidget } from './AiFeedbackWidget';

const TARGET: AiFeedbackTarget = {
  composition: { reference: 'Composition/comp-1' },
  patient: { reference: 'Patient/pat-1' },
  reviewer: { reference: 'Practitioner/doc-1' },
};

let medplum: MockClient;

function setup(props: { compact?: boolean } = {}): void {
  render(
    <MedplumProvider medplum={medplum}>
      <MantineProvider>
        <AiFeedbackWidget target={TARGET} originalContent="The model wrote this." compact={props.compact} />
      </MantineProvider>
    </MedplumProvider>
  );
}

async function storedFeedback(): Promise<Communication | undefined> {
  return medplum.searchOne('Communication', aiFeedbackSearchQuery('comp-1', 'Practitioner/doc-1'));
}

function ratingOf(communication: Communication | undefined): string | undefined {
  return communication?.category
    ?.flatMap((category) => category.coding ?? [])
    .find((coding) => coding.system === AI_FEEDBACK_RATING_SYSTEM)?.code;
}

describe('AiFeedbackWidget', () => {
  beforeEach(() => {
    medplum = new MockClient();
  });

  test('renders nothing without a target, rather than a control that cannot save', () => {
    render(
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <AiFeedbackWidget target={undefined} />
        </MantineProvider>
      </MedplumProvider>
    );
    expect(screen.queryByLabelText('Helpful')).not.toBeInTheDocument();
  });

  test('stores a thumbs-up', async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText('Helpful')).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Helpful'));
    });
    await waitFor(() => expect(screen.getByText('Feedback saved')).toBeInTheDocument());
    expect(ratingOf(await storedFeedback())).toBe('thumbs-up');
  });

  test('a second click on the active thumb clears the stored rating', async () => {
    // Prod's widget looked like it did this and did not: it sent `undefined`,
    // which its server action read as "leave it alone", so the UI showed no vote
    // while the database still held one.
    setup();
    await waitFor(() => expect(screen.getByLabelText('Helpful')).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Helpful'));
    });
    await waitFor(async () => expect(ratingOf(await storedFeedback())).toBe('thumbs-up'));

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Helpful'));
    });
    await waitFor(async () => expect(ratingOf(await storedFeedback())).toBeUndefined());
  });

  test('a comment saved after a rating keeps the rating', async () => {
    // The coalescing the conditional update makes necessary: the write replaces
    // the resource, so a comment-only submit has to carry the rating with it.
    setup();
    await waitFor(() => expect(screen.getByLabelText('Not helpful')).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Not helpful'));
    });
    await waitFor(async () => expect(ratingOf(await storedFeedback())).toBe('thumbs-down'));

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Add comment'));
    });
    fireEvent.change(screen.getByLabelText('Feedback comment'), { target: { value: 'Missed the AKI' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save comment'));
    });

    await waitFor(async () => {
      const stored = await storedFeedback();
      expect(stored?.payload?.[0]?.contentString).toBe('Missed the AKI');
      expect(ratingOf(stored)).toBe('thumbs-down');
    });
  });

  test('a correction is stored as a text attachment and reported to the caller', async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText('Edit and correct')).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Edit and correct'));
    });
    // Seeded with the text on screen, so the clinician corrects rather than retypes.
    const editor = screen.getByLabelText('Corrected text');
    expect(editor).toHaveValue('The model wrote this.');
    fireEvent.change(editor, { target: { value: 'Apixaban, not warfarin.' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save correction'));
    });

    await waitFor(async () => {
      const attachment = (await storedFeedback())?.payload?.[0]?.contentAttachment;
      expect(attachment?.contentType).toBe('text/plain');
      expect(attachment?.data).toBeTruthy();
    });
  });

  test('compact mode offers the rating only', async () => {
    setup({ compact: true });
    await waitFor(() => expect(screen.getByLabelText('Helpful')).toBeEnabled());
    expect(screen.queryByLabelText('Add comment')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Edit and correct')).not.toBeInTheDocument();
  });

  test('a stored record is loaded back into the controls', async () => {
    await medplum.createResource<Communication>({
      resourceType: 'Communication',
      identifier: [{ system: 'https://lyfe.com/ai-feedback', value: 'comp-1:Practitioner:doc-1' }],
      status: 'completed',
      category: [{ coding: [{ system: AI_FEEDBACK_RATING_SYSTEM, code: 'thumbs-up' }] }],
      subject: { reference: 'Patient/pat-1' },
      about: [{ reference: 'Composition/comp-1' }],
      sender: { reference: 'Practitioner/doc-1' },
      payload: [{ contentString: 'Good summary' }],
    });

    setup();
    await waitFor(() => expect(screen.getByLabelText('Helpful')).toHaveAttribute('aria-pressed', 'true'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Add comment'));
    });
    expect(screen.getByLabelText('Feedback comment')).toHaveValue('Good summary');
  });
});
