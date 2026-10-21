import type { AzureDevOpsStoryAssignee } from "./assigned-stories";
import {
	AzureDevOpsProjectReadError,
	type AzureDevOpsProjectTarget,
	positiveInteger,
	wiqlLiteral,
} from "./project-read";
import { defaultRequirements, requirementFieldNames } from "./story-items";

/**
 * The reference name of any field the process assigns work through
 * (`System.AssignedTo`, `Custom.BEEngineer`, ...). Its shape keeps it safe to
 * name inside a WIQL query.
 */
export type AzureDevOpsSprintAssignmentField = string;

const ASSIGNMENT_FIELD_PATTERN =
	/^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){1,4}$/;
export type AzureDevOpsSprintRelationKind = "child" | "related";

export interface AzureDevOpsSprintSelection {
	iterationPaths: readonly string[];
	assignmentFields: readonly AzureDevOpsSprintAssignmentField[];
	assignedItemTypes: readonly string[];
	parentSourceTypes: readonly string[];
	relationKinds: readonly AzureDevOpsSprintRelationKind[];
	excludedAssignedStates?: readonly string[];
}

export interface AzureDevOpsSprintCaptureInput {
	assignee: AzureDevOpsStoryAssignee;
	targetStoryTypes: readonly string[];
	requirementFields?: readonly string[];
	maxStories: number;
	selection: AzureDevOpsSprintSelection;
}

function names(values: readonly string[], maxCount: number, maxLength = 128) {
	if (values.length > maxCount) {
		throw new AzureDevOpsProjectReadError("invalid_filter");
	}
	return [
		...new Set(
			values.map((value) => {
				if (value.length > maxLength) {
					throw new AzureDevOpsProjectReadError("invalid_filter");
				}
				wiqlLiteral(value);
				const name = value.trim();
				if (!name) {
					throw new AzureDevOpsProjectReadError("invalid_filter");
				}
				return name;
			}),
		),
	];
}

export function normalizeSprintInput(input: AzureDevOpsSprintCaptureInput) {
	const selection = input.selection;
	const iterationPaths = names(selection.iterationPaths, 2, 512);
	const assignedItemTypes = names(selection.assignedItemTypes, 20);
	const parentSourceTypes = names(selection.parentSourceTypes, 20);
	const targetStoryTypes = names(input.targetStoryTypes, 20);
	const excludedAssignedStates = names(
		selection.excludedAssignedStates ?? [],
		20,
	);
	if (
		!Number.isSafeInteger(input.maxStories) ||
		input.maxStories < 1 ||
		input.maxStories > 50 ||
		iterationPaths.length === 0 ||
		iterationPaths.some((path) =>
			path.split("\\").some((part) => !part.trim()),
		) ||
		assignedItemTypes.length === 0 ||
		targetStoryTypes.length === 0 ||
		parentSourceTypes.some((type) => !assignedItemTypes.includes(type)) ||
		selection.assignmentFields.length === 0 ||
		selection.assignmentFields.length > 2 ||
		selection.assignmentFields.some(
			(field) => !ASSIGNMENT_FIELD_PATTERN.test(field),
		) ||
		selection.relationKinds.length > 2 ||
		selection.relationKinds.some(
			(kind) => kind !== "child" && kind !== "related",
		)
	) {
		throw new AzureDevOpsProjectReadError("invalid_filter");
	}
	if (input.assignee.mode === "selected") {
		if (input.assignee.uniqueName.length > 512) {
			throw new AzureDevOpsProjectReadError("invalid_filter");
		}
		wiqlLiteral(input.assignee.uniqueName);
	}
	const assignee: AzureDevOpsStoryAssignee =
		input.assignee.mode === "current"
			? { mode: "current" }
			: {
					mode: "selected",
					uniqueName: input.assignee.uniqueName.trim(),
				};
	if (assignee.mode === "selected") {
		if (!assignee.uniqueName || assignee.uniqueName.length > 512) {
			throw new AzureDevOpsProjectReadError("invalid_filter");
		}
		wiqlLiteral(assignee.uniqueName);
	}
	return {
		assignee,
		targetStoryTypes,
		requirementFields: requirementFieldNames(
			input.requirementFields ?? defaultRequirements,
		),
		maxStories: input.maxStories,
		selection: {
			iterationPaths,
			assignedItemTypes,
			parentSourceTypes,
			excludedAssignedStates,
			assignmentFields: [...new Set(selection.assignmentFields)],
			relationKinds: [...new Set(selection.relationKinds)],
		},
	};
}

/** Relation URLs are ID input only; the reader always rebuilds its own endpoint. */
export function sprintRelationItemId(
	value: unknown,
	target: AzureDevOpsProjectTarget,
	project: { id: string; name: string },
) {
	if (
		typeof value !== "string" ||
		value.length > 2_048 ||
		/[\u0000-\u0020\u007f\\]/.test(value) ||
		/%(?:2f|5c|25)/i.test(value)
	) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	const match =
		/^https:\/\/dev\.azure\.com\/([^/?#]+)\/(?:([^/?#]+)\/)?_apis\/wit\/workItems\/([1-9]\d*)$/i.exec(
			value,
		);
	if (!match) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	let organization: string;
	let linkedProject: string | undefined;
	try {
		organization = decodeURIComponent(match[1] ?? "");
		linkedProject =
			match[2] === undefined ? undefined : decodeURIComponent(match[2]);
	} catch {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	if (
		organization.toLowerCase() !== target.organization.toLowerCase() ||
		(linkedProject !== undefined &&
			linkedProject.toLowerCase() !== project.id.toLowerCase() &&
			linkedProject.toLowerCase() !== project.name.toLowerCase())
	) {
		throw new AzureDevOpsProjectReadError("project_mismatch");
	}
	const id = positiveInteger(Number(match[3]));
	if (id > 2_147_483_647) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return id;
}
