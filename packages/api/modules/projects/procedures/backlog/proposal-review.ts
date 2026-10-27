import { ORPCError } from "@orpc/server";
import type { ProposalReviewEntryInput } from "@repo/database";
import {
	type ChangeItem,
	type PmSyncOverride,
	resolveProposalChangeIndex,
} from "./change-item-schema";

// Bounds client-sent positions and offered lists so they fit the int review
// columns. Set well above any real proposal: `approvedChanges` itself has no
// length cap, and a lower bound here would reject an apply that worked before.
export const PROPOSAL_REVIEW_MAX_CHANGES = 10_000;
const OFFERED_TITLE_MAX_LENGTH = 500;

export interface OfferedChange {
	action: "create" | "update";
	type: "epic" | "feature" | "story" | "bug";
	title: string;
}

function validateIndexes(
	offeredCount: number,
	selectedCount: number,
	indexes: number[],
) {
	if (
		indexes.length !== selectedCount ||
		new Set(indexes).size !== indexes.length ||
		indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= offeredCount)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Approved change indexes must be unique, in bounds, and match the submitted changes.",
		});
	}
}

/** Explicit positions identify edited changes; content matching supports older clients. */
export function resolveApprovedChangeIndexes(
	offered: ChangeItem[],
	selected: ChangeItem[],
	indexes?: number[],
	matches?: (stored: ChangeItem, submitted: ChangeItem) => boolean,
): number[] {
	if (indexes !== undefined) {
		validateIndexes(offered.length, selected.length, indexes);
		return indexes;
	}
	const used = new Set<number>();
	return selected.map((change) => {
		const index = matches
			? offered.findIndex((c, i) => !used.has(i) && matches(c, change))
			: (() => {
					const available = offered
						.map((c, i) => ({ c, i }))
						.filter(({ i }) => !used.has(i));
					const found = resolveProposalChangeIndex(
						available.map(({ c }) => c),
						change,
					);
					return available[found]?.i ?? -1;
				})();
		if (index < 0)
			throw new ORPCError("BAD_REQUEST", {
				message: `Approved change "${change.title.to}" not found in proposal — it may be stale. Re-open the proposal.`,
			});
		used.add(index);
		return index;
	});
}

export function buildProposalReviewEntries(
	offered: ChangeItem[],
	selected: ChangeItem[],
	indexes: number[],
	overrides?: Record<string | number, PmSyncOverride>,
): ProposalReviewEntryInput[] {
	return offered.map((_change, offeredIndex) => {
		const position = indexes.indexOf(offeredIndex);
		return position < 0
			? { offeredIndex, changeIndex: offeredIndex, selected: false }
			: {
					offeredIndex,
					changeIndex: offeredIndex,
					selected: true,
					change: selected[position],
					pmSyncOverride: overrides?.[position],
				};
	});
}

export function buildSidebarReviewEntries(
	selected: ChangeItem[],
	indexes?: number[],
	offered?: OfferedChange[],
	overrides?: Record<string | number, PmSyncOverride>,
): ProposalReviewEntryInput[] {
	if (!offered) {
		// Old clients only supplied selected changes. Their stored row is approved-only.
		if (indexes)
			validateIndexes(
				PROPOSAL_REVIEW_MAX_CHANGES + 1,
				selected.length,
				indexes,
			);
		return selected.map((change, position) => ({
			offeredIndex: indexes?.[position] ?? position,
			changeIndex: position,
			selected: true,
			change,
			pmSyncOverride: overrides?.[position],
		}));
	}
	if (!indexes)
		throw new ORPCError("BAD_REQUEST", {
			message: "Offered changes require approved change indexes.",
		});
	resolveApprovedChangeIndexes(
		offered.map((c) => ({ ...c, title: { to: c.title } })),
		selected,
		indexes,
	);
	return offered.map((change, offeredIndex) => {
		const position = indexes.indexOf(offeredIndex);
		return position < 0
			? {
					offeredIndex,
					changeIndex: null,
					selected: false,
					change: {
						...change,
						title: change.title.slice(0, OFFERED_TITLE_MAX_LENGTH),
					},
				}
			: {
					offeredIndex,
					changeIndex: position,
					selected: true,
					change: selected[position],
					pmSyncOverride: overrides?.[position],
				};
	});
}
