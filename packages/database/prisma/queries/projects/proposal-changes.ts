/**
 * Typed reading of the `proposal` JSON a PendingBacklogProposal stores.
 *
 * The JSON is written by several analyzers over time, so every field is read
 * defensively here, once, and every caller works with `StoredProposalChange`.
 * Pure: no database access, so it can be used by any layer.
 */

import { createHash } from "node:crypto";

/** One entry of a stored proposal's `changes`, at its index. */
export interface StoredProposalChange {
	index: number;
	/** The stored entry; an empty object when it is not an object. */
	raw: Record<string, unknown>;
	action: "create" | "update";
	type: string | null;
	/** Proposed title (`title.to`, else `title.from`, else a bare string). */
	title: string;
	/** Proposed description (`description.to`, or a bare string). */
	description: string;
	/** Analysis-time body the description diff was computed against. */
	descriptionFrom: string | null;
	/** Analysis-time body the acceptance-criteria diff was computed against. */
	acceptanceCriteriaFrom: string | null;
	existingId: string | null;
	/** The target's identifier, stored or resolved after analysis. */
	identifier: string | null;
	reasoning: string | null;
}

export function asJsonRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTitle(title: unknown): string {
	if (typeof title === "string") {
		return title.trim();
	}
	const diff = asJsonRecord(title);
	return (
		nonEmpty(diff?.to) ??
		(typeof diff?.from === "string" ? diff.from.trim() : "")
	);
}

function readDescription(description: unknown): string {
	if (typeof description === "string") {
		return description.trim();
	}
	const to = asJsonRecord(description)?.to;
	return typeof to === "string" ? to.trim() : "";
}

/** `from` of a body diff that proposes a change; null otherwise. */
function readChangedFrom(field: unknown): string | null {
	const diff = asJsonRecord(field);
	return typeof diff?.from === "string" &&
		typeof diff.to === "string" &&
		diff.from !== diff.to
		? diff.from
		: null;
}

/** One stored change entry, read as the change at `index`. */
export function readStoredChangeEntry(
	raw: unknown,
	index: number,
): StoredProposalChange {
	const change = asJsonRecord(raw) ?? {};
	const resolution = asJsonRecord(change.targetResolution);
	return {
		index,
		raw: change,
		action: change.action === "update" ? "update" : "create",
		type: nonEmpty(change.type),
		title: readTitle(change.title),
		description: readDescription(change.description),
		descriptionFrom: readChangedFrom(change.description),
		acceptanceCriteriaFrom: readChangedFrom(change.acceptanceCriteria),
		existingId: nonEmpty(change.existingId),
		identifier:
			nonEmpty(change.existingIdentifier) ??
			nonEmpty(resolution?.resolvedIdentifier),
		reasoning:
			typeof change.reasoning === "string" ? change.reasoning : null,
	};
}

/** Every stored change of a proposal, in index order. */
export function readStoredProposalChanges(
	proposal: unknown,
): StoredProposalChange[] {
	const changes = asJsonRecord(proposal)?.changes;
	return Array.isArray(changes) ? changes.map(readStoredChangeEntry) : [];
}

/** The stored change at `index`, or null when there is none. */
export function readStoredProposalChange(
	proposal: unknown,
	index: number,
): StoredProposalChange | null {
	const changes = asJsonRecord(proposal)?.changes;
	return Array.isArray(changes) && index >= 0 && index < changes.length
		? readStoredChangeEntry(changes[index], index)
		: null;
}

/** Proposed acceptance criteria (`acceptanceCriteria.to`, or a bare string). */
export function proposedAcceptanceCriteria(
	change: StoredProposalChange,
): string {
	return readDescription(change.raw.acceptanceCriteria);
}

/** A titled create item: the only kind of item duplicate matching considers. */
export function isNewWorkChange(change: StoredProposalChange): boolean {
	return change.action === "create" && change.title !== "";
}

/**
 * The item a proposal's persisted draft belongs to: its first create that is
 * not an epic, the same rule the review dialog uses. -1 when there is none.
 */
export function primaryDraftChangeIndex(
	changes: readonly StoredProposalChange[],
): number {
	return changes.findIndex(
		(change) => change.action === "create" && change.type !== "epic",
	);
}

function sameBody(from: string, current: string | null | undefined): boolean {
	const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
	return normalize(from) === normalize(current ?? "");
}

/**
 * Whether an update's target no longer has the body its proposed diff was
 * computed against. Only fields whose diff carries a `from` are compared.
 */
export function targetChangedSinceProposal(
	change: Pick<
		StoredProposalChange,
		"descriptionFrom" | "acceptanceCriteriaFrom"
	>,
	current: {
		description: string | null | undefined;
		acceptanceCriteria: string | null | undefined;
	},
): boolean {
	return (
		(change.descriptionFrom !== null &&
			!sameBody(change.descriptionFrom, current.description)) ||
		(change.acceptanceCriteriaFrom !== null &&
			!sameBody(
				change.acceptanceCriteriaFrom,
				current.acceptanceCriteria,
			))
	);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const record = asJsonRecord(value);
	if (record) {
		const entries = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/**
 * Stable revision of a stored `proposal` JSON: equal for equal content
 * whatever the key order, different after any edit such as a merge.
 */
export function proposalRevision(proposal: unknown): string {
	return createHash("sha256").update(canonicalJson(proposal)).digest("hex");
}
