import { z } from "zod";

const id = z.string().min(1).max(200);
const filtersSchema = z
	.array(
		z.strictObject({
			workspaceId: id,
			documentIds: z.array(id).max(1000).optional(),
		}),
	)
	.max(100);
export interface WorkspaceDocumentFilter {
	workspaceId: string;
	documentIds?: string[];
}
export interface WorkspaceSearchGroup {
	workspaceIds: string[];
	documentIds?: string[];
}

/** Empty/absent documentIds intentionally means every document in that selected workspace. */
export function readWorkspaceDocumentFilters(
	raw: unknown,
	workspaceIds: readonly string[],
): WorkspaceDocumentFilter[] {
	if (raw === undefined) {
		return [];
	}
	const parsed = filtersSchema.safeParse(raw);
	if (
		!parsed.success ||
		new Set(parsed.data.map((x) => x.workspaceId)).size !==
			parsed.data.length ||
		parsed.data.some(
			(x) =>
				x.documentIds &&
				new Set(x.documentIds).size !== x.documentIds.length,
		)
	) {
		throw new Error("Invalid saved workspace document selections.");
	}
	// Deselecting a workspace retains its draft filter for a future re-selection; it grants no access now.
	return parsed.data.filter((x) => workspaceIds.includes(x.workspaceId));
}

/** Per-workspace intersections must never become an empty array (the vector API treats [] as unrestricted). */
export function workspaceSearchGroups(
	workspaceIds: readonly string[],
	raw: unknown,
	requestedDocumentIds?: readonly string[],
): WorkspaceSearchGroup[] {
	const selected = [...new Set(workspaceIds)];
	const filters = readWorkspaceDocumentFilters(raw, selected);
	const requested = requestedDocumentIds?.length
		? [...new Set(requestedDocumentIds)]
		: undefined;
	const groups: WorkspaceSearchGroup[] = [];
	const whole: string[] = [];
	for (const workspaceId of selected) {
		const filter = filters.find(
			(x) => x.workspaceId === workspaceId,
		)?.documentIds;
		const bounded = filter?.length
			? filter.filter((x) => !requested || requested.includes(x))
			: undefined;
		if (bounded) {
			if (bounded.length) {
				groups.push({
					workspaceIds: [workspaceId],
					documentIds: bounded,
				});
			}
		} else {
			whole.push(workspaceId);
		}
	}
	if (whole.length) {
		groups.push({
			workspaceIds: whole,
			...(requested ? { documentIds: requested } : {}),
		});
	}
	return groups;
}
