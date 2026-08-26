"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	coerceSort,
	DEFAULT_ROADMAP_SORT,
	type RoadmapSort,
	type RoadmapStoryOrderMap,
} from "../lib/roadmap-sorts";

/**
 * Per-project roadmap view preferences (persisted to localStorage):
 *  - `groupBy`: group the accordions by Priority or by drafting Stage.
 *  - `columns`: which optional card columns are shown (the settings gear lets
 *    the user toggle these with Save/Cancel).
 *  - `columnOrder`: the left-to-right order of those columns (drag-reorderable
 *    in the settings gear). Title is always first and is not part of this list.
 */
export type RoadmapGroupBy = "priority" | "stage";

/** "table" = grouped accordions of rows; "board" = kanban-style columns (both
 * sort WITHIN their sections); "plain" = a flat table, no sections (global sort);
 * "priority" = a single ranked worklist, ordered by the computed priority score
 * rather than by the toolbar sort, with its own bug/feature switcher.
 *
 * The type is derived from this list so the allowlist `coerceView` validates
 * against and the union can never drift — adding a mode here is the only edit
 * needed, and forgetting to widen a validator is not possible. */
const ROADMAP_VIEW_MODES = ["table", "board", "plain", "priority"] as const;

export type RoadmapViewMode = (typeof ROADMAP_VIEW_MODES)[number];

function isRoadmapViewMode(value: unknown): value is RoadmapViewMode {
	return ROADMAP_VIEW_MODES.some((mode) => mode === value);
}

/**
 * Kill-switch for the Priority layout, default ON — only `"false"` disables it,
 * so the feature ships without an env change but stays one variable away from
 * rollback. Written as a literal `process.env.NEXT_PUBLIC_*` expression because
 * Next.js inlines those at build time; a computed key reads `undefined` in the
 * browser bundle.
 */
export const PRIORITY_VIEW_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_PRIORITY_VIEW !== "false";

function coerceMode(value: unknown): RoadmapViewMode {
	if (!isRoadmapViewMode(value)) {
		return "table";
	}
	// A flag-disabled layout falls back to the default rather than stranding
	// whoever had it saved on a view that no longer renders.
	if (value === "priority" && !PRIORITY_VIEW_ENABLED) {
		return "table";
	}
	return value;
}

export type RoadmapColumns = {
	stage: boolean;
	sync: boolean;
	size: boolean;
	/** Provenance chip (Manual, AI Update, Slack, Jira, …). */
	source: boolean;
	/** Status-flag badges (Needs more info, possible-duplicate, etc.). A
	 * reorderable, toggleable field like the rest — it positions the inline
	 * status-badge group, which defaults to right after the title. */
	flags: boolean;
	/** Fabric-internal custom tags column. */
	tags: boolean;
};

export type RoadmapColumnKey = keyof RoadmapColumns;

/** A reorderable card field: the always-on Title plus every optional column. */
export type RoadmapFieldKey = "title" | RoadmapColumnKey;

export const ROADMAP_COLUMN_LABELS: Record<RoadmapColumnKey, string> = {
	stage: "Drafting stage",
	sync: "PM sync state",
	size: "Size",
	source: "Source",
	flags: "Status flags",
	tags: "Tags",
};

/** Canonical left-to-right order of the card fields — Title first, then the
 * optional fields. Title is always shown but may be dragged to reorder. The
 * status-flag badges sit right after the title by default. */
export const DEFAULT_ROADMAP_COLUMN_ORDER: RoadmapFieldKey[] = [
	"title",
	"flags",
	"stage",
	"size",
	"source",
	"tags",
	"sync",
];

const DEFAULT_COLUMNS: RoadmapColumns = {
	stage: true,
	sync: true,
	size: true,
	source: true,
	tags: true,
	flags: true,
};

/** Coerce a stored order into a valid permutation of every column key: keep the
 * stored order, drop unknown keys, then slot any keys the stored value missed
 * into their CANONICAL position (right after their nearest default-order
 * neighbour that's present) rather than tacking them on at the end — so a newly
 * added column like "source" lands next to its default neighbours. */
