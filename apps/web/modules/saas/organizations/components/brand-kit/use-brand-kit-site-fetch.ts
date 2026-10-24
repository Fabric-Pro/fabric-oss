import { ORPCError } from "@orpc/client";
import {
	BRAND_FETCH_RUNNING_TTL_MS,
	type BrandFetchFailureCode,
} from "@repo/utils/proposal-artifact/brand-sources";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	type QueryKey,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BrandKit } from "./brand-kit-draft";

export type SiteStatus =
	| { state: "none" }
	| { state: "running" }
	| { state: "found"; colors: string[] }
	| { state: "failed"; code: BrandFetchFailureCode };

type SiteAttempt = NonNullable<BrandKit["siteFetch"]>;

/**
 * What the website fetch shows: a request in flight, then an explicit
 * request's refusal, then the stored website's own attempt.
 */
export function siteStatusOf(
	attempt: SiteAttempt | null,
	{
		pending,
		fetchError,
	}: { pending: boolean; fetchError: BrandFetchFailureCode | null },
): SiteStatus {
	if (pending) {
		return { state: "running" };
	}
	if (fetchError) {
		return { state: "failed", code: fetchError };
	}
	if (!attempt) {
		return { state: "none" };
	}
	if (attempt.status === "RUNNING") {
		return { state: "running" };
	}
	if (attempt.status === "FAILED") {
		return { state: "failed", code: attempt.failureCode ?? "failed" };
	}
	// SUCCEEDED: only the stored website's own result counts as found.
	if (attempt.resultWebsite !== attempt.website) {
		return { state: "none" };
	}
	const colors = [
		...(attempt.primaryColor ? [attempt.primaryColor] : []),
		...attempt.accentColors,
	];
	return colors.length > 0
		? { state: "found", colors }
		: { state: "failed", code: "no_colors" };
}

/**
 * The fetch of the stored website's declared colors: the request, the error
 * an explicit one is answered with, and the kit's re-read once a running
 * attempt has outlived its window.
 */
export function useBrandKitSiteFetch({
	organizationId,
	queryKey,
	kit,
}: {
	organizationId: string;
	/** The kit's query, which carries the attempt and is re-read after one. */
	queryKey: QueryKey;
	kit: BrandKit | undefined;
}) {
	const queryClient = useQueryClient();
	const [fetchError, setFetchError] = useState<BrandFetchFailureCode | null>(
		null,
	);

	const mutation = useMutation({
		mutationFn: (automatic: boolean) =>
			orpcClient.organizations.brandKit.fetchSite({
				organizationId,
				automatic,
			}),
		// The attempt's result lands in the kit's read; refresh it either way.
		onSettled: () => queryClient.invalidateQueries({ queryKey }),
	});

	const run = (automatic: boolean) => {
		setFetchError(null);
		mutation.mutate(automatic, {
			onError: (err) => {
				// An automatic call over the limit is recorded as a failed
				// attempt; only an explicit one is answered with an error.
				if (automatic) {
					return;
				}
				setFetchError(
					err instanceof ORPCError && err.code === "TOO_MANY_REQUESTS"
						? "rate_limited"
						: "failed",
				);
			},
		});
	};

	// The read says RUNNING until it is re-read; past the running window the
	// server reads the attempt as timed out, so re-read once it has passed.
	const storedAttempt =
		kit?.siteFetch && kit.siteFetch.website === kit.website
			? kit.siteFetch
			: null;
	const runningSince =
		storedAttempt?.status === "RUNNING"
			? new Date(storedAttempt.requestedAt).getTime()
			: null;
	useEffect(() => {
		if (runningSince === null) {
			return;
		}
		const timer = setTimeout(
			() => queryClient.invalidateQueries({ queryKey }),
			Math.max(
				runningSince + BRAND_FETCH_RUNNING_TTL_MS - Date.now(),
				0,
			) + 1000,
		);
		return () => clearTimeout(timer);
	}, [runningSince]);

	return {
		status: siteStatusOf(storedAttempt, {
			pending: mutation.isPending,
			fetchError,
		}),
		isPending: mutation.isPending,
		run,
		clearError: () => setFetchError(null),
	};
}

export type BrandKitSiteFetchState = ReturnType<typeof useBrandKitSiteFetch>;
