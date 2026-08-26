"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

/** Master gate for the whole "Get started" experience. */
export const GET_STARTED_ENABLED = isMonitoringFeatureEnabled(
	"feature-get-started",
);

/**
 * Query key for the per-user onboarding state. Exported because consumers that
 * write progress also patch this cache entry directly (`setQueryData`).
 */
export const ONBOARDING_STATE_QUERY_KEY = [
	"users",
	"onboarding",
	"state",
] as const;

export type OnboardingStateData = Awaited<
	ReturnType<typeof orpcClient.users.onboarding.getState>
>;

export type OnboardingAction = Parameters<
	typeof orpcClient.users.onboarding.update
>[0]["action"];

/**
 * Cached read of the per-user onboarding state.
 *
 * Two components need it — the controller that owns the drawer/tour surfaces
 * and the pointer that marks the sidebar launcher — and they are siblings in
 * the app shell, so neither can provide context to the other. They share this
 * hook instead: the query never goes stale within a session, so the second
 * consumer costs no extra request.
 */
export function useOnboardingState() {
	const { user } = useSession();

	const { data } = useQuery({
		queryKey: ONBOARDING_STATE_QUERY_KEY,
		queryFn: () => orpcClient.users.onboarding.getState(),
		enabled: GET_STARTED_ENABLED && !!user,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});

	return { data, user };
}
