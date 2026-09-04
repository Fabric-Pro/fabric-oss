/**
 * TanStack Query hooks for the `aiUsageLimits` sub-namespace.
 * Covers the four wire procedures registered in
 * `packages/api/modules/payments/router.ts`:
 * - `aiUsageLimits.list` — read every active limit row in scope
 * - `aiUsageLimits.status` — read each limit's current counter value
 * - `aiUsageLimits.upsert` — create/update a single limit
 * - `aiUsageLimits.delete` — soft-archive a single limit
 * Cadence:
 * - `status` refetches on window focus and every 30s (matches the
 * cadence the retired credits banner used — gentle on the chokepoint).
 * `staleTime: 10_000` so back-to-back navigations within a 10s
 * window reuse the cache.
 * - `list` is more static — `staleTime: 60_000`, refetches on window
 * focus only.
 * Query-key shape mirrors the standards example in
 * `fabric/standards/frontend/components.md` §"State Management with
 * TanStack Query": namespaced array, builder-style key constants. The
 * `null` fallback for `organizationId` is intentional — TanStack Query
 * serialises `undefined` and `null` differently, and downstream
 * consumers rely on the personal-context key being stable across calls.
 * Mutations invalidate `aiUsageLimitsKeys.all`, which covers both
 * `list` and `status` in one shot. On error the hook only emits a
 * last-resort `toast.error(..)` fallback; consumers that care about
 * specific error UX should pass `onError` via `mutate(input, { onError
 * })` per the standards-recommended pattern.
 * Per `[frontend/components.md]` (TanStack Query patterns),
 * `[global/coding-style.md]` (explicit return types on hooks, named
 * exports, no `any`), and `[ai/ai-copy-tone.md]` (calm/advisory toast
 * copy).
 */
