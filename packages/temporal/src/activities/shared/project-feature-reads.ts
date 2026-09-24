/**
 * Shared implementation of the chat's live roadmap reads,
 * `fabric_list_project_features` and `fabric_get_project_feature`.
 *
 * Both chat engines bind them — Direct through the built-in tool factory, the
 * orchestrator through the Fabric catalog adapter — so the access rule, the
 * filters and the response shape live here once. Without them the chat could
 * only answer a roadmap question from a fixed top-15 prompt snapshot (Direct)
 * or from semantic search over embedded contexts (orchestrator): feature #16,
 * "everything In Review" and a feature's acceptance criteria were unanswerable
 * (Fizzy #2309/#2310).
 *
 * The queries are the ones the external MCP gateway's `fabric_list_features` /
 * `fabric_get_feature` use (`listStorySummaries`, `getStoryById`), behind the
 * same session-path access rule, `getProjectAccessContext`. The names differ
 * from the gateway's on purpose: a user who has connected Fabric's own MCP
 * server exposes those names too, and the orchestrator keys discovered tools
 * by bare name — a shared name would route chat-shaped arguments to the
 * gateway.
 *
 * The project is always the chat's attached project, never a model argument,
 * and there is no organization argument at all: the tenant comes from the
 * project itself. No organization-equality check is made against the chat's
 * organization, matching the gateway's browser-session path — an invited
 * project guest (ADR-018) works from their own organization on a project hosted
 * by another, and the app lets them read it.
 */

export const PROJECT_FEATURE_TOOL_IDS = [
	"fabric_list_project_features",
	"fabric_get_project_feature",
] as const;

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
const LIST_DESCRIPTION_CHARS = 200;
const DETAIL_TEXT_CHARS = 12_000;
const TASK_DESCRIPTION_CHARS = 300;

const PRIORITIES = ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"] as const;
const KINDS = ["FEATURE", "BUG"] as const;

type Priority = (typeof PRIORITIES)[number];
type Kind = (typeof KINDS)[number];

interface FeatureReadContext {
	projectId?: string;
	userId: string;
}

type FeatureReadError = { error: string };

const NO_PROJECT: FeatureReadError = {
	error: "No project is attached to this chat. Attach a project to read its roadmap.",
};
const NO_ACCESS: FeatureReadError = {
	error: "Project not found or access denied.",
};

function clamp(value: string | null | undefined, max: number): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function canReadProject(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const { getProjectAccessContext } = await import("@repo/database");
	return (await getProjectAccessContext(projectId, userId)) !== null;
}

export interface IdentifierCandidate {
	identifier: string;
	/** Set when the identifier alone does not say which kind it names. */
	kind?: Kind;
}

const PREFIX_KIND: Record<string, Kind> = {
	F: "FEATURE",
	US: "FEATURE",
	B: "BUG",
};

/**
 * Candidate identifiers for a user-typed reference, most specific first.
 * Identifiers are legacy prefixed ("F-040", "US-001", "B-002") or plain
 * decimal ("40"), and plain numbers are allocated from ONE per-project
 * sequence for features and bugs alike — so "40" alone does not say which
 * kind it is.
 *
 * - The reference exactly as typed always comes first.
 * - A prefix pins the kind: "F-001" reaches F-001 or a FEATURE numbered 1,
 *   never B-001 or a bug numbered 1.
 * - No prefix: plain numbers, then F-, then US-, then B-.
 */
