import {
	AzureDevOpsProjectReadError,
	dateField,
	listField,
	positiveInteger,
	record,
	stringField,
} from "./project-read";

export const defaultRequirements = [
	"System.Title",
	"System.Description",
	"Microsoft.VSTS.Common.AcceptanceCriteria",
];
export const metadataFields = [
	"System.TeamProject",
	"System.WorkItemType",
	"System.Title",
	"System.State",
	"System.AssignedTo",
	"System.ChangedDate",
];

export function validateItems(
	body: Record<string, unknown>,
	ids: readonly number[],
	projectName: string,
) {
	const items = listField(body.value).map(record);
	const requested = new Set(ids);
	if (items.length !== ids.length) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	for (const item of items) {
		const id = positiveInteger(item.id);
		if (!requested.delete(id)) {
			throw new AzureDevOpsProjectReadError("invalid_response");
		}
		const fields = record(item.fields);
		if (
			stringField(fields["System.TeamProject"]).toLowerCase() !==
			projectName.toLowerCase()
		) {
			throw new AzureDevOpsProjectReadError("project_mismatch");
		}
	}
	return items;
}

export function assignedTo(value: unknown) {
	if (value === undefined || value === null) {
		return null;
	}
	const identity = record(value);
	return {
		uniqueName: stringField(identity.uniqueName),
		displayName: stringField(identity.displayName),
	};
}

export function requirementFieldNames(requestedFields: readonly string[]) {
	if (
		requestedFields.length === 0 ||
		requestedFields.length > 20 ||
		requestedFields.some(
			(field) =>
				field.length > 128 ||
				!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(
					field,
				),
		)
	) {
		throw new AzureDevOpsProjectReadError("invalid_filter");
	}
	return [...new Set(requestedFields)];
}

export function storyItemMetadata(
	item: Record<string, unknown>,
	requirementFields: readonly string[],
	requirementsAsOf: string,
	sourceUrl: string,
) {
	const fields = record(item.fields);
	const requirements: Record<string, string | null> = {};
	for (const name of requirementFields) {
		const value = fields[name];
		if (
			value !== undefined &&
			value !== null &&
			typeof value !== "string"
		) {
			throw new AzureDevOpsProjectReadError("invalid_response");
		}
		requirements[name] = typeof value === "string" ? value : null;
	}
	return {
		id: positiveInteger(item.id),
		rev: positiveInteger(item.rev),
		workItemType: stringField(fields["System.WorkItemType"]),
		title: stringField(fields["System.Title"]),
		state: stringField(fields["System.State"]),
		assignedTo: assignedTo(fields["System.AssignedTo"]),
		changedDate: dateField(fields["System.ChangedDate"]),
		requirements,
		requirementsAsOf,
		sourceUrl,
	};
}
