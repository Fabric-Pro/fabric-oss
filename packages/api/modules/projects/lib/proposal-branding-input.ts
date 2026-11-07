import { ORPCError } from "@orpc/client";
import { InitialProposalBrandError } from "@repo/database/prisma/queries/projects/initial-proposal-brand";
import { z } from "zod";
import { assertProposalArtifactEnabled } from "./proposal-artifact-feature";

const selectionSchema = z.object({
	proposalBranding: z.enum(["CLIENT", "COMPANY"]).optional(),
	recipientBrandVersion: z.number().int().positive().optional(),
});

/** Shared Portal/REST/MCP admission. The database rechecks the reviewed version atomically. */
export async function prepareProposalBrandingInput(input: {
	projectId: string;
	type: string;
	proposalBranding?: unknown;
	recipientBrandVersion?: unknown;
	awaitingSourceFile?: boolean;
}) {
	const parsed = selectionSchema.safeParse(input);
	if (!parsed.success) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Choose client or company branding with a valid reviewed client brand version.",
		});
	}
	const selection = parsed.data;
	if (
		!selection.proposalBranding &&
		selection.recipientBrandVersion === undefined
	) {
		return {};
	}
	if (
		input.type !== "PROPOSAL" ||
		input.awaitingSourceFile ||
		(selection.proposalBranding === "CLIENT"
			? selection.recipientBrandVersion === undefined
			: selection.recipientBrandVersion !== undefined ||
				!selection.proposalBranding)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Client branding requires a Proposal and its reviewed client brand version. Imported source files keep their original appearance.",
		});
	}
	await assertProposalArtifactEnabled(input.projectId);
	return selection;
}

export function proposalBrandingAdmissionError(error: unknown) {
	if (!(error instanceof InitialProposalBrandError)) return null;
	return new ORPCError(
		error.code === "RECIPIENT_BRAND_CHANGED" ? "CONFLICT" : "BAD_REQUEST",
		{
			message:
				error.code === "RECIPIENT_BRAND_CHANGED"
					? "Client branding changed. Review the saved client brand and try again."
					: "Save a client color palette before creating a client-branded proposal, or choose company branding.",
			data: { code: error.code },
		},
	);
}
