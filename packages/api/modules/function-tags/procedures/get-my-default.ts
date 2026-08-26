import { getUserDefaultFunctionTags, isFeatureEnabled } from "@repo/database";
import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

/**
 * Read the caller's own default function tags (`User.defaultFunctionTags`).
 * Self-service only — no organizationId/projectId scoping. Task 7 adds the
 * project-scoped procedures to this same router.
 */
export const getMyDefaultProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/function-tags/me",
		tags: ["Function Tags"],
		summary: "Get my default function tags",
	})
	// `FunctionTagSchema.array()` (not `z.array(FunctionTagSchema)`): the schema
	// is built by @repo/database's own zod instance (pinned to a different
	// minor version than @repo/api's). Calling `.array()` on the schema itself
	// stays within its own zod instance; calling the combinator `z.array()`
	// from @repo/api's zod on a foreign-version schema fails `tsc` with a
	// `_zod.version.minor` branding mismatch.
	.output(
		z.object({
			tags: FunctionTagSchema.array(),
			enforcementEnabled: z.boolean(),
		}),
	)
	.handler(async ({ context }) => {
		// `enforcementEnabled` is the live kill switch for the blocking gate
		// (Fizzy #2264). The RSC payload decides the gate's FIRST render; this
		// field is what lets an already-open gate learn the flag was turned
		// off without a reload. It can only ever turn the gate off — see
		// `FunctionTagsRequiredGate`.
		const [tags, enforcementEnabled] = await Promise.all([
			getUserDefaultFunctionTags(context.user.id),
			isFeatureEnabled("ROLE_TAG_ENFORCEMENT"),
		]);
		return { tags, enforcementEnabled };
	});
