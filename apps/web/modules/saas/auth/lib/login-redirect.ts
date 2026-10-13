import { safeRelativePath } from "@shared/lib/safe-redirect";

/**
 * Set by `proxy.ts` to the requested path and query, so a server layout —
 * which is never handed the URL — can send a signed-out visitor back to it.
 * A client can send this header too; only `safeRelativePath` makes it safe.
 */
export const RETURN_TO_HEADER = "x-fabric-return-to";

/** The login page, returning to `returnTo` afterwards when it is an internal path. */
export function loginPathReturningTo(returnTo: string | null): string {
	const path = safeRelativePath(returnTo);
	return path
		? `/auth/login?${new URLSearchParams({ redirectTo: path }).toString()}`
		: "/auth/login";
}
