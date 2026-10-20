import {
	AzureDevOpsProjectReadError,
	type AzureDevOpsProjectTarget,
	captureIncompleteReason,
	listField,
	pathSegment,
	projectReader,
	ReadBudgetExceeded,
	readCanonicalProject,
	record,
	stringField,
} from "./project-read";

const AZURE_DEVOPS_WORK_ITEM_TYPES_MAX = 100;

function typeName(value: unknown, max: number): string {
	const name = stringField(value).trim();
	if (!name || name.length > max || /[\u0000-\u001f\u007f<>]/.test(name)) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return name;
}

/** GET the connected project's actual enabled types; XML and field definitions never leave this layer. */
export async function listAzureDevOpsWorkItemTypes(
	target: AzureDevOpsProjectTarget,
	pat: string,
) {
	const read = projectReader(target, pat, {
		responseBytes: 2 * 1024 * 1024,
		totalBytes: 4 * 1024 * 1024,
		totalCharacters: 3 * 1024 * 1024,
	});
	try {
		const project = await readCanonicalProject(read, target);
		const body = await read(
			`${pathSegment(project.id)}/_apis/wit/workitemtypes`,
			{},
		);
		const values = listField(body.value);
		if (body.count !== values.length) {
			throw new AzureDevOpsProjectReadError("invalid_response");
		}
		if (values.length > AZURE_DEVOPS_WORK_ITEM_TYPES_MAX) {
			throw new ReadBudgetExceeded("item_limit");
		}
		const types = new Map<
			string,
			{ name: string; referenceName: string }
		>();
		for (const value of values) {
			const item = record(value);
			if (item.isDisabled === true) {
				continue;
			}
			if (item.isDisabled !== undefined && item.isDisabled !== false) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			const type = {
				name: typeName(item.name, 128),
				referenceName: typeName(item.referenceName, 256),
			};
			const previous = types.get(type.referenceName);
			if (previous && previous.name !== type.name) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			types.set(type.referenceName, type);
		}
		return {
			workItemTypes: [...types.values()].sort((a, b) =>
				a.name.localeCompare(b.name),
			),
			complete: true,
			incompleteReason: null,
		};
	} catch (error) {
		return {
			workItemTypes: [],
			complete: false,
			incompleteReason: captureIncompleteReason(error),
		};
	}
}
