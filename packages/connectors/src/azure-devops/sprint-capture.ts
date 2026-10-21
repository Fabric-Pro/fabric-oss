import {
	type AzureDevOpsCaptureIncompleteReason,
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
	stringField,
	wiqlLiteral,
} from "./project-read";
import {
	type AzureDevOpsSprintAssignmentField,
	type AzureDevOpsSprintCaptureInput,
	type AzureDevOpsSprintRelationKind,
	normalizeSprintInput,
	sprintRelationItemId,
} from "./sprint-selection";
import { readStableStoryComments } from "./story-comments";
import {
	assignedTo,
	metadataFields,
	storyItemMetadata,
	validateItems,
} from "./story-items";
import type { AzureDevOpsStorySnapshot } from "./story-snapshots";

export interface AzureDevOpsSprintAssignedObservation {
	id: number;
	workItemType: string;
	state: string;
	assignedTo: AzureDevOpsStorySnapshot["assignedTo"];
	engineer: AzureDevOpsStorySnapshot["assignedTo"] | string;
	iterationPath: string;
	sourceUrl: string;
	discovery: {
		reason: "assignment_query";
		assignmentFields: AzureDevOpsSprintAssignmentField[];
		matchedAssignmentFields: AzureDevOpsSprintAssignmentField[] | null;
	};
	parentResolution:
		| "direct_story"
		| "parent_followed"
		| "parent_type_excluded"
		| "parent_source_excluded"
		| "no_parent";
	parentCandidates: { id: number; workItemType: string; included: boolean }[];
	storyIds: number[];
}

export interface AzureDevOpsSprintContextEdge {
	sourceId: number;
	targetId: number;
	kind: AzureDevOpsSprintRelationKind;
}

export interface AzureDevOpsSprintStoryCapture {
	story: AzureDevOpsStorySnapshot;
	discoverySources: { assignedItemId: number; kind: "direct" | "parent" }[];
	contextItems: AzureDevOpsStorySnapshot[];
	edges: AzureDevOpsSprintContextEdge[];
}

export type AzureDevOpsSprintIncompleteReason =
	| AzureDevOpsCaptureIncompleteReason
	| "story_limit"
	| "edge_limit"
	| "input_limit";

export interface AzureDevOpsSprintCapture {
	requirementsAsOf: string | null;
	assignedItems: AzureDevOpsSprintAssignedObservation[];
	/** Only the bounded assignment query has finished; graph capture can still fail. */
	discoveryComplete: boolean;
	stories: AzureDevOpsSprintStoryCapture[];
	complete: boolean;
	incompleteReason: AzureDevOpsSprintIncompleteReason | null;
	/** Known IDs requiring a new complete graph capture after any failure. */
	unreadItemIds: number[];
}

class SprintCaptureLimit extends Error {
	constructor(
		public readonly reason: "story_limit" | "edge_limit" | "input_limit",
	) {
		super("The Azure DevOps sprint capture exceeded its graph budget.");
	}
}

function itemId(value: unknown) {
	const id = positiveInteger(value);
	if (id > 2_147_483_647) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return id;
}

