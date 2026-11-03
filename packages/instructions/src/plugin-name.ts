/**
 * The Coding Instructions plugin's name in coding tools: skills read
 * `/<name>:<skill>` (specs/2026-10-21-ai-artifacts-hub). A project may set
 * its own (`Project.instructionPluginName`); otherwise it is the project's
 * name as a slug. The CLI keeps the same rules (`plugin-names.ts`).
 */

/** Lowercase letters, digits and single dashes, 2–40 long: a name every tool accepts. */
export function isPluginName(value: string): boolean {
	return (
		/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(value) &&
		!value.includes("--")
	);
}

/** A name as a plugin name, or null when nothing usable is left. */
export function slugForPlugin(name: string): string | null {
	const slug = name
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return slug.length >= 2 && isPluginName(slug) ? slug : null;
}

/** `fabric-` and the last eight letters and digits of the id: the name before readable names. */
export function idPluginName(projectId: string): string {
	const tail = projectId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(-8);
	return `fabric-${tail === "" ? "project" : tail}`;
}

/** The project's plugin name: its own setting, else its name as a slug, else the id-based one. */
export function projectPluginName(project: {
	id: string;
	name: string;
	instructionPluginName: string | null;
}): string {
	if (
		project.instructionPluginName &&
		isPluginName(project.instructionPluginName)
	) {
		return project.instructionPluginName;
	}
	return slugForPlugin(project.name) ?? idPluginName(project.id);
}
