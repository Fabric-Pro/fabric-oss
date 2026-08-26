"use client";

/**
 * React hook for reading monitoring v2 feature flags inside Client
 * Components. Thin wrapper around the pure reader in `./feature-flags`.
 *
 * The hook exists so callers in client components do not need to import
 * server-only helpers, and so we have a single seam to later wire in a
 * real flag-management client (GrowthBook's `useFeature`, LaunchDarkly's
 * `useFlags`) without touching every call site.
 *
 * With env-driven flags the value is stable for the life of the session
 * (it was inlined at build time) so the hook is essentially a pass-through
 * to `isMonitoringFeatureEnabled(flag)`. The `useEffect` re-read is in
 * place for the future runtime-flag-client case.
 */

import { useEffect, useState } from "react";
import {
	isMonitoringFeatureEnabled,
	type MonitoringFeatureFlag,
} from "./feature-flags";

/**
 * Returns the current value of a monitoring feature flag.
 *
 * Use this in Client Components. Server Components and route handlers
 * should call `isMonitoringFeatureEnabled(flag)` directly from
 * `./feature-flags`.
 */
export function useMonitoringFeatureFlag(flag: MonitoringFeatureFlag): boolean {
	const buildTimeValue = isMonitoringFeatureEnabled(flag);
	const [value, setValue] = useState<boolean>(buildTimeValue);

	useEffect(() => {
		// On mount, re-evaluate. With env-driven flags this is a no-op,
		// but when a runtime flag client is added it will pick up the
		// real value here.
		setValue(isMonitoringFeatureEnabled(flag));
	}, [flag]);

	return value;
}
