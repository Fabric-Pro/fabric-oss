"use client";

/**
 * Server-resolved answer to "does this user have any default function tags?",
 * delivered over the RSC payload (Fizzy #2264).
 *
 * The blocking role-tag gate must decide on FIRST PAINT. If that decision
 * depended on a client fetch, a tagless user whose request failed — or a
 * client that never issued it — would get the app with no gate at all. This
 * carries the answer with the page instead.
 *
 * Tri-state on purpose:
 *   false → tagless, the gate opens
 *   true  → has tags, no gate
 *   null  → the server read failed; the gate stays SHUT (spec D12). A
 *           database incident must not trap every user behind a modal. The
 *           bypass is narrow and self-healing: the gate's own `getMyDefault`
 *           query re-decides as soon as any read succeeds.
 *
 * Deliberately NOT part of `FeatureFlagProvider`: that provider is typed
 * `Record<FeatureFlagKey, boolean>`, and this is neither a flag key nor a
 * boolean.
 */
import { createContext, type ReactNode, useContext } from "react";

const RoleTagSnapshotContext = createContext<boolean | null>(null);

export function RoleTagSnapshotProvider({
	value,
	children,
}: {
	value: boolean | null;
	children: ReactNode;
}) {
	return (
		<RoleTagSnapshotContext.Provider value={value}>
			{children}
		</RoleTagSnapshotContext.Provider>
	);
}

/**
 * Unlike `useFeatureFlag`, this does not throw outside a provider: `null`
 * ("unknown") is a real value here and routes to the same safe branch, so a
 * missing provider degrades exactly the way a failed read does.
 */
export function useRoleTagSnapshot(): boolean | null {
	return useContext(RoleTagSnapshotContext);
}
