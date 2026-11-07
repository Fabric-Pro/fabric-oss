import { ORPCError } from "@orpc/server";
import { getDocumentStyle } from "@repo/database";
import type { z } from "zod";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";
import { assertProjectPermission } from "../../../orpc/middleware/require-permission";
import { Permissions } from "../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../projects/lib/proposal-artifact-access";
import { presentProposalStyle } from "../../projects/procedures/proposal-artifact/get-style";
import { updateProposalStyleCommand } from "../../projects/procedures/proposal-artifact/update-style";
import type {
	BrandActor,
	proposalStyleReadSchema,
	proposalStyleSaveSchema,
} from "./brand-contracts";

export async function getProposalStyleCommand(
	actor: BrandActor,
	input: z.infer<typeof proposalStyleReadSchema>,
) {
	const permission = await assertProjectPermission(
		input.projectId,
		actor.userId,
		Permissions.DOCUMENT_READ,
	);
	if (permission.organizationId !== actor.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Document not found" });
	}
	const { document, organizationId } = await loadProposalArtifactDocument({
		...input,
		userId: actor.userId,
		write: false,
	});
	const style = await getDocumentStyle({
		documentId: document.id,
		organizationId,
	});
	return style ? presentProposalStyle(style) : null;
}

export async function saveProposalStyleCommand(
	actor: BrandActor,
	input: z.infer<typeof proposalStyleSaveSchema>,
	audit: (event: RecordAuditFromRequestInput) => unknown,
) {
	// Partial external edits preserve all omitted presentation fields. The CAS in
	// the same canonical writer rejects a change between this read and save.
	const current = await getProposalStyleCommand(actor, input);
	return updateProposalStyleCommand(
		actor,
		{
			...input,
			expectedUpdatedAt:
				input.expectedUpdatedAt === null
					? null
					: new Date(input.expectedUpdatedAt),
			styleDirection:
				input.styleDirection === undefined
					? (current?.styleDirection ?? null)
					: input.styleDirection,
			primaryColor:
				input.primaryColor === undefined
					? (current?.primaryColor ?? null)
					: input.primaryColor,
			accentColors: input.accentColors ?? current?.accentColors ?? [],
		},
		audit,
	);
}