import { orpcClient } from "@shared/lib/orpc-client";
import {
	type UseMutationResult,
	type UseQueryResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

// Wire shapes inferred from the procedure return types so the hook
// surface stays in lock-step with the router. Re-exporting these gives
// downstream components a single import for both the hook and its data
// types (no need to reach into `@repo/api` directly).
export type AiUsageLimitsListResult = Awaited<
	ReturnType<typeof orpcClient.payments.aiUsageLimits.list>
>;
export type AiUsageLimitsStatusResult = Awaited<
	ReturnType<typeof orpcClient.payments.aiUsageLimits.status>
>;
export type AiUsageLimitDto = AiUsageLimitsListResult["limits"][number];
export type AiUsageLimitStatus = AiUsageLimitsStatusResult["statuses"][number];
export type UpsertAiUsageLimitInput = Parameters<
	typeof orpcClient.payments.aiUsageLimits.upsert
>[0];
export type UpsertAiUsageLimitResult = Awaited<
	ReturnType<typeof orpcClient.payments.aiUsageLimits.upsert>
>;
export type DeleteAiUsageLimitInput = Parameters<
	typeof orpcClient.payments.aiUsageLimits.delete
>[0];
export type DeleteAiUsageLimitResult = Awaited<
	ReturnType<typeof orpcClient.payments.aiUsageLimits.delete>
>;
export type AiUsageLimitProviderOptionsResult = Awaited<
	ReturnType<typeof orpcClient.payments.aiUsageLimits.providerOptions>
>;

interface ListFilters {
	organizationId: string | null;
}

interface StatusFilters {
	organizationId: string | null;
}

/**
 * Builder-style query keys per `[frontend/components.md]`. Keep
 * `aiUsageLimitsKeys.all` as the single invalidation root so a mutation
 * can invalidate both `list` and `status` with one call.
 */
export const aiUsageLimitsKeys = {
	all: ["aiUsageLimits"] as const,
	lists: () => [...aiUsageLimitsKeys.all, "list"] as const,
	list: (filters: ListFilters) =>
		[...aiUsageLimitsKeys.lists(), filters] as const,
	statuses: () => [...aiUsageLimitsKeys.all, "status"] as const,
	status: (filters: StatusFilters) =>
		[...aiUsageLimitsKeys.statuses(), filters] as const,
	providerOptions: (filters: { organizationId: string | null }) =>
		[...aiUsageLimitsKeys.all, "providerOptions", filters] as const,
};

/**
 * Fetch every active limit row in the caller's tenant scope.
 * Members of an org without owner/admin role still get a `200` from the
 * procedure with `{ limits: [], canManage: false }` (no toast, no
 * error) — render the empty state as usual and gate the management
 * controls on `canManage`.
 */
export function useAiUsageLimits(
	organizationId?: string | null,
): UseQueryResult<AiUsageLimitsListResult, Error> {
	const filters: ListFilters = { organizationId: organizationId ?? null };
	return useQuery({
		queryKey: aiUsageLimitsKeys.list(filters),
		queryFn: () =>
			orpcClient.payments.aiUsageLimits.list({
				organizationId: filters.organizationId,
			}),
		// Static-ish data — refetch on focus, 60s stale
		// window. The `status` hook handles the live counter values.
		refetchOnWindowFocus: true,
		staleTime: 60_000,
	});
}

/**
 * Fetch the live counter value + percent for every active limit. Cadence
 * — 30s polling, inherited from the retired credits banner, to keep load
 * gentle on the chokepoint.
 */
/**
 * Fetch the tenant's configured AI providers + their canonical model
 * names, used by the edit sheet to render Provider + Model selects.
 * Long staleTime — provider/model lists rarely change during a session.
 */
export function useAiUsageLimitProviderOptions(
	organizationId?: string | null,
	options: { enabled?: boolean } = {},
): UseQueryResult<AiUsageLimitProviderOptionsResult, Error> {
	const filters = { organizationId: organizationId ?? null };
	return useQuery({
		queryKey: aiUsageLimitsKeys.providerOptions(filters),
		queryFn: () =>
			orpcClient.payments.aiUsageLimits.providerOptions({
				organizationId: filters.organizationId,
			}),
		enabled: options.enabled ?? true,
		refetchOnWindowFocus: false,
		staleTime: 5 * 60_000,
	});
}

export function useAiUsageLimitsStatus(
	organizationId?: string | null,
): UseQueryResult<AiUsageLimitsStatusResult, Error> {
	const filters: StatusFilters = { organizationId: organizationId ?? null };
	return useQuery({
		queryKey: aiUsageLimitsKeys.status(filters),
		queryFn: () =>
			orpcClient.payments.aiUsageLimits.status({
				organizationId: filters.organizationId,
			}),
		refetchOnWindowFocus: true,
		refetchInterval: 30_000,
		staleTime: 10_000,
	});
}

/**
 * Create or update a single limit row. Invalidates both the `list` and
 * `status` caches on success so the card re-renders without a manual
 * round-trip.
 * Error UX is owned by the caller: pass an `onError` to `mutate(input,
 * { onError })` for sheet-level form errors. The `onError` here is a
 * last-resort fallback that fires only if the caller does not handle
 * the rejection — sonner deduplicates by content so a caller-supplied
 * toast will not stack with this one.
 * NOTE — no optimistic update in v1: the `status` cache row carries
 * server-derived counter / window / timezone fields that the client
 * cannot fabricate without a round-trip. Invalidation under the
 * default refetch policy is fast enough for a sheet-form save UX, and
 * shipping a partial-shape optimistic patch risks rendering stale
 * counter values or breaking the `status` row's TS shape. Re-evaluate
 * if the save → re-render lag becomes user-visible.
 */
export function useUpsertAiUsageLimit(): UseMutationResult<
	UpsertAiUsageLimitResult,
	Error,
	UpsertAiUsageLimitInput
> {
	const queryClient = useQueryClient();
	const t = useTranslations();

	return useMutation({
		mutationFn: (input: UpsertAiUsageLimitInput) =>
			orpcClient.payments.aiUsageLimits.upsert(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: aiUsageLimitsKeys.all,
			});
			toast.success(t("settings.aiUsage.limits.sheet.savedToast"));
		},
		onError: (error) => {
			// Last-resort fallback only — the caller's `onError` runs
			// first; sonner dedupes identical content so a custom
			// caller toast wins.
			toast.error(
				error instanceof Error && error.message
					? error.message
					: t("settings.aiUsage.limits.sheet.saveErrorToast"),
			);
		},
	});
}

/**
 * Soft-archive a single limit. Invalidates both caches on success and
 * surfaces a calm "removed" toast.
 */
export function useDeleteAiUsageLimit(): UseMutationResult<
	DeleteAiUsageLimitResult,
	Error,
	DeleteAiUsageLimitInput
> {
	const queryClient = useQueryClient();
	const t = useTranslations();

	return useMutation({
		mutationFn: (input: DeleteAiUsageLimitInput) =>
			orpcClient.payments.aiUsageLimits.delete(input),
		onSuccess: (_data, variables) => {
			// Drop the deleted row from any cached list snapshot so the
			// card stops rendering it before the refetch lands. Status
			// rows are cleared via the broader `invalidateQueries`
			// below — they always come from the server with derived
			// counter fields, so a partial cache patch is unsafe.
			queryClient.setQueriesData<AiUsageLimitsListResult>(
				{ queryKey: aiUsageLimitsKeys.lists() },
				(prev) => {
					if (!prev) {
						return prev;
					}
					return {
						...prev,
						limits: prev.limits.filter(
							(limit) => limit.id !== variables.id,
						),
					};
				},
			);
			void queryClient.invalidateQueries({
				queryKey: aiUsageLimitsKeys.all,
			});
			toast.success(t("settings.aiUsage.limits.sheet.deletedToast"));
		},
		onError: (error) => {
			toast.error(
				error instanceof Error && error.message
					? error.message
					: t("settings.aiUsage.limits.sheet.deleteErrorToast"),
			);
		},
	});
}
