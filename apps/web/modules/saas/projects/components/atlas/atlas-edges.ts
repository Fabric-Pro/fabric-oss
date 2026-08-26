/**
 * Shared, runtime-light helpers for EDITABLE CONNECTIONS (edge overrides) across
 * the Atlas solo graph and the multi-repo System map.
 *
 * Edge colours resolve to CSS-variable design tokens (`var(--primary)` …) so they
 * theme correctly in light AND dark and never hardcode a hex value (see CLAUDE.md
 * "Design system"). The solo and System map share ONE colour vocabulary here so
 * the connections list / edge panel read identically in both hosts.
 */
import type { SystemCrossEdgeKind, AtlasEdgeKind } from "@repo/atlas/types";

/**
 * The four cross-repo relationship kinds (System map). Mirrors
 * `CROSS_EDGE_COLOR` in `AtlasSystemMap`, lifted here so the connections
 * list + edge panel reuse the exact same token map without importing the canvas.
 */
const SYSTEM_EDGE_KIND_COLOR: Record<SystemCrossEdgeKind, string> = {
	CALLS_API: "var(--primary)",
	DEPENDS_ON: "var(--highlight)",
	SHARES_LIBRARY: "var(--secondary)",
	RELATES_TO: "var(--muted-foreground)",
};

/** Ordered cross-repo kinds for the "New connection" kind picker + legend order. */
export const SYSTEM_EDGE_KINDS: SystemCrossEdgeKind[] = [
	"CALLS_API",
	"DEPENDS_ON",
	"SHARES_LIBRARY",
	"RELATES_TO",
];

/** Ordered solo intra-repo edge kinds for the "New connection" kind picker. */
export const SOLO_EDGE_KINDS: AtlasEdgeKind[] = [
	"CONTAINS",
	"IMPORTS",
	"DEPENDS_ON",
	"COVERS",
	"RELATES_TO",
];

/**
 * Per-kind colour token for the five solo intra-repo edge kinds. Each kind reads
 * in a DISTINCT design-system token (no hardcoded hex) so the solo graph can
 * colour its connections by kind and the legend can key them — mirroring how the
 * System map colours its cross-repo relationships. Only ~2–3 kinds appear per
 * lens (TECHNICAL → mostly DEPENDS_ON/IMPORTS/CONTAINS; BUSINESS → RELATES_TO),
 * so the canvas never becomes a rainbow.
 *
 * `DEPENDS_ON` deliberately reuses `--highlight` (matching the System map's
 * `DEPENDS_ON`) and `RELATES_TO` reuses `--muted-foreground` (matching the System
 * map's `RELATES_TO`) so the shared kinds read consistently across both hosts.
 */
const SOLO_EDGE_KIND_COLOR: Record<AtlasEdgeKind, string> = {
	CONTAINS: "var(--muted-foreground)",
	IMPORTS: "var(--secondary)",
	DEPENDS_ON: "var(--highlight)",
	COVERS: "var(--primary)",
	RELATES_TO: "var(--muted-foreground)",
};

/**
 * Display colour token for ANY edge kind (solo or cross). Cross-repo kinds keep
 * their per-kind hue from `SYSTEM_EDGE_KIND_COLOR`; solo intra-repo kinds resolve
 * to their per-kind token from `SOLO_EDGE_KIND_COLOR`. An unknown kind falls back
 * to the neutral `--primary` (the solo graph's highlighted-edge stroke).
 */
export function edgeKindColorVar(kind: string): string {
	if (kind in SYSTEM_EDGE_KIND_COLOR) {
		return SYSTEM_EDGE_KIND_COLOR[kind as SystemCrossEdgeKind];
	}
	if (kind in SOLO_EDGE_KIND_COLOR) {
		return SOLO_EDGE_KIND_COLOR[kind as AtlasEdgeKind];
	}
	return "var(--primary)";
}

/**
 * Maps a solo edge enum to the camelCase i18n keys under
 * `…atlas.node.edgeKind` (reused, not duplicated). Returns null for an
 * unknown value so the caller can fall back to the raw kind string.
 */
export function soloEdgeKindKey(
	kind: string,
): "contains" | "imports" | "dependsOn" | "covers" | "relatesTo" | null {
	switch (kind) {
		case "CONTAINS":
			return "contains";
		case "IMPORTS":
			return "imports";
		case "DEPENDS_ON":
			return "dependsOn";
		case "COVERS":
			return "covers";
		case "RELATES_TO":
			return "relatesTo";
		default:
			return null;
	}
}

/**
 * The endpoint selector the edge mutations take. `repositoryIntegrationId` is null
 * for the project's legacy/default repo. For the solo graph BOTH endpoints share
 * the host's `repositoryIntegrationId`; in the System map each endpoint resolves
 * from its `SystemGraphNode`.
 */
export interface EdgeEndpoints {
	sourceRepositoryIntegrationId: string | null;
	sourceKey: string;
	targetRepositoryIntegrationId: string | null;
	targetKey: string;
}

/**
 * A normalised connection row shared by the solo + System connections list. The
 * host adapts its own edge type (GraphEdge / SystemGraphEdge) into this shape and
 * supplies a `resolveEndpoints` so the list/panel stay host-agnostic.
 */
export interface ConnectionRow {
	/** Stable React key for the row (host-unique). */
	id: string;
	kind: string;
	sourceLabel: string;
	targetLabel: string;
	description: string | null;
	isManual: boolean;
	isUserDescription: boolean;
	deleted: boolean;
	/**
	 * The endpoint selector for this edge, or null when the edge isn't
	 * user-editable (e.g. a System-map repo-group endpoint) — such rows render
	 * read-only with no select / delete affordance.
	 */
	endpoints: EdgeEndpoints | null;
}

/** A pickable node for the "New connection" source/target selects. */
export interface ConnectionNodeOption {
	/** The endpoint key used in the mutation selector. */
	key: string;
	label: string;
	/** Owning repo integration id (null = legacy/default repo). Solo = the host's. */
	repositoryIntegrationId: string | null;
}