function sanitizeOrder(stored: unknown): RoadmapFieldKey[] {
	const all = DEFAULT_ROADMAP_COLUMN_ORDER;
	if (!Array.isArray(stored)) {
		return [...all];
	}
	const hadTitle = stored.includes("title");
	const seen = new Set<RoadmapFieldKey>();
	const out: RoadmapFieldKey[] = [];
	for (const k of stored) {
		if ((all as string[]).includes(k) && !seen.has(k as RoadmapFieldKey)) {
			seen.add(k as RoadmapFieldKey);
			out.push(k as RoadmapFieldKey);
		}
	}
	for (let i = 0; i < all.length; i++) {
		const k = all[i];
		if (seen.has(k)) {
			continue;
		}
		// Insert after the nearest preceding default-order key already present.
		let insertAt = out.length;
		for (let j = i - 1; j >= 0; j--) {
			const predIdx = out.indexOf(all[j]);
			if (predIdx >= 0) {
				insertAt = predIdx + 1;
				break;
			}
		}
		out.splice(insertAt, 0, k);
		seen.add(k);
	}
	// Migrate orders persisted before Title was reorderable: keep it first
	// rather than appended at the end.
	if (!hadTitle) {
		const i = out.indexOf("title");
		if (i > 0) {
			out.splice(i, 1);
			out.unshift("title");
		}
	}
	return out;
}

type View = {
	mode: RoadmapViewMode;
	groupBy: RoadmapGroupBy;
	columns: RoadmapColumns;
	columnOrder: RoadmapFieldKey[];
	sort: RoadmapSort;
	// "Show hidden items" toggle. Persisted per user+project (like the rest of the
	// view) but applied + saved IMMEDIATELY on toggle — it's a toolbar control,
	// not a draft setting — so it never participates in the Save/Cancel draft.
	showClosed: boolean;
};

const DEFAULT_VIEW: View = {
	mode: "table",
	groupBy: "priority",
	columns: DEFAULT_COLUMNS,
	columnOrder: [...DEFAULT_ROADMAP_COLUMN_ORDER],
	sort: DEFAULT_ROADMAP_SORT,
	showClosed: false,
};

const STORAGE_KEY_PREFIX = "fabric:roadmap-view:";

function storageKey(projectId: string): string {
	return `${STORAGE_KEY_PREFIX}${projectId}`;
}

/** Coerce any stored/loaded partial value (localStorage OR the DB JSON column)
 * into a complete, valid View — unknown modes/groupings fall back to defaults
 * and the column order is sanitised into a full permutation. */
function coerceView(raw: unknown): View {
	if (!raw || typeof raw !== "object") {
		return DEFAULT_VIEW;
	}
	const parsed = raw as Partial<View>;
	return {
		mode: coerceMode(parsed.mode),
		groupBy: parsed.groupBy === "stage" ? "stage" : "priority",
		columns: { ...DEFAULT_COLUMNS, ...(parsed.columns ?? {}) },
		columnOrder: sanitizeOrder(parsed.columnOrder),
		// Sort is persisted like showClosed (immediate, per user + project).
		// Validate on read so a stale/deprecated key silently falls back to the
		// default instead of surfacing an error (card #1704, AC-4 + AC-6).
		sort: coerceSort(parsed.sort),
		showClosed: parsed.showClosed === true,
	};
}

function load(projectId: string): View {
	if (typeof window === "undefined") {
		return DEFAULT_VIEW;
	}
	try {
		const raw = window.localStorage.getItem(storageKey(projectId));
		if (!raw) {
			return DEFAULT_VIEW;
		}
		return coerceView(JSON.parse(raw));
	} catch {
		return DEFAULT_VIEW;
	}
}

function save(projectId: string, value: View): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(
			storageKey(projectId),
			JSON.stringify(value),
		);
	} catch {
		// ignore
	}
}

/** Structural equality for two views — drives the "unsaved changes" (dirty) flag. */
function viewsEqual(a: View, b: View): boolean {
	return (
		a.mode === b.mode &&
		a.groupBy === b.groupBy &&
		// sort is intentionally excluded — like showClosed it persists immediately
		// (not via the Save/Cancel draft), so changing it must never mark the
		// saved view as dirty.
		a.columns.stage === b.columns.stage &&
		a.columns.sync === b.columns.sync &&
		a.columns.size === b.columns.size &&
		a.columns.source === b.columns.source &&
		a.columns.tags === b.columns.tags &&
		a.columns.flags === b.columns.flags &&
		a.columnOrder.join() === b.columnOrder.join()
	);
}