/** Fixed-origin sprint discovery; historical fields and stable current comments remain separate. */
export async function captureAzureDevOpsSprintStories(
	target: AzureDevOpsProjectTarget,
	pat: string,
	input: AzureDevOpsSprintCaptureInput,
): Promise<AzureDevOpsSprintCapture> {
	const config = normalizeSprintInput(input);
	const { selection, assignee } = config;
	const read = storyProjectReader(target, pat);
	const knownIds = new Set<number>();
	const assignedIds: number[] = [];
	const assignedItems: AzureDevOpsSprintAssignedObservation[] = [];
	let requirementsAsOf: string | null = null;
	let discoveryComplete = false;
	try {
		const project = await readCanonicalProject(read, target);
		const projectPath = pathSegment(project.id);
		const sourceUrl = (id: number) =>
			`https://dev.azure.com/${pathSegment(target.organization)}/${projectPath}/_workitems/edit/${id}`;
		const personFields = selection.assignmentFields.filter(
			(field) => field !== "System.AssignedTo",
		);
		if (assignee.mode === "current") {
			for (const name of personFields) {
				const field = await read(
					`${projectPath}/_apis/wit/fields/${pathSegment(name)}`,
					{},
				);
				if (field.referenceName !== name) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				if (field.isIdentity !== true || field.isDeleted === true) {
					throw new AzureDevOpsProjectReadError(
						"unsupported_current_predicate",
					);
				}
			}
		}
		const principal =
			assignee.mode === "current"
				? "@Me"
				: wiqlLiteral(assignee.uniqueName);
		const assignmentPredicate = selection.assignmentFields
			.map((field) => `[${field}] = ${principal}`)
			.join(" OR ");
		const literals = (values: readonly string[]) =>
			values.map(wiqlLiteral).join(", ");
		let afterId = 0;
		for (;;) {
			const top = Math.min(50, 100 - assignedIds.length || 1);
			const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] IN (${literals(selection.iterationPaths)}) AND [System.WorkItemType] IN (${literals(selection.assignedItemTypes)}) AND (${assignmentPredicate})${selection.excludedAssignedStates.length ? ` AND [System.State] NOT IN (${literals(selection.excludedAssignedStates)})` : ""} AND [System.Id] > ${afterId} ORDER BY [System.Id] ASC${requirementsAsOf ? ` ASOF ${wiqlLiteral(requirementsAsOf)}` : ""}`;
			const body = await read(
				`${projectPath}/_apis/wit/wiql`,
				{ $top: String(top), timePrecision: "true" },
				query,
			);
			const asOf = dateField(body.asOf);
			if (requirementsAsOf !== null && asOf !== requirementsAsOf) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			requirementsAsOf = asOf;
			const ids = listField(body.workItems).map((value) =>
				itemId(record(value).id),
			);
			if (ids.length > top) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			for (const id of ids) {
				if (id <= afterId) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				knownIds.add(id);
				if (knownIds.size > 100) {
					throw new ReadBudgetExceeded("item_limit");
				}
				assignedIds.push(id);
				afterId = id;
			}
			if (ids.length < top) {
				discoveryComplete = true;
				break;
			}
		}
		const watermark = dateField(requirementsAsOf);
		const selectedFields = [
			...new Set([
				...metadataFields,
				"System.IterationPath",
				...selection.assignmentFields,
				...config.requirementFields,
			]),
		];
		const items = new Map<number, Record<string, unknown>>();
		async function assertCurrentProject(ids: readonly number[]) {
			if (ids.length === 0) {
				return;
			}
			validateItems(
				await read(`${projectPath}/_apis/wit/workitems`, {
					ids: ids.join(","),
					fields: "System.TeamProject",
					errorPolicy: "Fail",
				}),
				ids,
				project.name,
			);
		}
		async function load(ids: readonly number[]) {
			for (const id of ids) {
				knownIds.add(id);
			}
			if (knownIds.size > 100) {
				throw new ReadBudgetExceeded("item_limit");
			}
			const missing = [...new Set(ids)].filter((id) => !items.has(id));
			if (missing.length === 0) {
				return;
			}
			await assertCurrentProject(missing);
			const body = await read(`${projectPath}/_apis/wit/workitems`, {
				ids: missing.join(","),
				fields: selectedFields.join(","),
				asOf: watermark,
				errorPolicy: "Fail",
			});
			const selectedItems = validateItems(body, missing, project.name);
			// Azure DevOps rejects fields and $expand on the same request.
			const expanded = await read(`${projectPath}/_apis/wit/workitems`, {
				ids: missing.join(","),
				asOf: watermark,
				$expand: "relations",
				errorPolicy: "Fail",
			});
			const expandedItems = new Map(
				validateItems(expanded, missing, project.name).map((item) => [
					itemId(item.id),
					item,
				]),
			);
			for (const item of selectedItems) {
				const id = itemId(item.id);
				const linkedItem = expandedItems.get(id);
				if (
					!linkedItem ||
					positiveInteger(item.rev) !==
						positiveInteger(linkedItem.rev)
				) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				const fields = record(item.fields);
				items.set(id, {
					id,
					rev: item.rev,
					fields: Object.fromEntries(
						selectedFields
							.filter((name) => Object.hasOwn(fields, name))
							.map((name) => [name, fields[name]]),
					),
					relations: linkedItem.relations,
				});
			}
		}
		function getItem(id: number) {
			const item = items.get(id);
			if (!item) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			return item;
		}
		let edgeCount = 0;
		function relations(
			item: Record<string, unknown>,
			allowed: readonly string[],
		) {
			const found: { id: number; rel: string }[] = [];
			const seen = new Set<string>();
			const values =
				item.relations === undefined ? [] : listField(item.relations);
			for (const raw of values) {
				const relation = record(raw);
				const rel = stringField(relation.rel);
				if (!allowed.includes(rel)) {
					continue;
				}
				const id = sprintRelationItemId(relation.url, target, project);
				if (++edgeCount > 500) {
					throw new SprintCaptureLimit("edge_limit");
				}
				const key = `${rel}:${id}`;
				if (!seen.has(key)) {
					seen.add(key);
					found.push({ id, rel });
				}
			}
			return found;
		}
		await load(assignedIds);
		const parents = new Map<number, number[]>();
		const stories = new Map<
			number,
			AzureDevOpsSprintStoryCapture["discoverySources"]
		>();
		function addStory(
			id: number,
			assignedItemId: number,
			kind: "direct" | "parent",
		) {
			const sources = stories.get(id) ?? [];
			sources.push({ assignedItemId, kind });
			stories.set(id, sources);
			if (stories.size > config.maxStories) {
				throw new SprintCaptureLimit("story_limit");
			}
		}
		for (const id of assignedIds) {
			const item = getItem(id);
			const fields = record(item.fields);
			const workItemType = stringField(fields["System.WorkItemType"]);
			const state = stringField(fields["System.State"]);
			const iterationPath = stringField(fields["System.IterationPath"]);
			const owner = assignedTo(fields["System.AssignedTo"]);
			const person = (name: string) => {
				const value = fields[name];
				return typeof value === "string"
					? stringField(value)
					: assignedTo(value);
			};
			const engineer = personFields[0] ? person(personFields[0]) : null;
			const matchedAssignmentFields =
				assignee.mode === "current"
					? null
					: selection.assignmentFields.filter((field) => {
							const value =
								field === "System.AssignedTo"
									? owner
									: person(field);
							const identity =
								typeof value === "string"
									? value
									: value?.uniqueName;
							return (
								identity?.toLowerCase() ===
								assignee.uniqueName.toLowerCase()
							);
						});
			if (
				!selection.assignedItemTypes.includes(workItemType) ||
				!selection.iterationPaths.includes(iterationPath) ||
				selection.excludedAssignedStates.includes(state) ||
				matchedAssignmentFields?.length === 0
			) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			const direct = config.targetStoryTypes.includes(workItemType);
			const followParent =
				!direct && selection.parentSourceTypes.includes(workItemType);
			assignedItems.push({
				id,
				workItemType,
				state,
				assignedTo: owner,
				engineer,
				iterationPath,
				sourceUrl: sourceUrl(id),
				discovery: {
					reason: "assignment_query",
					assignmentFields: selection.assignmentFields,
					matchedAssignmentFields,
				},
				parentResolution: direct
					? "direct_story"
					: followParent
						? "no_parent"
						: "parent_source_excluded",
				parentCandidates: [],
				storyIds: direct ? [id] : [],
			});
			if (direct) {
				addStory(id, id, "direct");
			} else if (followParent) {
				parents.set(
					id,
					relations(item, ["System.LinkTypes.Hierarchy-Reverse"]).map(
						(link) => link.id,
					),
				);
			}
		}
		await load([...parents.values()].flat());
		for (const observation of assignedItems) {
			for (const id of parents.get(observation.id) ?? []) {
				const workItemType = stringField(
					record(getItem(id).fields)["System.WorkItemType"],
				);
				const included = config.targetStoryTypes.includes(workItemType);
				observation.parentCandidates.push({
					id,
					workItemType,
					included,
				});
				if (included) {
					observation.storyIds.push(id);
					addStory(id, observation.id, "parent");
				}
			}
			if (observation.parentCandidates.length > 0) {
				observation.parentResolution = observation.storyIds.length
					? "parent_followed"
					: "parent_type_excluded";
			}
		}
		const allowedRelations = selection.relationKinds.map((kind) =>
			kind === "child"
				? "System.LinkTypes.Hierarchy-Forward"
				: "System.LinkTypes.Related",
		);
		const edges = new Map<number, AzureDevOpsSprintContextEdge[]>();
		for (const id of stories.keys()) {
			edges.set(
				id,
				relations(getItem(id), allowedRelations).map((link) => ({
					sourceId: id,
					targetId: link.id,
					kind:
						link.rel === "System.LinkTypes.Hierarchy-Forward"
							? "child"
							: "related",
				})),
			);
		}
		await load([...edges.values()].flat().map((edge) => edge.targetId));
		const analysisIds = [
			...new Set([
				...stories.keys(),
				...[...edges.values()].flat().map((edge) => edge.targetId),
			]),
		].sort((a, b) => a - b);
		const snapshots = new Map<number, AzureDevOpsStorySnapshot>();
		let modelCharacters = 0;
		for (const id of analysisIds) {
			const metadata = storyItemMetadata(
				getItem(id),
				config.requirementFields,
				watermark,
				sourceUrl(id),
			);
			modelCharacters += JSON.stringify(metadata).length;
			if (modelCharacters > 120_000) {
				throw new SprintCaptureLimit("input_limit");
			}
			const comments = await readStableStoryComments(
				read,
				projectPath,
				id,
			);
			if (!comments.complete) {
				await assertCurrentProject([...items.keys()]);
				return {
					requirementsAsOf,
					assignedItems,
					discoveryComplete,
					stories: [],
					complete: false,
					incompleteReason: comments.incompleteReason,
					unreadItemIds: [...knownIds].sort((a, b) => a - b),
				};
			}
			modelCharacters += JSON.stringify(comments).length;
			if (modelCharacters > 120_000) {
				throw new SprintCaptureLimit("input_limit");
			}
			snapshots.set(id, { ...metadata, comments, complete: true });
		}
		await assertCurrentProject([...items.keys()]);
		function snapshot(id: number) {
			const value = snapshots.get(id);
			if (!value) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			return value;
		}
		const capturedStories = [...stories]
			.sort(([a], [b]) => a - b)
			.map(([id, discoverySources]) => {
				const storyEdges = edges.get(id) ?? [];
				return {
					story: snapshot(id),
					discoverySources,
					edges: storyEdges,
					contextItems: [
						...new Set(storyEdges.map((edge) => edge.targetId)),
					]
						.sort((a, b) => a - b)
						.map(snapshot),
				};
			});
		const result: AzureDevOpsSprintCapture = {
			requirementsAsOf,
			assignedItems,
			discoveryComplete,
			stories: capturedStories,
			complete: true,
			incompleteReason: null,
			unreadItemIds: [],
		};
		if (JSON.stringify(result).length > 120_000) {
			throw new SprintCaptureLimit("input_limit");
		}
		return result;
	} catch (error) {
		return {
			requirementsAsOf,
			assignedItems,
			discoveryComplete,
			stories: [],
			complete: false,
			incompleteReason:
				error instanceof SprintCaptureLimit
					? error.reason
					: captureIncompleteReason(error),
			unreadItemIds: [...knownIds].sort((a, b) => a - b),
		};
	}
}
