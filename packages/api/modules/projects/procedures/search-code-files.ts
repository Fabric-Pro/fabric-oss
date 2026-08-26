import { getProjectCodeIndexes } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

interface FileManifestEntry {
	path?: string;
	language?: string;
	size?: number;
}

/**
 * Search indexed code files in a project for @mentions autocomplete.
 *
 * AUTHORIZATION: requireProjectPermission(PROJECT_READ) gates project access.
 */
export const searchCodeFilesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/search-code-files",
		tags: ["Projects"],
		summary: "Search code files",
		description:
			"Search indexed code files in a project for @mentions autocomplete",
	})
	.input(
		z.object({
			projectId: z.string(),
			query: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// Merge every connected repo's file manifest for autocomplete.
		const indexes = await getProjectCodeIndexes(input.projectId);
		const manifest = indexes.flatMap(
			(index) => (index.fileManifest as FileManifestEntry[] | null) ?? [],
		);

		if (manifest.length === 0) {
			return { files: [] };
		}

		const normalizedQuery = input.query.toLowerCase();

		const files = manifest
			.filter(
				(item) =>
					typeof item.path === "string" &&
					item.path.toLowerCase().includes(normalizedQuery),
			)
			.slice(0, 10)
			.map((item) => ({
				path: item.path || "",
				language: item.language ?? null,
				size: item.size ?? null,
			}));

		return { files };
	});