/**
 * Roadmap view preferences with **draft-until-save** semantics, persisted
 * **per user + project in the database** (not browser-only — so a saved view
 * survives redeploys and follows the user across devices/browsers).
 *
 * Every setter mutates an in-memory `draft` so the roadmap previews the change
 * LIVE — the user can temporarily re-sort, re-group, or toggle fields while
 * working. Nothing is persisted until `commitView()` (the settings "Save"
 * button), which writes to the DB and refreshes a localStorage cache.
 * `revertView()` ("Cancel") discards the draft back to the last saved view, and
 * because only the saved view is persisted, a refresh or navigation restores
 * that same last-saved state — unsaved tweaks evaporate, exactly as a draft
 * should.
 *
 * Hydration is two-tier: the localStorage cache paints instantly (no flash of
 * defaults), then the authoritative DB copy reconciles when it arrives.
 */
export function useRoadmapView(
	projectId: string,
	organizationId?: string | null,
) {
	// `persisted` mirrors the last-saved view; `draft` is what renders.
	const [persisted, setPersisted] = useState<View>(() => load(projectId));
	const [draft, setDraft] = useState<View>(persisted);

	// Reloading the project (or first mount) resets both to the cached view.
	useEffect(() => {
		const loaded = load(projectId);
		setPersisted(loaded);
		setDraft(loaded);
	}, [projectId]);

	// Latest draft/persisted, readable synchronously (no stale closures).
	const draftRef = useRef(draft);
	useEffect(() => {
		draftRef.current = draft;
	}, [draft]);
	const persistedRef = useRef(persisted);
	useEffect(() => {
		persistedRef.current = persisted;
	}, [persisted]);

	// Authoritative saved view from the database (per user + project).
	const { data: dbData } = useQuery({
		...orpc.projects.roadmapView.get.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	// Reconcile the DB copy when it arrives: adopt it as the saved baseline and
	// refresh the localStorage cache. Only overwrite the live draft when the
	// user has NO unsaved edits, so an in-progress tweak is never clobbered.
	useEffect(() => {
		if (!dbData?.roadmapView) {
			return;
		}
		const dbView = coerceView(dbData.roadmapView);
		const hadUnsavedEdits = !viewsEqual(
			draftRef.current,
			persistedRef.current,
		);
		setPersisted(dbView);
		save(projectId, dbView);
		if (!hadUnsavedEdits) {
			setDraft(dbView);
		}
	}, [dbData, projectId]);

	const updateMutation = useMutation(
		orpc.projects.roadmapView.update.mutationOptions(),
	);

	const setMode = useCallback((mode: RoadmapViewMode) => {
		setDraft((prev) => ({ ...prev, mode }));
	}, []);

	const setGroupBy = useCallback((groupBy: RoadmapGroupBy) => {
		setDraft((prev) => ({ ...prev, groupBy }));
	}, []);

	const setColumns = useCallback((columns: RoadmapColumns) => {
		setDraft((prev) => ({ ...prev, columns }));
	}, []);

	const setColumnOrder = useCallback((columnOrder: RoadmapFieldKey[]) => {
		setDraft((prev) => ({
			...prev,
			columnOrder: sanitizeOrder(columnOrder),
		}));
	}, []);

	// Sort persists IMMEDIATELY on change (not draft-gated), mirroring
	// setShowClosed: update the live draft AND the saved baseline, then write to
	// the DB + localStorage cache. A sort change never participates in the
	// gear-menu Save/Cancel draft (it is excluded from viewsEqual).
	const setSort = useCallback(
		(sort: RoadmapSort) => {
			const next: View = { ...persistedRef.current, sort };
			setDraft((prev) => ({ ...prev, sort }));
			setPersisted(next);
			save(projectId, next);
			updateMutation.mutate({
				projectId,
				organizationId: organizationId ?? null,
				roadmapView: next,
			});
		},
		[projectId, organizationId, updateMutation],
	);

	// Show-hidden persists IMMEDIATELY on toggle (not draft-gated): update the
	// live draft AND the saved baseline, then write to the DB + localStorage cache.
	const setShowClosed = useCallback(
		(value: boolean) => {
			const next: View = {
				...persistedRef.current,
				showClosed: value,
			};
			setDraft((prev) => ({ ...prev, showClosed: value }));
			setPersisted(next);
			save(projectId, next);
			updateMutation.mutate({
				projectId,
				organizationId: organizationId ?? null,
				roadmapView: next,
			});
		},
		[projectId, organizationId, updateMutation],
	);
	const toggleShowClosed = useCallback(() => {
		setShowClosed(!draftRef.current.showClosed);
	}, [setShowClosed]);

	// Save: persist the live draft to the DB (survives redeploy, follows the
	// user) and refresh the localStorage cache so the next paint is instant.
	const commitView = useCallback(() => {
		const current = draftRef.current;
		save(projectId, current);
		setPersisted(current);
		updateMutation.mutate({
			projectId,
			organizationId: organizationId ?? null,
			roadmapView: current,
		});
	}, [projectId, organizationId, updateMutation]);

	// Cancel: drop unsaved edits, snapping the live view back to the saved one.
	const revertView = useCallback(() => {
		setDraft(persisted);
	}, [persisted]);

	const isViewDirty = useMemo(
		() => !viewsEqual(draft, persisted),
		[draft, persisted],
	);

	return {
		mode: draft.mode,
		groupBy: draft.groupBy,
		columns: draft.columns,
		columnOrder: draft.columnOrder,
		sort: draft.sort,
		setMode,
		setGroupBy,
		setColumns,
		setColumnOrder,
		setSort,
		showClosed: draft.showClosed,
		setShowClosed,
		toggleShowClosed,
		commitView,
		revertView,
		isViewDirty,
	};
}

/**
 * Per-user manual roadmap ordering (drag-to-reorder), persisted per user +
 * project so each teammate keeps their own sequence — the shared
 * `story.roadmapOrder` stays the default for stories a user hasn't placed.
 *
 * Reuses the same `roadmapView.get` query as {@link useRoadmapView} (React
 * Query dedupes by key, so this adds no extra request) and optimistically
 * merges a reordered bucket into the cached order so the list settles instantly
 * before the save round-trips.
 */
export function useRoadmapStoryOrder(
	projectId: string,
	organizationId?: string | null,
) {
	const queryClient = useQueryClient();
	const queryInput = { projectId, organizationId: organizationId ?? null };
	const queryKey = orpc.projects.roadmapView.get.queryKey({
		input: queryInput,
	});

	const { data } = useQuery({
		...orpc.projects.roadmapView.get.queryOptions({ input: queryInput }),
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});
	const orderMap: RoadmapStoryOrderMap | undefined =
		data?.roadmapStoryOrder ?? undefined;

	const reorderMutation = useMutation({
		...orpc.projects.roadmapView.reorderStoryOrder.mutationOptions(),
		onMutate: async (vars: {
			projectId: string;
			organizationId: string | null;
			orders: { storyId: string; order: number }[];
		}) => {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData(queryKey);
			queryClient.setQueryData(queryKey, (old) => {
				if (!old) {
					return old;
				}
				const merged: RoadmapStoryOrderMap = {
					...(old.roadmapStoryOrder ?? {}),
				};
				for (const o of vars.orders) {
					merged[o.storyId] = o.order;
				}
				return { ...old, roadmapStoryOrder: merged };
			});
			return { previous };
		},
		onError: (_err, _vars, context) => {
			queryClient.setQueryData(queryKey, context?.previous);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey });
		},
	});

	const reorderStories = useCallback(
		(orders: { storyId: string; order: number }[]) => {
			if (orders.length === 0) {
				return;
			}
			reorderMutation.mutate({
				projectId,
				organizationId: organizationId ?? null,
				orders,
			});
		},
		[reorderMutation, projectId, organizationId],
	);

	return { orderMap, reorderStories };
}
