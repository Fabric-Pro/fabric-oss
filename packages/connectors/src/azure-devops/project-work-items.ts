import {
	AzureDevOpsProjectReadError,
	type AzureDevOpsProjectTarget,
	listField,
	pathSegment,
	projectReader,
	ReadBudgetExceeded,
	record,
	stringField,
	wiqlLiteral,
} from "./project-read";

export {
	AzureDevOpsProjectReadError,
	type AzureDevOpsProjectTarget,
	azureDevOpsOrganization,
} from "./project-read";

export interface AzureDevOpsProjectMember {
	id: string;
	uniqueName: string;
	displayName: string;
}

/** Enumerates project teams, not just people who happen to have assigned work. */
export async function listAzureDevOpsProjectMembers(
	target: AzureDevOpsProjectTarget,
	pat: string,
) {
	const read = projectReader(target, pat);
	const project = encodeURIComponent(target.projectId);
	const members = new Map<string, AzureDevOpsProjectMember>();
	const teams = new Set<string>();
	let complete = true;
	try {
		for (let skip = 0; ; skip += 100) {
			const body = await read(`_apis/projects/${project}/teams`, {
				$top: "100",
				$skip: String(skip),
			});
			const page = listField(body.value);
			for (const raw of page) {
				teams.add(pathSegment(record(raw).id));
			}
			if (page.length < 100) {
				break;
			}
		}
		for (const team of teams) {
			for (let skip = 0; ; skip += 100) {
				const body = await read(
					`_apis/projects/${project}/teams/${team}/members`,
					{ $top: "100", $skip: String(skip) },
				);
				const page = listField(body.value);
				for (const raw of page) {
					const identity = record(record(raw).identity);
					if (
						identity.isContainer === true ||
						identity.isDeletedInOrigin === true
					) {
						continue;
					}
					if (
						typeof identity.uniqueName !== "string" ||
						!identity.uniqueName
					) {
						complete = false;
						continue;
					}
					const member = {
						id: stringField(identity.id),
						uniqueName: stringField(identity.uniqueName),
						displayName: stringField(identity.displayName),
					};
					members.set(member.id, member);
				}
				if (page.length < 100) {
					break;
				}
			}
		}
	} catch (error) {
		if (!(error instanceof ReadBudgetExceeded)) {
			throw error;
		}
		complete = false;
	}
	return {
		members: [...members.values()].sort(
			(a, b) =>
				a.displayName.localeCompare(b.displayName) ||
				a.id.localeCompare(b.id),
		),
		complete,
		membershipScope: "project_teams" as const,
	};
}

/** Counts ID pages at one ADO snapshot. A budget limit returns lower bounds, never exact totals. */
export async function getAzureDevOpsProjectWorkItemCounts(
	target: AzureDevOpsProjectTarget,
	pat: string,
	filters: { state: string; assignee?: string },
) {
	const stateLiteral = wiqlLiteral(filters.state);
	const assigneeLiteral =
		filters.assignee === undefined
			? undefined
			: wiqlLiteral(filters.assignee);
	const read = projectReader(target, pat);
	let asOf: string | null = null;
	const pageSize = 2_000;
	async function count(state?: string) {
		let observed = 0;
		let after = 0;
		try {
			for (let page = 0; page < 20; page++) {
				const predicates = [
					"[System.TeamProject] = @project",
					`[System.Id] > ${after}`,
				];
				if (state !== undefined) {
					predicates.push(`[System.State] = ${stateLiteral}`);
				}
				if (assigneeLiteral !== undefined) {
					predicates.push(`[System.AssignedTo] = ${assigneeLiteral}`);
				}
				const query = `SELECT [System.Id] FROM WorkItems WHERE ${predicates.join(" AND ")} ORDER BY [System.Id] ASC${asOf ? ` ASOF ${wiqlLiteral(asOf)}` : ""}`;
				const body = await read(
					`${encodeURIComponent(target.projectId)}/_apis/wit/wiql`,
					{ $top: String(pageSize), timePrecision: "true" },
					query,
				);
				const responseAsOf = stringField(body.asOf);
				if (
					!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/i.test(
						responseAsOf,
					) ||
					!Number.isFinite(Date.parse(responseAsOf)) ||
					(asOf && responseAsOf !== asOf)
				) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				asOf ??= responseAsOf;
				const ids = listField(body.workItems).map(
					(item) => record(item).id,
				);
				for (const id of ids) {
					if (
						typeof id !== "number" ||
						!Number.isSafeInteger(id) ||
						id <= after
					) {
						throw new AzureDevOpsProjectReadError(
							"invalid_response",
						);
					}
					after = id;
				}
				observed += ids.length;
				if (ids.length < pageSize) {
					return { observed, complete: true };
				}
			}
		} catch (error) {
			if (!(error instanceof ReadBudgetExceeded)) {
				throw error;
			}
		}
		return { observed, complete: false };
	}
	const total = await count();
	const matchingState = await count(filters.state);
	return {
		state: filters.state,
		assignee: filters.assignee ?? null,
		asOf,
		total: total.complete ? total.observed : null,
		matchingState: matchingState.complete ? matchingState.observed : null,
		complete: total.complete && matchingState.complete,
		observed: {
			total: total.observed,
			matchingState: matchingState.observed,
		},
	};
}
