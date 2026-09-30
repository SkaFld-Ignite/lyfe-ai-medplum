// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import { DIRECTORY_SYSTEMS } from '../services/directory';
import { DEFAULT_CLINIC_TIME_ZONE, resolveClinicTimeZone } from '../utils/clinic-time';

/**
 * The timezone the clinic's calendar is read in.
 *
 * Every screen that renders a time needs this, so it is a hook rather than a
 * prop threaded through the tree. The zone changes only when someone edits an
 * office, which does not happen inside a session, so a per-mount fetch with a
 * module-level cache is enough — no context provider, no store.
 *
 * Returns the default immediately and the resolved zone once the offices load.
 * Rendering a few frames in the fallback zone is better than rendering nothing:
 * for the pilot the fallback *is* the answer, and for anyone else a brief
 * settle is less disruptive than a blank calendar.
 * @param options - Optional settings.
 * @param options.enabled - Pass false while the caller has nothing to render,
 *   so a hook that is idle does not reach the server on its behalf.
 * @returns An IANA zone name.
 */
export function useClinicTimeZone(options?: { enabled?: boolean }): string {
  const medplum = useMedplum();
  const enabled = options?.enabled ?? true;
  const [timeZone, setTimeZone] = useState<string>(cachedZone ?? DEFAULT_CLINIC_TIME_ZONE);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let active = true;
    // Resolved through a promise even when the answer is already cached, so the
    // state update is never synchronous inside the effect — a synchronous one
    // would cascade a second render on every mount.
    // Shared across concurrent callers so ten components mounting together
    // issue one search, not ten.
    inFlight ??= cachedZone
      ? Promise.resolve(cachedZone)
      : medplum
          .searchResources('Location', { identifier: `${DIRECTORY_SYSTEMS.location}|`, _count: '1000' })
          .then((locations) => {
            cachedZone = resolveClinicTimeZone(locations);
            return cachedZone;
          })
          .catch(() => {
            // A clinic whose offices cannot be read still has to render a calendar.
            // The default is wrong-but-consistent, which beats an error boundary
            // over a timezone.
            return DEFAULT_CLINIC_TIME_ZONE;
          })
          .finally(() => {
            inFlight = undefined;
          });

    inFlight
      .then((zone) => {
        if (active) {
          setTimeZone(zone);
        }
        return zone;
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [medplum, enabled]);

  return timeZone;
}

let cachedZone: string | undefined;
let inFlight: Promise<string> | undefined;

/** Drop the cached zone. For tests, and for after an office is edited. */
export function clearClinicTimeZoneCache(): void {
  cachedZone = undefined;
  inFlight = undefined;
}
