"use client";

/**
 * Instance-admin feature-flag console — the DEPLOYMENT-WIDE value.
 *
 * A flag the registry marks `orgScopable` can additionally carry a
 * per-organization override that outranks whatever is set here; those are
 * edited by `OrgFeatureFlagsPanel` on the admin organization page. So a value
 * shown here is what an organization resolves only in the absence of its own
 * row — turning a flag off here does not guarantee it is off for everyone.
 *
 * `source` is shown per row because "off" means something different depending
 * on whether it came from an explicit override, an env var, or the registry
 * default.
 */
import type { ApiRouterClient } from "@repo/api/orpc/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Switch } from "@ui/components/switch";
import { toast } from "sonner";

const SOURCE_LABEL: Record<string, string> = {
	override: "Set here",
	env: "From environment",
	default: "Default",
};

type FeatureFlagListResult = Awaited<
	ReturnType<ApiRouterClient["admin"]["featureFlags"]["list"]>
>;

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Input for the list query. Declared once so the read below and the two cache
 * patches derive their key from the same value and cannot drift apart.
 */
const LIST_INPUT = {};

export function FeatureFlagsPanel() {
	const queryClient = useQueryClient();
	const { data, isLoading, isError } = useQuery(
		orpc.admin.featureFlags.list.queryOptions({ input: LIST_INPUT }),
	);

	// MUST be `queryKey()`, never `key()`. oRPC exposes both, and they are not
	// interchangeable:
	//
	//   queryKey({ input }) → [path, { input, type: "query" }]   (full/exact)
	//   key()               → [path, {}]                         (partial)
	//
	// The partial form is built for `invalidateQueries`, which matches by
	// prefix. `setQueryData` hashes the key EXACTLY, so patching with `key()`
	// lands on a cache entry no component subscribes to — the updater is handed
	// `undefined`, returns `undefined`, and the write vanishes with no error and
	// no re-render. Since the handlers below deliberately do not refetch, there
	// is nothing left to correct it: the switch snaps straight back to its old
	// value and the change only appears after a full page reload. #2138.
	const listQueryKey = orpc.admin.featureFlags.list.queryKey({
		input: LIST_INPUT,
	});

	const setFlag = useMutation({
		...orpc.admin.featureFlags.set.mutationOptions(),
		// Patch the cache from the mutation's own authoritative response
		// rather than invalidating + refetching. `values-prod.yaml` runs the
		// web service at `replicas: 2`, and each replica holds an independent
		// 10s DB-backed flag cache (see TTL_MS in
		// packages/database/prisma/queries/feature-flags.ts). A refetch
		// issued right after this write is load-balanced across replicas, so
		// it can land on one whose cache hasn't caught up yet — the switch
		// would visibly snap back to the stale value, with no further
		// refetch scheduled to correct it. `setFeatureFlagProcedure` already
		// returns the value it just wrote, so trust that instead of racing
		// the cache. Do NOT "simplify" this back to `invalidateQueries`.
		onSuccess: (result, variables) => {
			queryClient.setQueryData(
				listQueryKey,
				(prev: FeatureFlagListResult | undefined) =>
					prev && {
						...prev,
						flags: prev.flags.map((flag) =>
							flag.key === variables.key
								? {
										...flag,
										enabled: result.enabled,
										source: "override" as const,
									}
								: flag,
						),
					},
			);
		},
		onError: (error: Error) => {
			toast.error("Failed to update feature flag", {
				description: errorMessage(error),
			});
		},
	});

	const resetFlag = useMutation({
		...orpc.admin.featureFlags.reset.mutationOptions(),
		// Patch from the reset's authoritative post-clear value/source for the
		// same reason `set` does (no refetch → no multi-replica flap). Unlike
		// `set`, the resulting source is not always "override": after clearing
		// the row the flag resolves to "env" or "default", which only the
		// server can determine — so we trust `result.source` here rather than
		// hardcoding it.
		onSuccess: (result, variables) => {
			queryClient.setQueryData(
				listQueryKey,
				(prev: FeatureFlagListResult | undefined) =>
					prev && {
						...prev,
						flags: prev.flags.map((flag) =>
							flag.key === variables.key
								? {
										...flag,
										enabled: result.enabled,
										source: result.source,
									}
								: flag,
						),
					},
			);
		},
		onError: (error: Error) => {
			toast.error("Failed to reset feature flag", {
				description: errorMessage(error),
			});
		},
	});

	if (isLoading) {
		return <p className="text-muted-foreground text-sm">Loading…</p>;
	}

	if (isError) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
				Failed to load feature flags.
			</div>
		);
	}

	if (!data?.flags.length) {
		return (
			<div className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
				No feature flags registered.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-sm">
				Takes effect server-side within ~10 seconds. Open tabs pick up
				the change on their next page load.
			</p>
			{data.flags.map((flag) => (
				<div
					key={flag.key}
					className="flex flex-row items-center justify-between rounded-lg border p-4"
				>
					<div className="flex-1 space-y-0.5">
						<span className="font-medium text-base">
							{flag.label}
						</span>
						<p className="text-muted-foreground text-sm">
							{flag.description}
						</p>
						<p className="text-muted-foreground text-xs">
							{SOURCE_LABEL[flag.source] ?? flag.source} ·{" "}
							<code>{flag.envVar}</code>
						</p>
						{flag.note && (
							<p className="text-highlight text-xs">
								{flag.note}
							</p>
						)}
					</div>
					<div className="flex items-center gap-3">
						{/* Only an override can be reset — an "env"/"default"
						    flag has no row to clear. This is the one control
						    that moves a flag's source back off "override"; `set`
						    always writes a row, so without it a toggled flag
						    could never return to its inherited value from the
						    UI. */}
						{flag.source === "override" && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									resetFlag.mutate({ key: flag.key })
								}
								disabled={resetFlag.isPending}
							>
								Reset to default
							</Button>
						)}
						<Switch
							checked={flag.enabled}
							onCheckedChange={(checked) =>
								setFlag.mutate({
									key: flag.key,
									enabled: checked,
								})
							}
							disabled={setFlag.isPending}
							aria-label={flag.label}
						/>
					</div>
				</div>
			))}
		</div>
	);
}
