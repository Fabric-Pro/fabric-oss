/**
 * Get Frame Content Activity
 *
 * Fetches the frame document from the database.
 */

import type { FrameDocument } from "@repo/database";
import {
	canReadOrganizationFrames,
	getAccessibleFrameById,
	getUserById,
} from "@repo/database";
import { ApplicationFailure } from "@temporalio/common";
import { FRAME_EXPORT_MAX_BYTES } from "../../lib/frame-export-contract";

export interface GetFrameContentInput {
	frameId: string;
	userId: string;
	organizationId?: string;
	expectedUpdatedAt?: string;
}

export interface GetFrameContentOutput {
	document: FrameDocument;
	title: string;
}

export async function getFrameContentActivity(
	input: GetFrameContentInput,
): Promise<GetFrameContentOutput> {
	if (
		!input.organizationId ||
		!(await canReadOrganizationFrames(input.userId, input.organizationId))
	) {
		throw ApplicationFailure.nonRetryable(
			"Frame is unavailable.",
			"FRAME_EXPORT_FORBIDDEN",
		);
	}
	const user = await getUserById(input.userId);
	const frame = await getAccessibleFrameById({
		id: input.frameId,
		userId: input.userId,
		userEmail: user?.email,
		organizationId: input.organizationId,
	});
	if (!frame) {
		throw ApplicationFailure.nonRetryable(
			"Frame is unavailable.",
			"FRAME_EXPORT_NOT_FOUND",
		);
	}
	if (
		input.expectedUpdatedAt &&
		new Date(input.expectedUpdatedAt).getTime() !==
			frame.updatedAt.getTime()
	) {
		throw ApplicationFailure.nonRetryable(
			"The page changed. Review the latest page before exporting.",
			"FRAME_EXPORT_CONFLICT",
		);
	}
	const document = frame.document;
	if (
		Buffer.byteLength(JSON.stringify(document), "utf8") >
		FRAME_EXPORT_MAX_BYTES
	) {
		throw ApplicationFailure.nonRetryable(
			"Page exceeds the export size limit.",
			"FRAME_EXPORT_TOO_LARGE",
		);
	}

	return {
		document,
		title: document.title || frame.title,
	};
}
