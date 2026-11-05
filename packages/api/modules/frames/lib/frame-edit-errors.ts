import { ORPCError } from "@orpc/client";
import { os } from "@orpc/server";
import { FrameUpdateConflictError } from "@repo/database";

export const frameEditErrors = os.middleware(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		if (error instanceof FrameUpdateConflictError) {
			throw new ORPCError("CONFLICT", { message: error.message });
		}
		throw error;
	}
});
