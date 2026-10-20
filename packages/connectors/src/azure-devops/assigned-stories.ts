import {
	AzureDevOpsProjectReadError,
	type AzureDevOpsProjectTarget,
	captureIncompleteReason,
	dateField,
	listField,
	pathSegment,
	positiveInteger,
	ReadBudgetExceeded,
	readCanonicalProject,
	record,
	storyProjectReader,
	wiqlLiteral,
} from "./project-read";

export type AzureDevOpsStoryAssignee =
	| { mode: "current" }
	| { mode: "selected"; uniqueName: string };

export interface AzureDevOpsAssignedStoriesInput {
	assignee: AzureDevOpsStoryAssignee;
	workItemTypes?: readonly string[];
	cursor?: { afterId: number; requirementsAsOf: string };
	limit?: number;
}

/** Fixed WIQL only. @Me identifies the connection's principal, never a Fabric email. */
export async function listAzureDevOpsAssignedStories(
	target: AzureDevOpsProjectTarget,
	pat: string,
	input: AzureDevOpsAssignedStoriesInput,
) {
	const types = input.workItemTypes ?? ["User Story"];
	const limit = input.limit ?? 1_000;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 1_000 ||
		types.length === 0 ||
		types.length > 20 ||
		types.some((type) => !type.trim() || type.length > 128) ||
		(input.assignee.mode === "selected" &&
			(!input.assignee.uniqueName.trim() ||
				input.assignee.uniqueName.length > 512))
	) {
		throw new AzureDevOpsProjectReadError("invalid_filter");
	}
	const typeLiterals = types.map(wiqlLiteral);
	const assignee =
		input.assignee.mode === "current"
			? "@Me"
			: wiqlLiteral(input.assignee.uniqueName);
	let afterId = input.cursor ? positiveInteger(input.cursor.afterId) : 0;
	let requirementsAsOf = input.cursor
		? dateField(input.cursor.requirementsAsOf)
		: null;
	const ids: number[] = [];
	const read = storyProjectReader(target, pat);
	try {
		const project = await readCanonicalProject(read, target);
		for (let page = 0; page < 6; page++) {
			const top = Math.min(200, limit - ids.length || 1);
			const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = ${assignee} AND [System.WorkItemType] IN (${typeLiterals.join(", ")}) AND [System.Id] > ${afterId} ORDER BY [System.Id] ASC${requirementsAsOf ? ` ASOF ${wiqlLiteral(requirementsAsOf)}` : ""}`;
			const body = await read(
				`${pathSegment(project.id)}/_apis/wit/wiql`,
				{ $top: String(top), timePrecision: "true" },
				query,
			);
			const responseAsOf = dateField(body.asOf);
			if (requirementsAsOf && responseAsOf !== requirementsAsOf) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			requirementsAsOf ??= responseAsOf;
			const pageIds = listField(body.workItems).map((item) =>
				positiveInteger(record(item).id),
			);
			if (pageIds.length > top) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			for (const id of pageIds) {
				if (id <= afterId) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				if (ids.length === limit) {
					throw new ReadBudgetExceeded("item_limit");
				}
				ids.push(id);
				afterId = id;
			}
			if (pageIds.length < top) {
				return {
					ids,
					requirementsAsOf,
					complete: true,
					incompleteReason: null,
					cursor: null,
				};
			}
		}
		throw new ReadBudgetExceeded("page_limit");
	} catch (error) {
		return {
			ids,
			requirementsAsOf,
			complete: false,
			incompleteReason: captureIncompleteReason(error),
			cursor:
				requirementsAsOf && afterId > 0
					? { afterId, requirementsAsOf }
					: null,
		};
	}
}
