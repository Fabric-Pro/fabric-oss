import { db } from "@repo/database";
import {
	type GitHubPMListItem,
	listGitHubProjectItemsForPM,
	parseGitHubExternalId,
} from "@repo/integrations/github/projects-pm-adapter";
import { logger } from "@repo/logs";
import {
	requireGitHubProjectsSource,
	rethrowGitHubProjectsError,
} from "../../../lib/github-projects-pm-source";
import type {
	PMTicketListError,
	PMTicketListNote,
} from "./list-pm-tickets-filters.types";

/** Board items read per listing: the adapter walks 100 per GraphQL page. */
const GITHUB_FETCH_MAX_ITEMS = 2000;

/** Issue number of an item id, null for a draft. */
function issueNumberOf(id: string): number | null {
	try {
		const ref = parseGitHubExternalId(id);
		return ref.kind === "issue" ? ref.number : null;
	} catch {
		return null;
	}
}

/**
 * List the issues and draft items on a project's GitHub Projects board for
 * the Pull-from-PM dialog. Same contract as the GitLab list: already-imported
 * items hidden (unless asked for), search over id and title, in-memory
 * pagination. The ids filter matches issue numbers on the board.
 */
export async function handleGitHubProjectsList(args: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	project: {
		projectManagementContainerId: string | null;
		projectManagementAdditionalContext: unknown;
	};
	input: {
		page: number;
		pageSize: number;
		search?: string;
		filters?: { ids?: number[] };
		includeAlreadySynced: boolean;
	};
}): Promise<{
	tickets: Array<{
		id: string;
		displayId: string;
		title: string;
		workItemType?: string;
		state?: string;
		alreadySynced: boolean;
	}>;
	total: number;
	totalOnBoard: number;
	alreadySynced: number;
	page: number;
	pageSize: number;
	hasNextPage: boolean;
	notes: PMTicketListNote[];
	errors: PMTicketListError[];
}> {
	const { projectId, input } = args;
	const source = await requireGitHubProjectsSource({
		userId: args.userId,
		organizationId: args.organizationId,
		project: args.project,
	});

	const existingRows = await db.userStory.findMany({
		where: { projectId, externalId: { not: null } },
		select: { externalId: true },
	});
	const existingExternalIds = new Set(
		existingRows
			.map((r) => r.externalId?.trim())
			.filter((id): id is string => !!id),
	);

	let allRaw: GitHubPMListItem[];
	try {
		allRaw = (
			await listGitHubProjectItemsForPM({
				source,
				page: 1,
				pageSize: 100,
			}).then(async (first) => {
				// The adapter slices one page; walk until a short page.
				const items = [...first.items];
				let page = 2;
				let last = first.items.length;
				while (last === 100 && items.length < GITHUB_FETCH_MAX_ITEMS) {
					const next = await listGitHubProjectItemsForPM({
						source,
						page,
						pageSize: 100,
					});
					items.push(...next.items);
					last = next.items.length;
					page++;
				}
				return { items };
			})
		).items;
	} catch (error) {
		logger.warn("pm.tickets.list.github_failed", {
			projectId,
			reason: error instanceof Error ? error.message : String(error),
		});
		return rethrowGitHubProjectsError(error);
	}

	const notes: PMTicketListNote[] = [];
	const errors: PMTicketListError[] = [];
	const requestedIds = input.filters?.ids ?? [];
	if (requestedIds.length > 0) {
		const wanted = new Set(requestedIds);
		const onBoard = allRaw.filter((item) => {
			const n = issueNumberOf(item.id);
			return n !== null && wanted.has(n);
		});
		const found = new Set(onBoard.map((item) => issueNumberOf(item.id)));
		for (const id of requestedIds) {
			if (!found.has(id)) {
				errors.push({ kind: "not_found", id });
			}
		}
		if (!input.includeAlreadySynced) {
			for (const item of onBoard) {
				const n = issueNumberOf(item.id);
				if (n !== null && existingExternalIds.has(item.id)) {
					notes.push({ kind: "already_imported", id: n });
				}
			}
		}
		allRaw = onBoard;
	}

	const totalOnBoard = allRaw.length;
	let allItems = input.includeAlreadySynced
		? allRaw
		: allRaw.filter((item) => !existingExternalIds.has(item.id));
	if (input.search?.trim()) {
		const q = input.search.trim().toLowerCase();
		allItems = allItems.filter(
			(item) =>
				item.displayId.toLowerCase().includes(q) ||
				item.title.toLowerCase().includes(q),
		);
	}

	const total = allItems.length;
	const { page, pageSize } = input;
	const start = (page - 1) * pageSize;
	return {
		tickets: allItems.slice(start, start + pageSize).map((item) => ({
			id: item.id,
			displayId: item.displayId,
			title: item.title,
			workItemType: item.workItemType,
			state: item.status ?? item.state,
			alreadySynced: existingExternalIds.has(item.id),
		})),
		total,
		totalOnBoard,
		alreadySynced: existingExternalIds.size,
		page,
		pageSize,
		hasNextPage: start + pageSize < total,
		notes,
		errors,
	};
}
