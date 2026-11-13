"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/** What the organization lacks for web research, in the server's order. */
export type WebResearchMissing = "search" | "read";

/**
 * Whether a surface may offer web research right now.
 *
 * `loading` and `error` are their own states rather than "unavailable" so the
 * option can say it is still checking, or that the check failed, instead of
 * naming a provider that may well be configured.
 */
export type WebResearchAvailability =
	| { status: "loading" }
	| { status: "error" }
	| { status: "available" }
	| { status: "unavailable"; missing: WebResearchMissing[] };

interface UseWebResearchAvailabilityOptions {
	projectId: string;
	/** True only while the surface that offers the option is open. */
	enabled: boolean;
}

/**
 * Asks the server whether the project's organization can research the web.
 *
 * The organization is resolved from the project on the server, so only the
 * project id is sent.
 */
export function useWebResearchAvailability({
	projectId,
	enabled,
}: UseWebResearchAvailabilityOptions): WebResearchAvailability {
	const query = useQuery({
		...orpc.projects.documents.webResearchAvailability.queryOptions({
			input: { projectId },
		}),
		enabled,
	});

	if (query.isError) {
		return { status: "error" };
	}
	// Keyed on "no answer yet", not on a loading flag: a query that has not
	// started (`enabled` still false) is neither loading nor answered, and
	// must not read as available.
	if (query.data === undefined) {
		return { status: "loading" };
	}
	if (query.data.available === true) {
		return { status: "available" };
	}
	// An answer without a usable list still reads as unavailable, naming both
	// halves rather than crashing the option that renders it.
	const missing = Array.isArray(query.data.missing)
		? query.data.missing
		: (["search", "read"] satisfies WebResearchMissing[]);
	return { status: "unavailable", missing };
}

/**
 * The `allowWebResearch` value a request sends from a surface that offered
 * the option. Such a surface always sends it, `false` included, so the run
 * can tell a declined offer from a request that offered no choice.
 *
 * Only a tick made while research is available counts, so a tick left over
 * from before availability changed (or before it was known) sends `false`.
 */
export function webResearchToSend(
	checked: boolean,
	availability: WebResearchAvailability,
): boolean {
	return checked === true && availability.status === "available";
}
