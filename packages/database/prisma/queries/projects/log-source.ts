/**
 * Per-project log-source binding for bug-analysis context (Fizzy #1234).
 *
 * The binding says WHICH log platform a project reads from and WHERE, never
 * how to authenticate: providers use the worker's own identity or an existing
 * MCP config. Nothing here is a credential, which is why the settings live in
 * a plain JSON column rather than an encrypted one.
 *
 * A project with no binding inherits the deployment's configuration, which is
 * what every project did before this existed.
 */

import { db } from "../../client";
import { Prisma } from "../../generated/client";

export interface ProjectLogSourceBinding {
	/** Provider id from the log-source registry, e.g. `"azure-monitor"`. */
	provider: string;
	/** That provider's own settings. Shape is the provider's business. */
	config: Record<string, unknown>;
}

/**
 * Read a project's log-source binding, or `null` when it has none.
 *
 * Returns `null` rather than a partial binding when the provider is missing,
 * since settings without a provider name nothing.
 */
export async function getProjectLogSourceBinding(
	projectId: string,
): Promise<ProjectLogSourceBinding | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { logSourceProvider: true, logSourceConfig: true },
	});

	const provider = project?.logSourceProvider?.trim();
	if (!provider) {
		return null;
	}

	const raw = project?.logSourceConfig;
	const config =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};

	return { provider, config };
}

/**
 * Set or clear a project's log-source binding.
 *
 * Passing `null` clears it, returning the project to the deployment default.
 */
export async function setProjectLogSourceBinding(
	projectId: string,
	binding: ProjectLogSourceBinding | null,
): Promise<void> {
	await db.project.update({
		where: { id: projectId },
		data: {
			logSourceProvider: binding?.provider ?? null,
			// Round-tripping through JSON does two jobs: it PROVES the value is
			// JSON-safe rather than asserting it past the type checker, and it
			// drops anything a JSON column cannot hold (functions, undefined,
			// cycles would throw here rather than at the driver).
			// `Prisma.DbNull` writes a real SQL NULL; a bare `null` is not valid
			// input for a nullable JSON column.
			logSourceConfig: binding
				? JSON.parse(JSON.stringify(binding.config))
				: Prisma.DbNull,
		},
	});
}
