/**
 * Template parameters a project answers by itself, so a report created in
 * the project starts with them filled: its name for a "project name"
 * parameter, its repository for an owner or repository parameter. The person
 * can still change the value on the report page.
 */

import {
	isProjectAnsweredParameter,
	repositoryParameterPart,
} from "@repo/database/prisma/queries/lib/report-template-defaults";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectParameterDefaults(
	templateParameters: unknown,
	project: {
		name: string;
		/** The project's first active repository integration. */
		repository?: { repositoryOwner: string; repositoryName: string } | null;
	},
): Record<string, string> | undefined {
	const properties =
		isRecord(templateParameters) && isRecord(templateParameters.properties)
			? templateParameters.properties
			: {};
	const name = project.name.trim();
	const repository = {
		owner: project.repository?.repositoryOwner.trim() ?? "",
		name: project.repository?.repositoryName.trim() ?? "",
	};
	const defaults: Record<string, string> = {};
	for (const key of Object.keys(properties)) {
		if (name && isProjectAnsweredParameter(key)) {
			defaults[key] = name;
			continue;
		}
		const part = repositoryParameterPart(key);
		if (part && repository[part]) {
			defaults[key] = repository[part];
		}
	}
	return Object.keys(defaults).length > 0 ? defaults : undefined;
}
