/**
 * Get Frame Content Activity
 *
 * Fetches the frame document from the database.
 */

import type { FrameDocument } from "@repo/database";
import { db } from "@repo/database";

export interface GetFrameContentInput {
	frameId: string;
	userId: string;
	organizationId?: string;
}

export interface GetFrameContentOutput {
	document: FrameDocument;
	title: string;
}

export async function getFrameContentActivity(
	input: GetFrameContentInput,
): Promise<GetFrameContentOutput> {
	const file = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.frameId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});

	if (!file) {
		throw new Error(`Frame not found: ${input.frameId}`);
	}

	const document = JSON.parse(file.content) as FrameDocument;

	return {
		document,
		title: document.title || file.name,
	};
}
