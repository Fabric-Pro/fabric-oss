import type { AzureDevOpsSprintCaptureInput } from "../../src/azure-devops/sprint-selection";

export const target = { organization: "example-org", projectId: "project-1" };
export const project = { id: "project-1", name: "Example Project" };
export const asOf = "2026-01-01T12:00:00.0001234Z";
export const member = {
	uniqueName: "engineer@example.com",
	displayName: "Example Engineer",
};
export const other = {
	uniqueName: "other@example.com",
	displayName: "Other Engineer",
};
export const taskTypes = [
	"AA Task",
	"DevBE Task",
	"DevFE Task",
	"QA Task",
	"UAT Task",
	"Bug",
	"ToDo Task",
	"Task",
];
export const link = (
	id: number,
	rel = "System.LinkTypes.Hierarchy-Reverse",
) => ({
	rel,
	url: `https://dev.azure.com/example-org/_apis/wit/workItems/${id}`,
});
export interface FixtureItem {
	id: number;
	rev: number;
	fields: Record<string, unknown>;
	relations: { rel: string; url: string }[];
}
export function item(
	id: number,
	type: string,
	fields: Record<string, unknown> = {},
	relations: FixtureItem["relations"] = [],
): FixtureItem {
	return {
		id,
		rev: 7,
		relations,
		fields: {
			"System.TeamProject": project.name,
			"System.WorkItemType": type,
			"System.Title": `Item ${id}`,
			"System.State": "Active",
			"System.AssignedTo": member,
			"System.IterationPath": "Example Project\\Sprint 2",
			"System.ChangedDate": asOf,
			"System.Description": "TBD",
			"Custom.BusinessRules": `Full specification ${id}`,
			...fields,
		},
	};
}
export const options = (): AzureDevOpsSprintCaptureInput => ({
	assignee: { mode: "selected", uniqueName: member.uniqueName },
	targetStoryTypes: ["User Story"],
	requirementFields: ["System.Description", "Custom.BusinessRules"],
	maxStories: 50,
	selection: {
		iterationPaths: [
			"Example Project\\Sprint 2",
			"Example Project\\Sprint 1",
		],
		assignmentFields: ["System.AssignedTo", "Custom.Engineer"],
		assignedItemTypes: taskTypes,
		parentSourceTypes: taskTypes.filter((type) => type !== "ToDo Task"),
		relationKinds: ["child", "related"],
		excludedAssignedStates: ["Removed"],
	},
});
export const json = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
	});

export function sprintFixture(
	url: URL,
	init: RequestInit | undefined,
	items: ReadonlyMap<number, FixtureItem>,
	discoveryIds: readonly number[],
): unknown {
	if (url.pathname.includes("/_apis/projects/")) {
		return project;
	}
	if (url.pathname.endsWith("/fields/Custom.Engineer")) {
		return { referenceName: "Custom.Engineer", isIdentity: true };
	}
	if (url.pathname.endsWith("/wiql")) {
		const { query }: { query: string } = JSON.parse(String(init?.body));
		const after = Number(/\[System.Id\] > (\d+)/.exec(query)?.[1]);
		return {
			asOf,
			workItems: discoveryIds
				.filter((id) => {
					const iteration =
						items.get(id)?.fields["System.IterationPath"];
					return id > after && query.includes(`'${iteration}'`);
				})
				.slice(0, Number(url.searchParams.get("$top")))
				.map((id) => ({ id })),
		};
	}
	if (url.pathname.endsWith("/comments")) {
		const id = Number(/workItems\/(\d+)\/comments/.exec(url.pathname)?.[1]);
		return {
			totalCount: 1,
			count: 1,
			comments: [
				{
					id: 1,
					workItemId: id,
					version: 3,
					modifiedDate: asOf,
					text: `Item ${id} own PO answer`,
					isDeleted: false,
					format: "markdown",
				},
			],
		};
	}
	if (url.pathname.endsWith("/workitems")) {
		if (url.searchParams.has("fields") && url.searchParams.has("$expand")) {
			return new Response(null, { status: 400 });
		}
		const ids = (url.searchParams.get("ids") ?? "").split(",").map(Number);
		return {
			value: ids.flatMap((id) => {
				const value = items.get(id);
				if (!value) {
					return [];
				}
				const requestedFields = url.searchParams
					.get("fields")
					?.split(",");
				return [
					{
						...value,
						fields: requestedFields
							? Object.fromEntries(
									requestedFields
										.filter((name) =>
											Object.hasOwn(value.fields, name),
										)
										.map((name) => [
											name,
											value.fields[name],
										]),
								)
							: value.fields,
						relations:
							url.searchParams.get("$expand") === "relations"
								? value.relations
								: undefined,
					},
				];
			}),
		};
	}
	throw new Error("Unexpected fixture route");
}
