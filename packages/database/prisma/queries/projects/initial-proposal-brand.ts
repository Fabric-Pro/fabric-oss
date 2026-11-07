import { proposalClientPaletteFromColors } from "@repo/utils/proposal-artifact/theme-tokens";
import type { Prisma } from "../../client";

export type InitialProposalBranding = "CLIENT" | "COMPANY";

export interface InitialProposalBrandingInput {
	proposalBranding?: InitialProposalBranding;
	/** The reviewed saved client brand, never a website suggestion's version. */
	recipientBrandVersion?: number;
}

export class InitialProposalBrandError extends Error {
	constructor(
		readonly code:
			| "INVALID_PROPOSAL_BRANDING"
			| "RECIPIENT_BRAND_CHANGED"
			| "RECIPIENT_BRAND_MISSING",
	) {
		super(code);
		this.name = "InitialProposalBrandError";
	}
}

/**
 * Resolve a reviewed client palette INSIDE the document creation transaction.
 * The shared lock keeps confirmation/upload changes from racing the Style
 * insertion: the document either receives the version the creator reviewed or
 * creation fails without a document, version or source-context row.
 *
 * Company branding uses the existing inherited theme. Callers that do not
 * choose a palette retain their existing behavior, without any extra read.
 * The caller must authorize project/document creation before entering here.
 */
export async function resolveInitialProposalStyle(
	tx: Pick<Prisma.TransactionClient, "$queryRaw">,
	input: InitialProposalBrandingInput & {
		projectId: string;
		organizationId: string | null;
		type: string;
	},
): Promise<{
	primaryColor: string;
	accentColors: string[];
	brandSource: "CLIENT";
} | null> {
	if (input.proposalBranding === undefined) {
		if (input.recipientBrandVersion !== undefined) {
			throw new InitialProposalBrandError("INVALID_PROPOSAL_BRANDING");
		}
		return null;
	}
	if (
		input.type !== "PROPOSAL" ||
		!input.organizationId ||
		!["CLIENT", "COMPANY"].includes(input.proposalBranding)
	) {
		throw new InitialProposalBrandError("INVALID_PROPOSAL_BRANDING");
	}
	if (input.proposalBranding === "COMPANY") {
		return null;
	}
	if (
		!Number.isSafeInteger(input.recipientBrandVersion) ||
		(input.recipientBrandVersion ?? 0) < 1
	) {
		throw new InitialProposalBrandError("INVALID_PROPOSAL_BRANDING");
	}
	const [brand] = await tx.$queryRaw<
		Array<{ organizationId: string; version: number; colors: string[] }>
	>`SELECT "organizationId", "version", "colors"
		FROM "project_recipient_brand"
		WHERE "projectId" = ${input.projectId}
		FOR SHARE`;
	if (!brand || brand.organizationId !== input.organizationId) {
		throw new InitialProposalBrandError("RECIPIENT_BRAND_MISSING");
	}
	if (brand.version !== input.recipientBrandVersion) {
		throw new InitialProposalBrandError("RECIPIENT_BRAND_CHANGED");
	}
	const palette = proposalClientPaletteFromColors(brand.colors);
	if (!palette) {
		throw new InitialProposalBrandError("RECIPIENT_BRAND_MISSING");
	}
	return { ...palette, brandSource: "CLIENT" };
}
