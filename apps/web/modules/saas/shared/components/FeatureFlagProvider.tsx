"use client";

/**
 * Delivers DB-backed feature-flag values to client components.
 *
 * Values are resolved on the server (in the `(saas)/app` layout) and ride the
 * RSC payload, so they are correct on first paint — no fetch, no loading
 * branch, no flash of the wrong UI. This replaces
 * `process.env.NEXT_PUBLIC_FABRIC_FEATURE_*`, which Next.js inlines at build
 * time and which therefore can never change at runtime.
 */
import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { createContext, type ReactNode, useContext } from "react";

type FeatureFlagValues = Record<FeatureFlagKey, boolean>;

const FeatureFlagContext = createContext<FeatureFlagValues | null>(null);

export function FeatureFlagProvider({
	value,
	children,
}: {
	value: FeatureFlagValues;
	children: ReactNode;
}) {
	return (
		<FeatureFlagContext.Provider value={value}>
			{children}
		</FeatureFlagContext.Provider>
	);
}

export function useFeatureFlag(key: FeatureFlagKey): boolean {
	const flags = useContext(FeatureFlagContext);

	// Deliberately throws rather than returning false. A forgotten provider
	// would otherwise be indistinguishable from a disabled feature, which is
	// exactly the bug that is hardest to notice in review.
	if (flags === null) {
		throw new Error(
			"useFeatureFlag must be used within a FeatureFlagProvider",
		);
	}

	return flags[key];
}