export function featureIdentifierCandidates(
	ref: string,
): IdentifierCandidate[] {
	const trimmed = ref.trim();
	const match = trimmed.match(/^(F|B|US)?-?0*(\d+)$/i);
	if (!match) {
		return [{ identifier: trimmed }];
	}
	const prefix = match[1]?.toUpperCase();
	const digits = match[2];
	const padded = digits.padStart(3, "0");
	const prefixed = (p: string): IdentifierCandidate[] => [
		{ identifier: `${p}-${padded}` },
		{ identifier: `${p}-${digits}` },
	];
	const plain = (kind?: Kind): IdentifierCandidate[] => [
		{ identifier: digits, kind },
		{ identifier: padded, kind },
	];
	const ordered: IdentifierCandidate[] = prefix
		? [...prefixed(prefix), ...plain(PREFIX_KIND[prefix])]
		: [...plain(), ...prefixed("F"), ...prefixed("US"), ...prefixed("B")];
	const seen = new Set<string>();
	return [{ identifier: trimmed }, ...ordered].filter((candidate) => {
		const key = `${candidate.identifier.toLowerCase()}|${candidate.kind ?? ""}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/**
 * The row the first candidate names. The lookup returns every row any
 * candidate could match; taking the database's first hit instead let
 * "F-001" come back as bug B-001 on a project with no F-001.
 */
export function pickByCandidateOrder<
	T extends { identifier: string; kind: string },
>(rows: T[], candidates: IdentifierCandidate[]): T | undefined {
	for (const candidate of candidates) {
		const wanted = candidate.identifier.toLowerCase();
		const row = rows.find(
			(r) =>
				r.identifier.toLowerCase() === wanted &&
				(!candidate.kind || r.kind === candidate.kind),
		);
		if (row) {
			return row;
		}
	}
	return undefined;
}

function describeReference(ref: string): string {
	const prefix = ref
		.trim()
		.match(/^(F|B|US)-?\d/i)?.[1]
		?.toUpperCase();
	if (!prefix) {
		return "roadmap item";
	}
	return PREFIX_KIND[prefix] === "BUG" ? "bug" : "feature";
}

async function resolveStatusId(
	projectId: string,
	statusName: string,
): Promise<{ id: string } | { error: string }> {
	const { db } = await import("@repo/database");
	const statuses = await db.projectStoryStatus.findMany({
		where: { projectId },
		select: { id: true, name: true },
		orderBy: { order: "asc" },
	});
	const wanted = statusName.toLowerCase();
	const found = statuses.find(
		(status) => status.name.toLowerCase() === wanted,
	);
	if (found) {
		return { id: found.id };
	}
	return {
		error: `No status named "${statusName}" in this project. Valid statuses: ${statuses.map((s) => s.name).join(", ") || "none"}.`,
	};
}

interface ListTotals {
	total: number;
	/** Undefined when closed items were included rather than counted apart. */
	hiddenCount?: number;
	filtered: boolean;
	hasMore: boolean;
}

/**
 * One sentence stating what `total` already is. Given only the two numbers,
 * the model read "total 199, hiddenCount 8" as 191 visible — subtracting a
 * count the total never contained.
 */
function describeListTotals(totals: ListTotals): string {
	const items = (count: number) =>
		`${count} ${count === 1 ? "item" : "items"}`;
	const scope = totals.filtered ? " matching these filters" : "";
	const pages = totals.hasMore
		? " total covers every page, not just the items below."
		: "";
	if (totals.hiddenCount === undefined) {
		return `${items(totals.total)}${scope}, closed items included; declined items are never listed.${pages}`;
	}
	return `${items(totals.total)} on the roadmap${scope}; ${items(totals.hiddenCount)} closed and hidden, already excluded from total — report ${totals.total}, never subtract the hidden count.${pages}`;
}

type HiddenReason = "declined" | "closed";

const HIDDEN_REASON_BY_STAGE: Record<string, HiddenReason> = {
	DECLINED: "declined",
	CLOSED: "closed",
};

/**
 * Whether the roadmap page shows an item, and if not why. The list leaves
 * declined and closed items out, so a model that read one here and then did
 * not find it in the list concluded the item did not exist.
 */
function roadmapVisibility(
	identifier: string,
	draftingStage: string,
): Record<string, unknown> {
	const hiddenReason = HIDDEN_REASON_BY_STAGE[draftingStage];
	if (!hiddenReason) {
		return { onRoadmap: true };
	}
	const note =
		hiddenReason === "declined"
			? `${identifier} exists but was declined: the roadmap page and fabric_list_project_features never show declined items.`
			: `${identifier} exists but is closed: the roadmap page hides it until "Show hidden" is on, and fabric_list_project_features lists it only with includeHidden=true.`;
	return { onRoadmap: false, hiddenReason, note };
}

export async function listProjectFeatures(
	args: Record<string, unknown>,
	context: FeatureReadContext,
): Promise<Record<string, unknown> | FeatureReadError> {
	const { projectId, userId } = context;
	if (!projectId) {
		return NO_PROJECT;
	}
	if (!(await canReadProject(projectId, userId))) {
		return NO_ACCESS;
	}

	const priority = readString(args.priority);
	if (priority && !PRIORITIES.includes(priority as Priority)) {
		return {
			error: `priority must be one of ${PRIORITIES.join(", ")}.`,
		};
	}
	const kind = readString(args.kind);
	if (kind && !KINDS.includes(kind as Kind)) {
		return { error: `kind must be one of ${KINDS.join(", ")}.` };
	}

	const statusName = readString(args.status);
	let statusId: string | undefined;
	if (statusName) {
		const resolved = await resolveStatusId(projectId, statusName);
		if ("error" in resolved) {
			return resolved;
		}
		statusId = resolved.id;
	}

	const requestedLimit =
		typeof args.limit === "number" && Number.isFinite(args.limit)
			? Math.trunc(args.limit)
			: LIST_DEFAULT_LIMIT;
	const limit = Math.min(Math.max(requestedLimit, 1), LIST_MAX_LIMIT);
	const offset =
		typeof args.offset === "number" && Number.isFinite(args.offset)
			? Math.max(Math.trunc(args.offset), 0)
			: 0;

	const includeHidden = args.includeHidden === true;
	const filters = {
		projectId,
		statusId,
		priority: priority as Priority | undefined,
		kind: kind as Kind | undefined,
		search: readString(args.search),
	};

	const { db, listStorySummaries } = await import("@repo/database");
	// The roadmap's own set: declined items never show there, closed ones
	// only behind "Show hidden". Counting both silently made the total
	// disagree with the page.
	const [{ stories, total }, hidden] = await Promise.all([
		listStorySummaries({
			...filters,
			excludeDraftingStages: includeHidden
				? ["DECLINED"]
				: ["DECLINED", "CLOSED"],
			orderBy: "identifier",
			limit,
			offset,
		}),
		includeHidden
			? null
			: listStorySummaries({
					...filters,
					draftingStage: "CLOSED",
					limit: 1,
				}),
	]);

	// listStorySummaries deliberately loads no descriptions; one scoped query
	// adds the short summary the model needs to tell features apart.
	const descriptions = stories.length
		? await db.userStory.findMany({
				where: { projectId, id: { in: stories.map((s) => s.id) } },
				select: { id: true, description: true },
			})
		: [];
	const descriptionById = new Map(
		descriptions.map((row) => [row.id, row.description]),
	);

	const hasMore = offset + stories.length < total;
	return {
		summary: describeListTotals({
			total,
			hiddenCount: hidden?.total,
			filtered: Boolean(
				statusId || filters.priority || filters.kind || filters.search,
			),
			hasMore,
		}),
		features: stories.map((story) => ({
			id: story.id,
			identifier: story.identifier,
			title: story.title,
			kind: story.kind,
			status: story.status.name,
			priority: story.priority,
			draftingStage: story.draftingStage,
			tasks: `${story.completedTaskCount}/${story.taskCount} done`,
			description: clamp(
				descriptionById.get(story.id),
				LIST_DESCRIPTION_CHARS,
			),
		})),
		total,
		...(hidden ? { hiddenCount: hidden.total } : {}),
		hasMore,
	};
}

export async function getProjectFeature(
	args: Record<string, unknown>,
	context: FeatureReadContext,
): Promise<Record<string, unknown> | FeatureReadError> {
	const { projectId, userId } = context;
	if (!projectId) {
		return NO_PROJECT;
	}
	const ref = readString(args.feature);
	if (!ref) {
		return {
			error: "feature is required — pass an identifier such as F-040, or an id from fabric_list_project_features.",
		};
	}
	if (!(await canReadProject(projectId, userId))) {
		return NO_ACCESS;
	}

	if (/^TASK-?\d+$/i.test(ref)) {
		return {
			error: `"${ref}" is a task identifier, not a feature. Tasks are listed under their feature — find the feature with fabric_list_project_features and read it with fabric_get_project_feature.`,
		};
	}

	const { db, getStoryById } = await import("@repo/database");
	let story = await getStoryById(ref, projectId);
	if (!story) {
		const candidates = featureIdentifierCandidates(ref);
		const rows = await db.userStory.findMany({
			where: {
				projectId,
				OR: [...new Set(candidates.map((c) => c.identifier))].map(
					(identifier) => ({
						identifier: { equals: identifier, mode: "insensitive" },
					}),
				),
			},
			select: { id: true, identifier: true, kind: true },
		});
		const picked = pickByCandidateOrder(rows, candidates);
		story = picked ? await getStoryById(picked.id, projectId) : null;
	}
	if (!story) {
		return {
			error: `No ${describeReference(ref)} "${ref}" in this project. Use fabric_list_project_features to find it.`,
		};
	}

	const completed = story.tasks.filter((task) => task.isCompleted).length;
	return {
		id: story.id,
		identifier: story.identifier,
		title: story.title,
		kind: story.kind,
		...roadmapVisibility(story.identifier, story.draftingStage),
		status: story.status.name,
		statusIsFinal: story.status.isFinal,
		priority: story.priority,
		size: story.size,
		storyPoints: story.storyPoints,
		draftingStage: story.draftingStage,
		description: clamp(story.description, DETAIL_TEXT_CHARS),
		acceptanceCriteria: clamp(story.acceptanceCriteria, DETAIL_TEXT_CHARS),
		externalUrl: story.externalUrl,
		tasksSummary: `${completed}/${story.tasks.length} tasks done`,
		tasks: story.tasks.map((task) => ({
			identifier: task.identifier,
			title: task.title,
			isCompleted: task.isCompleted,
			description: clamp(task.description, TASK_DESCRIPTION_CHARS),
			subtasks: `${task.subtasks.filter((s) => s.isCompleted).length}/${task.subtasks.length} done`,
		})),
		updatedAt: story.updatedAt,
	};
}
