import { db } from "../client";

/** Indexed project content owned by this organization, excluding deleted projects. */
export async function getIndexedProjectContentCount(
	organizationId: string,
): Promise<number> {
	if (!organizationId) {
		throw new Error(
			"An organization is required to count indexed project content",
		);
	}
	const where = {
		embeddedAt: { not: null },
		project: { organizationId, deletedAt: null },
	};
	const [contexts, documents] = await Promise.all([
		db.projectContext.count({ where }),
		db.projectDocument.count({ where }),
	]);
	return contexts + documents;
}
