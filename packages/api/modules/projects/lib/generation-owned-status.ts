import { ORPCError } from "@orpc/client";
import {
	DOCUMENT_STATUS_GENERATION_OWNED,
	generationOwnedStatusMessage,
	isGenerationOwnedStatus,
} from "@repo/utils/generation-run-guard";

/** Refuses a status only a generation run may set (see the shared predicate). */
export function assertNotGenerationOwnedStatus(
	status: string | undefined,
): void {
	if (isGenerationOwnedStatus(status)) {
		throw new ORPCError("BAD_REQUEST", {
			message: `${generationOwnedStatusMessage(status)}.`,
			data: { code: DOCUMENT_STATUS_GENERATION_OWNED },
		});
	}
}
