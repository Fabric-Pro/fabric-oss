/**
 * Glossy edition eligibility — which document types can be turned into a
 * Glossy edition (Fizzy #2589, R30).
 *
 * Declared as a local string union rather than imported from
 * `ProjectDocumentTypeName` (`document-type-catalog.ts`) or the Prisma
 * schema: this module is imported directly by the document editor's client
 * bundle (the eligibility check gates the "Create Glossy edition" entry
 * point), so it must stay free of Node built-ins and of any dependency that
 * pulls them in. `document-type-catalog.ts` documents the same constraint
 * for the same reason — `@repo/database` depends on `@repo/utils`, so a
 * dependency back would be a cycle.
 *
 * `isGlossyEligible` takes a bare `string` rather than requiring the caller
 * already hold a typed document type: callers on both the client and server
 * side generally have a string from the database or from user input, and a
 * type that is not one of the eligible values must resolve to `false`
 * rather than fail to compile.
 */

/** The only document types a Glossy edition may be built from. */
export const GLOSSY_ELIGIBLE_DOCUMENT_TYPES = [
	"PROPOSAL",
	"BUSINESS_CASE",
] as const;

export type GlossyEligibleDocumentType =
	(typeof GLOSSY_ELIGIBLE_DOCUMENT_TYPES)[number];

/** Whether `type` is one of the document types a Glossy edition may be built from. */
export function isGlossyEligible(
	type: string,
): type is GlossyEligibleDocumentType {
	return (GLOSSY_ELIGIBLE_DOCUMENT_TYPES as readonly string[]).includes(type);
}
