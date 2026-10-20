import {
	type AzureDevOpsCaptureIncompleteReason,
	AzureDevOpsProjectReadError,
	type AzureDevOpsProjectTarget,
	captureIncompleteReason,
	dateField,
	pathSegment,
	positiveInteger,
	readCanonicalProject,
	storyProjectReader,
} from "./project-read";
import {
	type AzureDevOpsStoryCommentsCapture,
	readStableStoryComments,
} from "./story-comments";
import {
	defaultRequirements,
	metadataFields,
	requirementFieldNames,
	storyItemMetadata,
	validateItems,
} from "./story-items";

export interface AzureDevOpsStorySnapshotsInput {
	ids: readonly number[];
	requirementsAsOf: string;
	requirementFields?: readonly string[];
}

export interface AzureDevOpsStorySnapshot {
	id: number;
	rev: number;
	workItemType: string;
	title: string;
	state: string;
	assignedTo: { uniqueName: string; displayName: string } | null;
	changedDate: string;
	requirements: Record<string, string | null>;
	requirementsAsOf: string;
	sourceUrl: string;
	comments: AzureDevOpsStoryCommentsCapture;
	complete: boolean;
}

/** Historical requirements and current comments are distinct captures, never an atomic snapshot. */
export async function getAzureDevOpsStorySnapshots(
	target: AzureDevOpsProjectTarget,
	pat: string,
	input: AzureDevOpsStorySnapshotsInput,
) {
	if (
		input.ids.length === 0 ||
		input.ids.length > 100 ||
		new Set(input.ids).size !== input.ids.length
	) {
		throw new AzureDevOpsProjectReadError("invalid_filter");
	}
	const ids = input.ids.map(positiveInteger);
	const requirementsAsOf = dateField(input.requirementsAsOf);
	const requirementFields = requirementFieldNames(
		input.requirementFields ?? defaultRequirements,
	);
	const read = storyProjectReader(target, pat);
	const snapshots: AzureDevOpsStorySnapshot[] = [];
	let incompleteReason: AzureDevOpsCaptureIncompleteReason | null = null;
	try {
		const project = await readCanonicalProject(read, target);
		const projectPath = pathSegment(project.id);
		async function assertCurrentProject(batch: readonly number[]) {
			const body = await read(`${projectPath}/_apis/wit/workitems`, {
				ids: batch.join(","),
				fields: "System.TeamProject",
				errorPolicy: "Fail",
			});
			validateItems(body, batch, project.name);
		}
		const items: Record<string, unknown>[] = [];
		for (let offset = 0; offset < ids.length; offset += 50) {
			const batch = ids.slice(offset, offset + 50);
			// Project-prefixed ADO routes alone do not constrain organization-wide item IDs.
			await assertCurrentProject(batch);
			const body = await read(`${projectPath}/_apis/wit/workitems`, {
				ids: batch.join(","),
				fields: [
					...new Set([...metadataFields, ...requirementFields]),
				].join(","),
				asOf: requirementsAsOf,
				errorPolicy: "Fail",
			});
			items.push(...validateItems(body, batch, project.name));
		}
		for (const item of items) {
			const id = positiveInteger(item.id);
			const metadata = storyItemMetadata(
				item,
				requirementFields,
				requirementsAsOf,
				`https://dev.azure.com/${pathSegment(target.organization)}/${projectPath}/_workitems/edit/${id}`,
			);
			const comments = await readStableStoryComments(
				read,
				projectPath,
				id,
			);
			snapshots.push({
				...metadata,
				comments,
				complete: comments.complete,
			});
			if (!comments.complete) {
				incompleteReason = comments.incompleteReason;
				break;
			}
		}
		for (let offset = 0; offset < snapshots.length; offset += 50) {
			await assertCurrentProject(
				snapshots.slice(offset, offset + 50).map((item) => item.id),
			);
		}
	} catch (error) {
		snapshots.length = 0;
		incompleteReason = captureIncompleteReason(error);
	}
	const capturedIds = new Set(snapshots.map((item) => item.id));
	return {
		snapshots,
		unreadIds: ids.filter((id) => !capturedIds.has(id)),
		requirementsAsOf,
		complete: incompleteReason === null && snapshots.length === ids.length,
		incompleteReason,
	};
}
