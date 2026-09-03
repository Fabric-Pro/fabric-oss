import {
	isProtectedProjectTab,
	normalizeProjectTabConfig,
	normalizeProjectTabPrefs,
	type ProjectTabConfig,
	type ProjectTabPrefs,
} from "@repo/database/src/project-tabs";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentType, useMemo } from "react";

/** Tab-bar metadata shape shared by the customize dialog and admin panel. */
export type ProjectTabMeta = {
	id: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
};

/**
 * Project-tab customization (Fizzy card #1837): resolves which project tabs a
 * given member sees, and in what order, from THREE layers, each only ever
 * narrowing the one above:
 *
 *   0. **Feature flag — is this capability offered to this viewer at all?**
 *      Atlas and Test Cases are build-time `NEXT_PUBLIC_*` vars, one answer
 *      per deployment. Publishing Suite resolves per organization at request
 *      time, so the same build offers it to an enrolled organization and
 *      withholds it from every other one. A tab excluded here is invisible
 *      everywhere — bar, dialog, admin panel, Get Started — and no admin or
 *      user preference can override it, because the API behind it is gated on
 *      the same flag, or, for Atlas and Test Cases, on its server-side twin
 *      (`FABRIC_FEATURE_*`, which a deployment is expected to keep in step
 *      with the `NEXT_PUBLIC_*` value; nothing enforces the pair).
 *   1. the project admin's `tabVisibility` overrides (`Record<tabId, boolean>`
 *      stored on the Project row — hides a tab for EVERY member, or brings
 *      back one an earlier admin hid). Every offered tab is visible until an
 *      admin says otherwise;
 *   2. the viewer's own `tabPreferences` (personal hidden list + ordering,
 *      bounded by what survived layer 1).
 *
 * The canonical tab list itself lives in `project-tabs.ts` (the get-started
 * drift test parses its source), so everything here works on generic
 * `{ id }`-shaped metadata: a tab added to that array tomorrow flows through
 * resolution, ordering and the customize UI with zero extra wiring.
 */

/**
 * Layer 0 gates that cannot be read from the environment.
 *
 * `NEXT_PUBLIC_*` values are inlined by Next at build time, so one build can
 * only ever carry one answer. Publishing Suite is scoped to named
 * organizations, so its ceiling is resolved per request and handed in.
 *
 * The field is REQUIRED on every resolver below, deliberately. An optional
 * gate defaulting to `false` would silently hide the tab wherever a caller
 * forgot it; defaulting to `true` would silently show it to an organization
 * that was never enrolled. Required means the compiler lists the call sites.
 */
export type ProjectTabGates = {
	/** `PUBLISHING_SUITE`, resolved for the viewer's organization. */
	publishingSuiteEnabled: boolean;
};

/**
 * The gates for the current organization, from the nearest FeatureFlagProvider
 * (the organization layout mounts one resolved for that organization).
 *
 * Memoized on purpose: this returns an object, and a fresh identity on every
 * render would defeat the `useMemo`s in `ProjectDetails` and
 * `ProjectReadinessPanel` that depend on it — handing a new tab array to
 * downstream effects on every render, not merely recomputing a cheap filter.
 */
export function useProjectTabGates(): ProjectTabGates {
	const publishingSuiteEnabled = useFeatureFlag("PUBLISHING_SUITE");
	return useMemo(
		() => ({ publishingSuiteEnabled }),
		[publishingSuiteEnabled],
	);
}

// Layer 0 — the availability ceiling. Atlas and Test Cases keep the build-time
// env reads and legacy fallbacks the old client gates used in
// `ProjectDetails.tsx`, so those two behave exactly as they did per
// environment. Read lazily (a function, not a module constant) so the env
// gates stay testable via vi.stubEnv without module-reload gymnastics.
function featureGatedProjectTabs(
	gates: ProjectTabGates,
): Record<string, boolean> {
	// Guarded at runtime, not only by types. `apps/web/tsconfig.json` excludes
	// every test file, so a stale positional call left in a test — passing a
	// config object, or `{}`, where the gates now go — compiles, runs, and can
	// still pass, because a tab gated on an env var never reads this object.
	// Throwing turns that into a named failure in the one gate that does cover
	// tests. Same reasoning as `useFeatureFlag`, which throws on a missing
	// provider rather than reporting the feature as off.
	// Not exhaustive, though: a protected tab id returns from
	// `isProjectTabVisibleToViewer` before this function is ever called, and an
	// empty tab list makes `resolveAdminTabState` / `resolveProjectTabs` skip
	// it entirely — both are harmless only because the protected and gated id
	// sets are disjoint today.
	if (typeof gates?.publishingSuiteEnabled !== "boolean") {
		throw new Error(
			"project-tab Layer 0 needs resolved ProjectTabGates; pass useProjectTabGates() (components) or an explicit { publishingSuiteEnabled } (tests)",
		);
	}
	return {
		atlas:
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_ATLAS === "true" ||
			// Legacy env name kept for deployments still carrying it.
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_CODE_UNDERSTANDING ===
				"true",
		"test-cases":
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES === "true",
		"publishing-suite": gates.publishingSuiteEnabled,
	};
}

/** Layer 0 check: is this tab offered to THIS viewer's organization at all? */
export function isProjectTabFeatureEnabled(
	tabId: string,
	gates: ProjectTabGates,
): boolean {
	const gated = featureGatedProjectTabs(gates);
	return !(tabId in gated) || gated[tabId];
}

