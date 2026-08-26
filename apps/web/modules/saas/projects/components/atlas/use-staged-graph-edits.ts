"use client";

/**
 * Shared local "draft" state for STRUCTURAL graph edits across the Atlas solo
 * graph and the multi-repo System map.
 *
 * The Atlas canvases stage structural changes locally instead of persisting them
 * immediately — node position moves, connection creates, and connection deletes
 * accumulate in this hook's React state, are OVERLAID on the server graph for
 * rendering, and only hit the server when the user presses Save. Navigating away
 * (unmount), switching the Business/Technical lens, or switching the selected
 * repo discards the draft naturally, because this is plain component state keyed
 * by the active context (see `contextKey`).
 *
 * What is NOT staged (handled directly by their own components, immediate):
 *   - Editing an existing connection's description (`AtlasEdgePanel`).
 *   - Restoring a previously-persisted, soft-deleted connection from the list.
 *
 * Identity model:
 *   - A pending POSITION is keyed by the React Flow node id (node `key` for solo,
 *     the namespaced id for the System map).
 *   - A pending CREATE carries a stable `id` (its endpoint signature) plus the
 *     `EdgeEndpoints`, a `kind`, an optional `description`, and the rendered RF
 *     source/target node ids so the overlay can draw a provisional edge.
 *   - A pending DELETE is the endpoint signature of a persisted edge.
 *
 * Re-adding a pending-deleted edge cancels the delete; deleting a pending-created
 * edge just drops it from the create list (it was never persisted).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EdgeEndpoints } from "./atlas-edges";

/** A staged (not-yet-persisted) connection create. */
interface PendingEdgeCreate {
	/** Stable identity = the endpoint signature (also dedupes against deletes). */
	id: string;
	endpoints: EdgeEndpoints;
	kind: string;
	description?: string;
	/** The rendered React Flow source/target node ids (so the overlay can draw it). */
	sourceNodeId: string;
	targetNodeId: string;
}

export interface StagedGraphEdits {
	/** Pending position moves, keyed by React Flow node id. */
	positions: Map<string, { x: number; y: number }>;
	/** Pending connection creates. */
	creates: PendingEdgeCreate[];
	/**
	 * Pending connection deletes, keyed by endpoint signature → the endpoints to
	 * delete on Save. A Map (not a Set) so Save has the endpoints AND the canvases
	 * can still `.has(signature)` to hide the edge.
	 */
	deletes: Map<string, EdgeEndpoints>;
	/** True when any structural change is staged. */
	isDirty: boolean;
	/** Total count of staged changes (positions + creates + deletes). */
	count: number;

	/** Commit one node's final dragged position into the pending set. */
	stagePosition: (id: string, position: { x: number; y: number }) => void;
	/** Commit several positions at once (e.g. a "Reset layout" recompute). */
	stagePositions: (
		entries: { id: string; position: { x: number; y: number } }[],
	) => void;
	/**
	 * Stage a new connection. If the same endpoint signature is currently a
	 * pending delete, the delete is cancelled instead (re-adding a removed edge).
	 * Returns true when a new create was staged (false when it un-deleted).
	 */
	stageCreate: (create: PendingEdgeCreate) => boolean;
	/**
	 * Edit a pending create's relationship kind and/or description in place (id =
	 * the endpoint signature). Used by the connection editor a draw / +New opens so
	 * the user can pick the type + description before saving.
	 */
	updateCreate: (
		id: string,
		patch: { kind?: string; description?: string },
	) => void;
	/**
	 * Stage a delete of the persisted edge with these endpoints. If the endpoint
	 * signature matches a pending CREATE, that create is dropped instead (it was
	 * never persisted, so there is nothing to delete on the server).
	 */
	stageDelete: (endpoints: EdgeEndpoints) => void;
	/** Drop a single pending create by its id (without persisting a delete). */
	removeCreate: (id: string) => void;
	/** Discard ALL pending changes (the Discard action / context switch). */
	discard: () => void;
}

/** Build the stable endpoint signature used to identify creates + deletes. */
export function endpointSignature(endpoints: EdgeEndpoints): string {
	return [
		endpoints.sourceRepositoryIntegrationId ?? "_",
		endpoints.sourceKey,
		endpoints.targetRepositoryIntegrationId ?? "_",
		endpoints.targetKey,
	].join("::");
}

