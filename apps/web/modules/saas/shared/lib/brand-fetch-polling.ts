import {
	BRAND_FETCH_RUNNING_TTL_MS,
	type BrandFetchStatus,
} from "@repo/utils/proposal-artifact/brand-sources";

/** How often a form re-reads a website fetch while it is running. */
export const BRAND_FETCH_POLL_MS = 3000;

/**
 * The `refetchInterval` for a query that carries a website fetch's attempt
 * (Fizzy #2946): poll while the attempt is RUNNING and still young enough to
 * finish, then stop. Past that the server reads the attempt as timed out, so
 * a form never spins forever when the request that ran it was cut off.
 */
export function brandFetchRefetchInterval(
	attempt: { status: BrandFetchStatus; requestedAt: Date | string } | null,
	now: number = Date.now(),
): number | false {
	if (attempt?.status !== "RUNNING") {
		return false;
	}
	const age = now - new Date(attempt.requestedAt).getTime();
	return age < BRAND_FETCH_RUNNING_TTL_MS ? BRAND_FETCH_POLL_MS : false;
}

/** A website as people say it: its host, or the address when it is not one. */
export function websiteHost(website: string): string {
	try {
		return new URL(website).hostname || website;
	} catch {
		return website;
	}
}
