// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { usePersistentState } from './usePersistentState';

describe('usePersistentState', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  test('starts from the fallback and persists updates', () => {
    const { result } = renderHook(() => usePersistentState('key', ['a']));
    expect(result.current[0]).toEqual(['a']);

    act(() => result.current[1](['b']));
    expect(result.current[0]).toEqual(['b']);
    expect(localStorage.getItem('key')).toBe('["b"]');
  });

  test('reads an existing value and supports updater functions', () => {
    sessionStorage.setItem('count', '2');
    const { result } = renderHook(() => usePersistentState('count', 0, 'session'));
    expect(result.current[0]).toBe(2);

    act(() => result.current[1]((n) => n + 1));
    expect(sessionStorage.getItem('count')).toBe('3');
  });

  test('falls back on malformed stored JSON', () => {
    localStorage.setItem('broken', '{not json');
    const { result } = renderHook(() => usePersistentState('broken', true));
    expect(result.current[0]).toBe(true);
  });

  test('keeps working when storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => usePersistentState('key', 1));
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
  });
});
