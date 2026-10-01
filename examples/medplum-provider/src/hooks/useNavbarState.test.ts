// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import { patientIdFromPath, useNavbarState } from './useNavbarState';

describe('patientIdFromPath', () => {
  test('finds the patient in chart paths only', () => {
    expect(patientIdFromPath('/Patient/p1')).toBe('p1');
    expect(patientIdFromPath('/Patient/p1/Encounter/e1')).toBe('p1');
    expect(patientIdFromPath('/Patient/new')).toBeUndefined();
    expect(patientIdFromPath('/Patient')).toBeUndefined();
    expect(patientIdFromPath('/scheduling')).toBeUndefined();
  });
});

describe('useNavbarState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('starts from the remembered choice outside a chart', () => {
    localStorage['navbarOpen'] = 'true';
    const { result } = renderHook(() => useNavbarState('/scheduling'));
    expect(result.current.navbarOpen).toBe(true);
  });

  test('starts closed on a patient chart', () => {
    localStorage['navbarOpen'] = 'true';
    const { result } = renderHook(() => useNavbarState('/Patient/p1/timeline'));
    expect(result.current.navbarOpen).toBe(false);
  });

  test('closes when a patient chart opens, and lets the user reopen it', () => {
    localStorage['navbarOpen'] = 'true';
    const { result, rerender } = renderHook(({ path }) => useNavbarState(path), {
      initialProps: { path: '/scheduling' },
    });
    expect(result.current.navbarOpen).toBe(true);

    rerender({ path: '/Patient/p1/timeline' });
    expect(result.current.navbarOpen).toBe(false);

    act(() => result.current.setNavbarOpen(true));
    // Moving between sections of the same chart keeps the user's choice.
    rerender({ path: '/Patient/p1/Encounter' });
    expect(result.current.navbarOpen).toBe(true);

    // Another patient's chart closes it again.
    rerender({ path: '/Patient/p2' });
    expect(result.current.navbarOpen).toBe(false);
  });
});
