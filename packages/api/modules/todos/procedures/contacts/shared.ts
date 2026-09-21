/**
 * Shared input schemas and the wire shape for the non-member contact register
 * (#2340).
 *
 * The four contact procedures all speak about the same row, so the field
 * schemas and the response mapping live here once. Two things are deliberate:
 *
 *  - **The response is an explicit shape, not a Prisma model.** A contact row
 *    is about a person outside the organization, and handing the client
 *    whatever columns the model grows next is how internal fields leak into a
 *    surface that already holds third-party contact details.
 *
 *  - **Blank is the same as cleared.** A form sends `""` for an emptied field
 *    and an API client sends `null`; both mean the same thing here, and the
 *    database layer normalizes either to `NULL`. So `""` is accepted for the
 *    optional fields and only the NAME refuses to be blank.
 */

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";
import { INPUT_BOUNDS } from "../../../../lib/zod-bounds";

/**
 * A contact needs a name and nothing else.
 *
 * `.trim()` runs before the length checks, so `"   "` fails `min(1)` — a
 * whitespace-only name would otherwise create a row that renders as an empty
 * line in the register and can never be searched for.
 */
export const contactNameSchema = z
	.string()
	.trim()
	.min(1, "A contact needs a name")
	.max(INPUT_BOUNDS.name);

/**
 * Email and company are optional and exist for ONE reason: so two people with
 * the same name stay distinguishable. Neither is ever used to reach a Fabric
 * account — a contact has none — so the email is validated for shape only.
 */
export const optionalContactEmailSchema = z
	.string()
	.max(INPUT_BOUNDS.name)
	.refine(
		(value) =>
			value.trim().length === 0 ||
			z.string().email().safeParse(value.trim()).success,
		{ message: "Enter a valid email address" },
	)
	.nullable()
	.optional();

export const optionalContactCompanySchema = z
	.string()
	.max(INPUT_BOUNDS.name)
	.nullable()
	.optional();

/** What every contact procedure returns for a single row. */
export interface ContactResponse {
	id: string;
	organizationId: string;
	name: string;
	email: string | null;
	company: string | null;
	createdAt: string;
	updatedAt: string;
}

export function toContactResponse(record: {
	id: string;
	organizationId: string;
	name: string;
	email: string | null;
	company: string | null;
	createdAt: Date;
	updatedAt: Date;
}): ContactResponse {
	return {
		id: record.id,
		organizationId: record.organizationId,
		name: record.name,
		email: record.email,
		company: record.company,
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	};
}

/**
 * Narrows the resolved organization to a string.
 *
 * `requireInputOrgPermission(..., { requireOrganization: true })` already
 * refuses a request that resolves to no organization, so reaching this throw
 * means that middleware was removed or reordered. It is kept because the
 * register is org-only — there is no personal variant of a contact — and a
 * `resolveOrganizationId` that returned `undefined` would otherwise flow into
 * a query whose whole tenant boundary is that one value.
 *
 * It carries `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE` so a client recognises
 * this refusal exactly as it recognises the middleware's own, and deliberately
 * does NOT repeat that gate's sentence: the code is the contract and the
 * sentence is not, and a fourth copy of the literal would claim this file is a
 * fourth place the rule is WRITTEN rather than a narrowing behind one of them
 * (see `lib/missing-organization-context.ts`).
 */
export function requireOrganizationContext(
	organizationId: string | undefined,
): string {
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "This request must name an organization",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
	}
	return organizationId;
}
