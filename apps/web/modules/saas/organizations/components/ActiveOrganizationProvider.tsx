"use client";

import { authClient } from "@repo/auth/client";
import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { sessionQueryKey } from "@saas/auth/lib/api";
import {
	activeOrganizationQueryKey,
	useActiveOrganizationQuery,
} from "@saas/organizations/lib/api";
import { useRouter } from "@shared/hooks/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import nProgress from "nprogress";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { ActiveOrganizationContext } from "../lib/active-organization-context";

// Safety net: if a switch never commits the expected route (a redirect, a 404,
// a revoked membership, or a hung request), force-clear the in-flight state
// after this long so the switcher and progress bar can't get stuck.
const SWITCH_WATCHDOG_MS = 12_000;

export function ActiveOrganizationProvider({
	children,
}: {
	children: ReactNode;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { session, user } = useSession();
	const params = useParams();
	const t = useTranslations();

	const activeOrganizationSlug = params.organizationSlug as
		| string
		| undefined;

	// In-flight workspace switch. `switchTarget` (state) drives the switcher's
	// inline loading UI; `switchInFlightRef` is the synchronous guard that wins
	// the double-click race before React commits the state update (AC3).
	const [switchTarget, setSwitchTarget] = useState<{
		slug: string | null;
	} | null>(null);
	const switchInFlightRef = useRef(false);
	// Watchdog timer id (so we can cancel it) + a generation counter so a
	// superseded or late-resolving switch can never clobber a newer one.
	const switchWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const switchGenerationRef = useRef(0);

	// Release the in-flight switch state from any path — route commit, error,
	// or watchdog — and always complete the top progress bar.
	const clearSwitchState = useCallback(() => {
		switchInFlightRef.current = false;
		if (switchWatchdogRef.current) {
			clearTimeout(switchWatchdogRef.current);
			switchWatchdogRef.current = null;
		}
		setSwitchTarget(null);
		nProgress.done();
	}, []);

	// Query is only enabled when we have an org slug in the URL
	const { data: queriedOrganization } = useActiveOrganizationQuery(
		activeOrganizationSlug ?? "",
		{
			enabled: !!activeOrganizationSlug,
		},
	);

	// CRITICAL: When not in org context (no slug in URL), explicitly set to null
	// This prevents stale React Query data from leaking org context to personal pages
	const activeOrganization = activeOrganizationSlug
		? queriedOrganization
		: null;

	// Track previous org to detect context switches
	const prevOrgSlugRef = useRef<string | undefined>(activeOrganizationSlug);

	// Invalidate all queries when organization context changes
	// This ensures fresh data when switching between personal and org contexts
	useEffect(() => {
		const prevOrgSlug = prevOrgSlugRef.current;
		const currentOrgSlug = activeOrganizationSlug;

		// Detect context change (org -> personal, personal -> org, or org -> different org)
		if (prevOrgSlug !== currentOrgSlug) {
			// Invalidate all queries to force refetch with new context
			// This is critical for security - prevents stale org data on personal pages
			queryClient.invalidateQueries();
			prevOrgSlugRef.current = currentOrgSlug;
		}
	}, [activeOrganizationSlug, queryClient]);

	const refetchActiveOrganization = async () => {
		if (activeOrganizationSlug) {
			await queryClient.refetchQueries({
				queryKey: activeOrganizationQueryKey(activeOrganizationSlug),
			});
		}
	};

	const setActiveOrganization = async (organizationSlug: string | null) => {
		// Ignore repeat clicks while a switch is already running (AC3).
		if (switchInFlightRef.current) {
			return;
		}
		// No-op when the requested workspace is already active.
		const currentSlug = activeOrganizationSlug ?? null;
		if (currentSlug === organizationSlug) {
			return;
		}

		// Start the inline loading state immediately so feedback is instant,
		// before the server round-trip (AC2).
		switchInFlightRef.current = true;
		const generation = ++switchGenerationRef.current;
		setSwitchTarget({ slug: organizationSlug });
		nProgress.start();

		if (switchWatchdogRef.current) {
			clearTimeout(switchWatchdogRef.current);
		}
		switchWatchdogRef.current = setTimeout(() => {
			if (
				switchInFlightRef.current &&
				switchGenerationRef.current === generation
			) {
				// This switch never committed — supersede it and recover.
				switchGenerationRef.current++;
				clearSwitchState();
			}
		}, SWITCH_WATCHDOG_MS);

		// Optimistic navigation: enter the target workspace immediately so a
		// click made while it loads stays *within* the new workspace instead of
		// racing the switch and bouncing back to the old one. The org/personal
		// context is URL-driven (OrganizationLayout resolves the org from the
		// slug and 404s on non-membership; API calls pass an explicit,
		// URL-derived org id), so tenant isolation holds before `setActive`
		// persists the choice in the background.
		const previousPath = currentSlug ? `/app/${currentSlug}` : "/app";
		const targetPath = organizationSlug
			? `/app/${organizationSlug}`
			: "/app";
		router.push(targetPath);

		try {
			const { data: newActiveOrganization, error } =
				await authClient.organization.setActive(
					organizationSlug
						? {
								organizationSlug,
							}
						: {
								organizationId: null,
							},
				);

			// Ignore a superseded/late result (watchdog fired or a newer switch
			// started) so it can't clobber the current state or navigate.
			if (switchGenerationRef.current !== generation) {
				return;
			}

			if (error) {
				throw error;
			}

			// An org switch that resolves to no organization didn't actually
			// take (e.g. a revoked membership) — treat it as a failure and roll
			// back rather than stranding the user on a workspace they can't use.
			if (organizationSlug && !newActiveOrganization) {
				throw new Error("Workspace switch did not resolve");
			}

			// Persist the active workspace in the session cache. Data freshness
			// for the new context is handled by the invalidate-on-context-change
			// effect, which fires when the optimistic navigation above commits.
			queryClient.setQueryData(sessionQueryKey, (data: any) => {
				return {
					...data,
					session: {
						...data?.session,
						activeOrganizationId: newActiveOrganization?.id ?? null,
					},
				};
			});

			// Persist for cross-session redirect on next login. Fire-and-forget —
			// a failure here does not block navigation.
			orpcClient.users
				.updateLastActiveWorkspace({
					organizationId: newActiveOrganization?.id ?? null,
				})
				.catch(() => {
					// silent — non-critical persistence, will be updated on next switch
				});

			// Warm the billing cache in the background (org context only).
			if (newActiveOrganization && config.organizations.enableBilling) {
				void queryClient
					.prefetchQuery(
						orpc.payments.listPurchases.queryOptions({
							input: {
								organizationId: newActiveOrganization.id,
							},
						}),
					)
					.catch(() => {
						// Non-critical warm-up; the org layout refetches anyway.
					});
			}
		} catch (_error) {
			// Ignore failures from a superseded switch.
			if (switchGenerationRef.current !== generation) {
				return;
			}
			// The switch couldn't be persisted — return to the previous
			// workspace and surface the error.
			clearSwitchState();
			toast.error(t("organizations.organizationSelect.switchError"));
			if (previousPath !== targetPath) {
				router.push(previousPath);
			}
		}
	};

	// Clear the in-flight switch once the new workspace's route commits, so the
	// inline spinner stays visible until navigation lands and the top progress
	// bar always completes — on every path, including the org-switch path that
	// previously never called nProgress.done().
	useEffect(() => {
		if (!switchTarget) {
			return;
		}
		const currentSlug = activeOrganizationSlug ?? null;
		if (currentSlug === switchTarget.slug) {
			clearSwitchState();
		}
	}, [activeOrganizationSlug, switchTarget, clearSwitchState]);

	// Cancel any pending watchdog if the provider unmounts mid-switch.
	useEffect(() => {
		return () => {
			if (switchWatchdogRef.current) {
				clearTimeout(switchWatchdogRef.current);
			}
		};
	}, []);

	const [loaded, setLoaded] = useState(activeOrganization !== undefined);

	useEffect(() => {
		if (!loaded && activeOrganization !== undefined) {
			setLoaded(true);
		}
	}, [activeOrganization]);

	const activeOrganizationUserRole = activeOrganization?.members.find(
		(member: { userId: string }) => member.userId === session?.userId,
	)?.role;

	const contextValue = useMemo(
		() => ({
			loaded,
			activeOrganization: activeOrganization ?? null,
			activeOrganizationUserRole: activeOrganizationUserRole ?? null,
			isOrganizationAdmin:
				!!activeOrganization &&
				!!user &&
				isOrganizationAdmin(activeOrganization, user),
			isSwitching: switchTarget !== null,
			switchingToSlug: switchTarget?.slug ?? null,
			setActiveOrganization,
			refetchActiveOrganization,
		}),
		[
			loaded,
			activeOrganization,
			activeOrganizationUserRole,
			user,
			switchTarget,
			setActiveOrganization,
			refetchActiveOrganization,
		],
	);

	return (
		<ActiveOrganizationContext.Provider value={contextValue}>
			{children}
		</ActiveOrganizationContext.Provider>
	);
}