/**
 * Stage structural graph edits for one active context.
 *
 * @param contextKey A string that changes when the underlying data/keys change
 * (lens switch, repo switch, fresh analysis). When it changes the draft is
 * discarded — switching context is treated as "leaving".
 */
export function useStagedGraphEdits(contextKey: string): StagedGraphEdits {
	const [positions, setPositions] = useState<
		Map<string, { x: number; y: number }>
	>(() => new Map());
	const [creates, setCreates] = useState<PendingEdgeCreate[]>([]);
	const [deletes, setDeletes] = useState<Map<string, EdgeEndpoints>>(
		() => new Map(),
	);

	// Discard the draft whenever the active context changes (lens / repo switch,
	// fresh analysis). The effect runs after the context value changes so a drag
	// on the OLD context never persists onto the NEW one.
	useEffect(() => {
		setPositions(new Map());
		setCreates([]);
		setDeletes(new Map());
	}, [contextKey]);

	const stagePosition = useCallback(
		(id: string, position: { x: number; y: number }) => {
			setPositions((prev) => {
				const next = new Map(prev);
				next.set(id, position);
				return next;
			});
		},
		[],
	);

	const stagePositions = useCallback(
		(entries: { id: string; position: { x: number; y: number } }[]) => {
			if (entries.length === 0) {
				return;
			}
			setPositions((prev) => {
				const next = new Map(prev);
				for (const entry of entries) {
					next.set(entry.id, entry.position);
				}
				return next;
			});
		},
		[],
	);

	const stageCreate = useCallback((create: PendingEdgeCreate): boolean => {
		let staged = true;
		// Re-adding a pending-deleted edge cancels the delete instead of creating.
		setDeletes((prev) => {
			if (prev.has(create.id)) {
				staged = false;
				const next = new Map(prev);
				next.delete(create.id);
				return next;
			}
			return prev;
		});
		setCreates((prev) => {
			if (!staged) {
				return prev;
			}
			// Idempotent: never stage the same endpoint pair twice.
			if (prev.some((c) => c.id === create.id)) {
				return prev;
			}
			return [...prev, create];
		});
		return staged;
	}, []);

	const updateCreate = useCallback(
		(id: string, patch: { kind?: string; description?: string }) => {
			setCreates((prev) => {
				if (!prev.some((c) => c.id === id)) {
					return prev;
				}
				return prev.map((c) =>
					c.id === id
						? {
								...c,
								kind: patch.kind ?? c.kind,
								description:
									patch.description !== undefined
										? patch.description
										: c.description,
							}
						: c,
				);
			});
		},
		[],
	);

	const stageDelete = useCallback((endpoints: EdgeEndpoints) => {
		const id = endpointSignature(endpoints);
		let wasPendingCreate = false;
		// Deleting a not-yet-saved create just drops it from the create list.
		setCreates((prev) => {
			if (prev.some((c) => c.id === id)) {
				wasPendingCreate = true;
				return prev.filter((c) => c.id !== id);
			}
			return prev;
		});
		setDeletes((prev) => {
			if (wasPendingCreate || prev.has(id)) {
				return prev;
			}
			const next = new Map(prev);
			next.set(id, endpoints);
			return next;
		});
	}, []);

	const removeCreate = useCallback((id: string) => {
		setCreates((prev) => prev.filter((c) => c.id !== id));
	}, []);

	const discard = useCallback(() => {
		setPositions(new Map());
		setCreates([]);
		setDeletes(new Map());
	}, []);

	const count = positions.size + creates.length + deletes.size;
	const isDirty = count > 0;

	return useMemo(
		() => ({
			positions,
			creates,
			deletes,
			isDirty,
			count,
			stagePosition,
			stagePositions,
			stageCreate,
			updateCreate,
			stageDelete,
			removeCreate,
			discard,
		}),
		[
			positions,
			creates,
			deletes,
			isDirty,
			count,
			stagePosition,
			stagePositions,
			stageCreate,
			updateCreate,
			stageDelete,
			removeCreate,
			discard,
		],
	);
}
