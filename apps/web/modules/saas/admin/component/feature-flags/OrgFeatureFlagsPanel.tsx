"use client";

/**
 * Per-organization feature-flag console, rendered on the admin organization
 * page.
 *
 * The sibling `FeatureFlagsPanel` sets the instance-wide value; this one sets
 * the per-organization override that outranks it. Only flags the registry
 * marks `orgScopable` appear here — the resolver ignores an org-level value
 * for any other flag, so offering a switch for one would be a control that
 * reads back its own write and changes nothing.
 */
import type { ApiRouterClient } from "@repo/api/orpc/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { toast } from "sonner";

const SOURCE_LABEL: Record<string, string> = {
	"org-override": "Set for this organization",
	override: "Set instance-wide",
	env: "From environment",
	default: "Registry default",
};

/**
 * The control's three positions. `inherit` is not a value the table can hold —
 * it is the ABSENCE of a row, which is why choosing it calls `clearForOrg`
 * rather than writing `false`. Conflating the two is the mistake this whole
 * feature exists to prevent: a stored `false` excludes the organization from a
 * globally-enabled flag, while no row lets it follow the deployment.
 */
const CHOICE = {
	inherit: "inherit",
	enabled: "enabled",
	disabled: "disabled",
} as const;

type Choice = (typeof CHOICE)[keyof typeof CHOICE];

function choiceFor(orgOverride: boolean | null): Choice {
	if (orgOverride === null) {
		return CHOICE.inherit;
	}
	return orgOverride ? CHOICE.enabled : CHOICE.disabled;
}

type OrgFeatureFlagListResult = Awaited<
	ReturnType<ApiRouterClient["admin"]["featureFlags"]["listForOrg"]>
>;

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function OrgFeatureFlagsPanel({
	organizationId,
}: {
	organizationId: string;
}) {
	const queryClient = useQueryClient();

	// Declared once so the read and both cache patches derive their key from
	// the same value and cannot drift apart.
	const listInput = { organizationId };

	const { data, isLoading, isError } = useQuery(
		orpc.admin.featureFlags.listForOrg.queryOptions({ input: listInput }),
	);

	// MUST be `queryKey()`, never `key()`. `setQueryData` hashes the key
	// EXACTLY, while `key()` returns the partial form built for prefix-matching
	// `invalidateQueries`. Patching with `key()` lands on a cache entry no
	// component subscribes to: the updater receives `undefined`, returns
	// `undefined`, and the write vanishes with no error and no re-render. Since
	// the handlers below deliberately do not refetch, nothing would correct it.
	// #2138.
	const listQueryKey = orpc.admin.featureFlags.listForOrg.queryKey({
		input: listInput,
	});

	/**
	 * Patch one row from a mutation's authoritative response instead of
	 * invalidating and refetching.
	 *
	 * The web service runs at `replicas: 2`, each holding an independent 10s
	 * DB-backed flag cache. A refetch issued immediately after a write is
	 * load-balanced, so it can land on a replica whose cache has not caught up
	 * — the control would visibly snap back to the stale value with no further
	 * refetch scheduled to correct it. Both procedures re-resolve after their
	 * write precisely so this patch can be trusted. Do NOT "simplify" this
	 * back to `invalidateQueries`.
	 */
	function patchRow(
		key: string,
		next: {
			enabled: boolean;
			source: OrgFeatureFlagListResult["flags"][number]["source"];
			orgOverride: boolean | null;
		},
	) {
		queryClient.setQueryData(
			listQueryKey,
			(prev: OrgFeatureFlagListResult | undefined) =>
				prev && {
					...prev,
					flags: prev.flags.map((flag) =>
						flag.key === key ? { ...flag, ...next } : flag,
					),
				},
		);
	}

	const setFlag = useMutation({
		...orpc.admin.featureFlags.setForOrg.mutationOptions(),
		onSuccess: (result, variables) => {
			patchRow(variables.key, {
				enabled: result.enabled,
				source: result.source,
				orgOverride: result.orgOverride,
			});
		},
		onError: (error: Error) => {
			toast.error("Failed to update the organization's feature flag", {
				description: errorMessage(error),
			});
		},
	});

	const clearFlag = useMutation({
		...orpc.admin.featureFlags.clearForOrg.mutationOptions(),
		// After a clear the flag falls to "override", "env" or "default"
		// depending on state only the server can see, so the source is taken
		// from the response rather than assumed.
		onSuccess: (result, variables) => {
			patchRow(variables.key, {
				enabled: result.enabled,
				source: result.source,
				orgOverride: result.orgOverride,
			});
		},
		onError: (error: Error) => {
			toast.error("Failed to clear the organization's override", {
				description: errorMessage(error),
			});
		},
	});

	const isPending = setFlag.isPending || clearFlag.isPending;

	function onChoose(key: string, choice: Choice) {
		if (choice === CHOICE.inherit) {
			clearFlag.mutate({ organizationId, key });
			return;
		}
		setFlag.mutate({
			organizationId,
			key,
			enabled: choice === CHOICE.enabled,
		});
	}

	if (isLoading) {
		return <p className="text-muted-foreground text-sm">Loading…</p>;
	}

	if (isError) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
				Failed to load this organization's feature flags.
			</div>
		);
	}

	if (!data?.flags.length) {
		return (
			<div className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
				No feature flags can be scoped to a single organization.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-sm">
				Overrides the deployment-wide value for this organization only.
				Takes effect server-side within ~10 seconds; open tabs pick up
				the change on their next page load.
			</p>
			{data.flags.map((flag) => (
				<div
					key={flag.key}
					className="flex flex-row items-center justify-between gap-4 rounded-lg border p-4"
				>
					<div className="flex-1 space-y-0.5">
						<span className="font-medium text-base">
							{flag.label}
						</span>
						<p className="text-muted-foreground text-sm">
							{flag.description}
						</p>
						<p className="flex items-center gap-2 text-muted-foreground text-xs">
							<Badge
								variant={flag.enabled ? "success" : "outline"}
							>
								{flag.enabled ? "On" : "Off"}
							</Badge>
							<span>
								{SOURCE_LABEL[flag.source] ?? flag.source} ·{" "}
								<code>{flag.envVar}</code>
							</span>
						</p>
						{flag.note && (
							<p className="text-highlight text-xs">
								{flag.note}
							</p>
						)}
					</div>
					<Select
						value={choiceFor(flag.orgOverride)}
						onValueChange={(value) =>
							onChoose(flag.key, value as Choice)
						}
						disabled={isPending}
					>
						<SelectTrigger
							className="w-44"
							aria-label={`${flag.label} for this organization`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={CHOICE.inherit}>
								Inherit
							</SelectItem>
							<SelectItem value={CHOICE.enabled}>
								Enabled
							</SelectItem>
							<SelectItem value={CHOICE.disabled}>
								Disabled
							</SelectItem>
						</SelectContent>
					</Select>
				</div>
			))}
		</div>
	);
}
