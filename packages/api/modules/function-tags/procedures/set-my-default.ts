import { setUserDefaultFunctionTags } from "@repo/database";
import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

/**
 * Set the caller's own default function tags (`User.defaultFunctionTags`).
 * Closed vocabulary enforced by `FunctionTagSchema` (Task 1) — do not
 * hand-roll a second list of allowed values here. Self-service only — no
 * organizationId/projectId scoping.
 */
export const setMyDefaultProcedure = protectedProcedure
	.route({
		method: "PUT",
		path: "/function-tags/me",
		tags: ["Function Tags"],
		summary: "Set my default function tags",
	})
	// `FunctionTagSchema.array()` (not `z.array(FunctionTagSchema)`): the schema
	// is built by @repo/database's own zod instance (pinned to a different
	// minor version than @repo/api's). Calling `.array()` on the schema itself
	// stays within its own zod instance; calling the combinator `z.array()`
	// from @repo/api's zod on a foreign-version schema fails `tsc` with a
	// `_zod.version.minor` branding mismatch.
	.input(z.object({ tags: FunctionTagSchema.array() }))
	.output(z.object({ tags: FunctionTagSchema.array() }))
	.handler(async ({ input, context }) => {
		// Dedup + closed set (Zod already enforces the vocabulary).
		const tags = [...new Set(input.tags)];
		await setUserDefaultFunctionTags(context.user.id, tags);
		return { tags };
	});