/** Admin-level visibility of every feature-enabled tab: `{ tabId: isVisible }`. */
export function resolveAdminTabState(
	tabIds: readonly string[],
	config: ProjectTabConfig | null | undefined,
	gates: ProjectTabGates,
): Record<string, boolean> {
	const overrides = config?.overrides ?? {};
	const state: Record<string, boolean> = {};
	for (const id of tabIds) {
		if (!isProjectTabFeatureEnabled(id, gates)) {
			continue; // Layer 0: not offered to this viewer — no state at all.
		}
		state[id] = isProtectedProjectTab(id) ? true : (overrides[id] ?? true);
	}
	return state;
}

/**
 * Single-tab form of the resolver, for surfaces that hold a tab ID but not the
 * whole list — the Get-Started controller uses it to keep tours and drawer
 * entries from pointing at a tab this viewer can't see. Same inputs as
 * `resolveProjectTabs` (raw Json payloads; malformed shapes degrade to
 * "nothing configured").
 */
export function isProjectTabVisibleToViewer(
	tabId: string,
	gates: ProjectTabGates,
	config?: unknown,
	prefs?: unknown,
): boolean {
	if (isProtectedProjectTab(tabId)) {
		return true;
	}
	// Layer 0: a ceiling that doesn't offer the tab hides it from everyone.
	if (!isProjectTabFeatureEnabled(tabId, gates)) {
		return false;
	}
	const overrides = normalizeProjectTabConfig(config)?.overrides ?? {};
	const hidden = new Set(normalizeProjectTabPrefs(prefs)?.hidden ?? []);
	return (overrides[tabId] ?? true) && !hidden.has(tabId);
}

/**
 * Resolve the tabs the current viewer should see, in the order they should
 * render. `config`/`prefs` accept the RAW Json payloads straight from the API
 * — malformed shapes degrade to "nothing configured", never throw.
 *
 * Ordering semantics: `prefs.order` is the user's saved sequence. Entries that
 * are unknown, no longer visible, or duplicated are skipped; every visible tab
 * NOT listed appends afterwards in its default position order — so removing a
 * product tab preserves everyone's relative order, and a newly shipped tab
 * lands at the end until the user moves it.
 */
export function resolveProjectTabs<T extends { id: string }>(
	tabs: readonly T[],
	input: {
		config?: unknown;
		prefs?: unknown;
		gates: ProjectTabGates;
	},
): T[] {
	const config = normalizeProjectTabConfig(input.config);
	const prefs = normalizeProjectTabPrefs(input.prefs);
	const overrides = config?.overrides ?? {};
	const personallyHidden = new Set(prefs?.hidden ?? []);

	const visible = tabs.filter((tab) => {
		// Layer 0: a ceiling that doesn't offer the tab hides it from
		// everyone, ahead of every other layer.
		if (!isProjectTabFeatureEnabled(tab.id, input.gates)) {
			return false;
		}
		if (isProtectedProjectTab(tab.id)) {
			return true;
		}
		// An admin-disabled tab beats any personal preference; a personal
		// hidden entry applies within whatever the project allows.
		return (overrides[tab.id] ?? true) && !personallyHidden.has(tab.id);
	});

	const savedOrder = prefs?.order;
	if (!savedOrder || savedOrder.length === 0) {
		return visible;
	}
	const byId = new Map(visible.map((tab) => [tab.id, tab]));
	const ordered: T[] = [];
	const placed = new Set<string>();
	for (const id of savedOrder) {
		const tab = byId.get(id);
		if (tab && !placed.has(id)) {
			ordered.push(tab);
			placed.add(id);
		}
	}
	for (const tab of visible) {
		if (!placed.has(tab.id)) {
			ordered.push(tab);
		}
	}
	return ordered;
}

/**
 * Read + persist the two preference documents behind the project tab bar.
 * Both queries share their cache keys with every other consumer (the
 * Get-Started controller reads the same hooks), so mounting this in several
 * components costs one pair of requests per project, not one per component.
 */
export function useProjectTabCustomization(params: {
	projectId: string;
	enabled?: boolean;
}) {
	const { projectId, enabled = true } = params;
	const input = { projectId };

	const visibilityOptions = orpc.projects.tabVisibility.get.queryOptions({
		input,
	});
	const prefsOptions = orpc.projects.tabPreferences.get.queryOptions({
		input,
	});
	const visibilityQuery = useQuery({
		...visibilityOptions,
		enabled,
	});
	const prefsQuery = useQuery({
		...prefsOptions,
		enabled,
	});

	const queryClient = useQueryClient();
	const saveConfig = useMutation({
		mutationFn: async (config: ProjectTabConfig) =>
			orpc.projects.tabVisibility.set.call({ ...input, config }),
		onSuccess: (data) =>
			queryClient.setQueryData(visibilityOptions.queryKey, data),
	});
	const savePrefs = useMutation({
		mutationFn: async (prefs: ProjectTabPrefs) =>
			orpc.projects.tabPreferences.set.call({ ...input, prefs }),
		onSuccess: (data) =>
			queryClient.setQueryData(prefsOptions.queryKey, data),
	});

	return {
		// True once both documents have loaded (or errored into "absent") — the
		// tab bar waits on this so a stale session tab never renders before its
		// visibility is known.
		ready: !visibilityQuery.isLoading && !prefsQuery.isLoading,
		config: visibilityQuery.data?.config ?? null,
		prefs: prefsQuery.data?.prefs ?? null,
		saveConfig,
		savePrefs,
	};
}
