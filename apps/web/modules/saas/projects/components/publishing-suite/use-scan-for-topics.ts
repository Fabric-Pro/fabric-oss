"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * "Scan for topics" — the manual topic scan (formerly "Generate now"),
 * shared by the Publishing list and Settings → Publishing (Fizzy #2646).
 *
 * One owner for the result messages, so the two places that offer the
 * action can never describe the same server answer differently. The API
 * procedure keeps its name (`generateNow`): that is contract, not copy.
 *
 * The explicit `mutationKey` is what lets suites that mock `useMutation` by
 * key drive this hook's real lifecycle.
 */
const SCAN_FOR_TOPICS_MUTATION_KEY = "publishing-suite.scanForTopics";

export function useScanForTopics({
	projectId,
	organizationId,
	onStarted,
}: {
	projectId: string;
	organizationId: string | null;
	/** Runs when a scan was accepted or one is already running. */
	onStarted?: () => void;
}) {
	const mutation = useMutation({
		mutationKey: [SCAN_FOR_TOPICS_MUTATION_KEY, projectId],
		mutationFn: () =>
			orpcClient.projects.publishingSuite.generateNow({
				projectId,
				organizationId,
			}),
		onSuccess: (result) => {
			switch (result.status) {
				case "started":
					// "Requested", not "running", and no promise of new topics:
					// the server answers `started` after the dispatch call, which
					// can return without opening a cycle, and a run can end with
					// nothing. Refresh history lists every run's outcome.
					toast.success(
						"Scan requested. Its result will appear in Refresh history.",
					);
					onStarted?.();
					break;
				case "in_flight":
					toast.info("A scan is already in progress.");
					onStarted?.();
					break;
				case "rate_limited":
					toast.error(
						"Scan for topics was used recently — please wait up to an hour before trying again.",
					);
					break;
				case "unavailable":
					toast.error(
						"Topic scanning is temporarily unavailable. Try again shortly.",
					);
					break;
				default:
					// A status this client does not know yet — silence would
					// look like a dead button.
					toast.error(
						"Scan for topics returned an unrecognized response. Try again shortly.",
					);
					break;
			}
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start a topic scan.",
			);
		},
	});

	return { scan: () => mutation.mutate(), isPending: mutation.isPending };
}
