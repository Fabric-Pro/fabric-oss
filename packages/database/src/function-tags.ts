import type { FunctionTag } from "../prisma/client";

export const FUNCTION_TAG_VALUES = [
	"PRODUCT_OWNER",
	"PRODUCT_CONTRIBUTOR",
	"DEVELOPER",
	"ARCHITECT",
	"DESIGNER",
	"SDET_QA",
	"SME",
	"STAKEHOLDER",
] as const satisfies readonly FunctionTag[];

export const FUNCTION_TAG_LABELS: Record<FunctionTag, string> = {
	PRODUCT_OWNER: "Product Owner",
	PRODUCT_CONTRIBUTOR: "Product Contributor",
	DEVELOPER: "Developer",
	ARCHITECT: "Architect",
	DESIGNER: "Designer",
	SDET_QA: "SDET/QA",
	SME: "Subject-Matter Expert (SME)",
	STAKEHOLDER: "Stakeholder",
};

// Display order for pickers (Stage 2/3). Mirrors the card's listed order.
export const FUNCTION_TAG_ORDER: FunctionTag[] = [...FUNCTION_TAG_VALUES];

/** Plural display label for a group mention, e.g. "@Developers". */
export const FUNCTION_TAG_GROUP_LABELS: Record<FunctionTag, string> = {
	PRODUCT_OWNER: "Product Owners",
	PRODUCT_CONTRIBUTOR: "Product Contributors",
	DEVELOPER: "Developers",
	ARCHITECT: "Architects",
	DESIGNER: "Designers",
	SDET_QA: "SDET/QA",
	SME: "SMEs",
	STAKEHOLDER: "Stakeholders",
};

/** Lowercase slug for the comment-surface group token (@@<slug>). */
export const FUNCTION_TAG_GROUP_SLUGS: Record<FunctionTag, string> = {
	PRODUCT_OWNER: "product-owners",
	PRODUCT_CONTRIBUTOR: "product-contributors",
	DEVELOPER: "developers",
	ARCHITECT: "architects",
	DESIGNER: "designers",
	SDET_QA: "sdet-qa",
	SME: "smes",
	STAKEHOLDER: "stakeholders",
};

/** Reverse lookup slug → tag, for comment-surface matching. */
export const GROUP_SLUG_TO_TAG: Record<string, FunctionTag> =
	Object.fromEntries(
		(
			Object.entries(FUNCTION_TAG_GROUP_SLUGS) as [FunctionTag, string][]
		).map(([tag, slug]) => [slug, tag]),
	);

const FUNCTION_TAG_SET = new Set<string>(FUNCTION_TAG_VALUES);

/** Type guard: is `value` one of the 8 closed FunctionTag values? */
export function isFunctionTag(value: string): value is FunctionTag {
	return FUNCTION_TAG_SET.has(value);
}
