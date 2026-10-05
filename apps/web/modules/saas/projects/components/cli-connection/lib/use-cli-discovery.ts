"use client";

import {
	CLI_DISCOVERY_PATH,
	type CliDiscoveryDocument,
	parseCliDiscoveryDocument,
} from "@saas/cli-distribution/lib/cli-discovery";
import { useQuery } from "@tanstack/react-query";

export type CliDiscoveryState =
	| { status: "loading" }
	| { status: "unavailable" }
	| { status: "ready"; document: CliDiscoveryDocument };

async function fetchCliDiscovery(): Promise<CliDiscoveryDocument | null> {
	const response = await fetch(CLI_DISCOVERY_PATH, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		return null;
	}
	return parseCliDiscoveryDocument(await response.json());
}

/**
 * Which CLI this deployment serves, read from its own discovery document.
 *
 * Anything short of a well-formed document is "unavailable": a deployment built
 * without the pack step answers 404, and a network or parse failure must not
 * leave the dialog printing a command it could not check. Not fetched until
 * asked for, so the dialogs that never show the line cost nothing.
 */
export function useCliDiscovery(enabled: boolean): CliDiscoveryState {
	const query = useQuery({
		queryKey: ["cli-discovery"],
		queryFn: fetchCliDiscovery,
		enabled,
		retry: false,
		staleTime: 60_000,
	});

	if (query.isPending && enabled) {
		return { status: "loading" };
	}
	return query.data
		? { status: "ready", document: query.data }
		: { status: "unavailable" };
}
