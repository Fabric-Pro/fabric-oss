import { ORPCError } from "@orpc/client";
import { os } from "@orpc/server";
import { PublicSharingDisabledError } from "@repo/database";

/**
 * Turns the organization's refusal to make a frame public into the
 * procedure's error. Mounted with `.use(publicSharingErrors)` on every frame
 * procedure that can set a frame public (create, update, publish): the
 * database command makes the check (`assertPublicSharingAllowed`, the one rule
 * `shareFrame` also applies) and this makes it a `FORBIDDEN` the caller can
 * read, instead of an unexpected error.
 */
export const publicSharingErrors = os.middleware(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		if (error instanceof PublicSharingDisabledError) {
			throw new ORPCError("FORBIDDEN", { message: error.message });
		}
		throw error;
	}
});
