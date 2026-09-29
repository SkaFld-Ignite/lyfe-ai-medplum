// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useState } from 'react';

export type PersistentStorageKind = 'local' | 'session';

function getStorage(kind: PersistentStorageKind): Storage | undefined {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    // Storage can throw in private mode or when blocked by browser settings.
    return undefined;
  }
}

function readValue<T>(kind: PersistentStorageKind, key: string, fallback: T): T {
  try {
    const raw = getStorage(kind)?.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * `useState` backed by localStorage or sessionStorage. Storage failures (private mode, quota,
 * malformed JSON) fall back to the default value and never throw.
 * @param key - The storage key.
 * @param fallback - The value used when nothing valid is stored.
 * @param kind - Which browser storage to use.
 * @returns The state value and a setter, like `useState`.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  kind: PersistentStorageKind = 'local'
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readValue(kind, key, fallback));

  const setAndStore = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setValue((prev) => {
        const next = typeof action === 'function' ? (action as (prev: T) => T)(prev) : action;
        try {
          getStorage(kind)?.setItem(key, JSON.stringify(next));
        } catch {
          // Ignore write failures; the in-memory state is still updated.
        }
        return next;
      });
    },
    [key, kind]
  );

  return [value, setAndStore];
}
