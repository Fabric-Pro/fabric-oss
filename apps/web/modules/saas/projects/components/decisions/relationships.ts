import type { DecisionStatus } from "./constants";

/**
 * Relationship resolution for the ADL.
 *
 * Decisions point at each other by soft row-id (`supersededById`,
 * `relatedDecisionIds`). The list already loads the project's decisions, so we
 * resolve human identifiers + the reverse "supersedes" direction entirely from
 * that in-memory set — no extra round-trips. The drawer reuses the same index.
 */

export interface RelRef {
	id: string;
	identifier: string;
	title: string;
	status: DecisionStatus;
}

export interface DecisionLite {
	id: string;
	identifier: string;
	title: string;
	status: DecisionStatus;
	supersededById?: string | null;
	relatedDecisionIds?: string[];
}

export interface RelationshipIndex {
	byId: Map<string, DecisionLite>;
	/** actor id → the records that name it as their `supersededById` (i.e. it supersedes them). */
	supersededByActor: Map<string, DecisionLite[]>;
}

export function buildRelationshipIndex(
	records: DecisionLite[],
): RelationshipIndex {
	const byId = new Map<string, DecisionLite>();
	const supersededByActor = new Map<string, DecisionLite[]>();
	for (const r of records) {
		byId.set(r.id, r);
	}
	for (const r of records) {
		if (r.supersededById && byId.has(r.supersededById)) {
			const list = supersededByActor.get(r.supersededById) ?? [];
			list.push(r);
			supersededByActor.set(r.supersededById, list);
		}
	}
	return { byId, supersededByActor };
}

function toRelRef(r: DecisionLite): RelRef {
	return {
		id: r.id,
		identifier: r.identifier,
		title: r.title,
		status: r.status,
	};
}

export type RelationshipKind = "Supersedes" | "Superseded by" | "Related";

/** The single relationship chip a card shows: supersedes › superseded by › related. */
export function primaryRelationship(
	rec: DecisionLite,
	index: RelationshipIndex,
): { kind: RelationshipKind; ref: RelRef } | null {
	const supersedes = index.supersededByActor.get(rec.id);
	if (supersedes && supersedes.length > 0) {
		return { kind: "Supersedes", ref: toRelRef(supersedes[0]) };
	}
	if (rec.supersededById) {
		const target = index.byId.get(rec.supersededById);
		if (target) {
			return { kind: "Superseded by", ref: toRelRef(target) };
		}
	}
	for (const id of rec.relatedDecisionIds ?? []) {
		const target = index.byId.get(id);
		if (target) {
			return { kind: "Related", ref: toRelRef(target) };
		}
	}
	return null;
}

/** Every relationship, grouped, for the detail drawer. */
export function allRelationships(rec: DecisionLite, index: RelationshipIndex) {
	const supersedes = (index.supersededByActor.get(rec.id) ?? []).map(
		toRelRef,
	);
	let supersededBy: RelRef | null = null;
	if (rec.supersededById) {
		const target = index.byId.get(rec.supersededById);
		supersededBy = target ? toRelRef(target) : null;
	}
	const related: RelRef[] = [];
	for (const id of rec.relatedDecisionIds ?? []) {
		const target = index.byId.get(id);
		if (target) {
			related.push(toRelRef(target));
		}
	}
	return { supersedes, supersededBy, related };
}
