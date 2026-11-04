/**
 * Template parameters a project answers by itself, so a report created in
 * the project starts with them filled: its name for a "project name"
 * parameter. The person can still change the value on the report page.
 */

const PROJECT_NAME_KEY = "projectname";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[-_\s]/g, "");
}

export function projectParameterDefaults(
	templateParameters: unknown,
	project: { name: string },
): Record<string, string> | undefined {
	const properties =
		isRecord(templateParameters) && isRecord(templateParameters.properties)
			? templateParameters.properties
			: {};
	const name = project.name.trim();
	const defaults: Record<string, string> = {};
	for (const key of Object.keys(properties)) {
		if (name && normalizeKey(key) === PROJECT_NAME_KEY) {
			defaults[key] = name;
		}
	}
	return Object.keys(defaults).length > 0 ? defaults : undefined;
}
