import {
	isProtectedProjectTab,
	normalizeProjectTabConfig,
	normalizeProjectTabPrefs,
	PROJECT_TAB_DEFAULT_HIDDEN_IDS,
	type ProjectTabConfig,
	type ProjectTabPrefs,
} from "@repo/database/src/project-tabs";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";

/** Tab-bar metadata shape shared by the customize dialog and admin panel. */
export type ProjectTabMeta = {
	id: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
};

/**
 * Project-tab customization (Fizzy card #1837): resolves which project tabs a
 * given member sees, and in what order, from FOUR layers, each only ever
 * narrowing the one above:
 *
 *   0. **Feature flag — does this deployment offer the capability at all?**
 *      Build-time `NEXT_PUBLIC_*` vars (the same gates that hid these pages
 *      before customization existed). A tab excluded here is invisible
 *      everywhere — bar, dialog, admin panel, Get Started — and no admin or
 *      user preference can override it, because the backend APIs behind it are
 *      gated by the matching deployment configuration too. App-level
 *      provisioning is deliberately NOT a runtime toggle.
 *   1. the build-time default (optional tabs start hidden — see
 *      `PROJECT_TAB_DEFAULT_HIDDEN_IDS`);
 *   2. the project admin's `tabVisibility` overrides (`Record<tabId, boolean>`
 *      stored on the Project row — force-shows a default-hidden optional, or
 *      hides anything else, for EVERY member);
 *   3. the viewer's own `tabPreferences` (personal hidden list + ordering,
 *      bounded by what survived layer 2).
 *
 * The canonical tab list itself lives in `ProjectDetails.tsx` (the get-started
 * drift test parses its source), so everything here works on generic
 * `{ id }`-shaped metadata: a tab added to that array tomorrow flows through
 * resolution, ordering and the customize UI with zero extra wiring.
 */

// Layer 0 — per-deployment availability ceiling. Same env reads and legacy
// fallbacks the old client gates used in `ProjectDetails.tsx`, so restoring
// this layer preserves the exact pre-customization behaviour per environment.
// Read lazily (a function, not a module constant): NEXT_PUBLIC_* values are
// inlined per build either way, and lazy reads keep the ceiling testable via
// vi.stubEnv without module-reload gymnastics.
function featureGatedProjectTabs(): Record<string, boolean> {
	return {
		atlas:
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_ATLAS === "true" ||
			// Legacy env name kept for deployments still carrying it.
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_CODE_UNDERSTANDING ===
				"true",
		"test-cases":
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES === "true",
		"publishing-suite":
			process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE === "true",
	};
}

/** Layer 0 check: is this tab offered by THIS deployment at all? */
export function isProjectTabFeatureEnabled(tabId: string): boolean {
	const gated = featureGatedProjectTabs();
	return !(tabId in gated) || gated[tabId];
}

/** Admin-level visibility of every feature-enabled tab: `{ tabId: isVisible }`. */
export function resolveAdminTabState(
	tabIds: readonly string[],
	config: ProjectTabConfig | null | undefined,
): Record<string, boolean> {
	const defaultHidden = new Set(
		PROJECT_TAB_DEFAULT_HIDDEN_IDS as readonly string[],
	);
	const overrides = config?.overrides ?? {};
	const state: Record<string, boolean> = {};
	for (const id of tabIds) {
		if (!isProjectTabFeatureEnabled(id)) {
			continue; // Layer 0: not offered by this deployment — no state at all.
		}
		state[id] = isProtectedProjectTab(id)
			? true
			: (overrides[id] ?? !defaultHidden.has(id));
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
	config?: unknown,
	prefs?: unknown,
): boolean {
	if (isProtectedProjectTab(tabId)) {
		return true;
	}
	// Layer 0: a deployment that doesn't offer the tab hides it from everyone.
	if (!isProjectTabFeatureEnabled(tabId)) {
		return false;
	}
	const overrides = normalizeProjectTabConfig(config)?.overrides ?? {};
	const hidden = new Set(normalizeProjectTabPrefs(prefs)?.hidden ?? []);
	const defaultHidden = new Set(
		PROJECT_TAB_DEFAULT_HIDDEN_IDS as readonly string[],
	);
	const projectVisible = overrides[tabId] ?? !defaultHidden.has(tabId);
	return projectVisible && !hidden.has(tabId);
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
	},
): T[] {
	const config = normalizeProjectTabConfig(input.config);
	const prefs = normalizeProjectTabPrefs(input.prefs);
	const overrides = config?.overrides ?? {};
	const personallyHidden = new Set(prefs?.hidden ?? []);
	const defaultHidden = new Set(
		PROJECT_TAB_DEFAULT_HIDDEN_IDS as readonly string[],
	);

	const visible = tabs.filter((tab) => {
		// Layer 0: a deployment that doesn't offer the tab hides it from
		// everyone, ahead of every other layer.
		if (!isProjectTabFeatureEnabled(tab.id)) {
			return false;
		}
		if (isProtectedProjectTab(tab.id)) {
			return true;
		}
		// An admin-disabled tab beats any personal preference; a personal
		// hidden entry applies within whatever the project allows.
		const projectVisible = overrides[tab.id] ?? !defaultHidden.has(tab.id);
		return projectVisible && !personallyHidden.has(tab.id);
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
