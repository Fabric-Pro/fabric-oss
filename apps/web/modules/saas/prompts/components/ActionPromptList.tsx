"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { PromptScopeBadge } from "./PromptScopeBadge";

/**
 * Tier 3 of the catalog: every prompt bound to one action, and a way to switch.
 *
 * FR9 asks for the variants to be visible, FR10 for any of them to be
 * selectable, and FR8 depends on both — the "an improvement is available"
 * notification deep-links here, so a page that only names the winning prompt
 * lands the reader somewhere they cannot act.
 *
 * Which tier a switch writes at is not the user's to pick here; it is whichever
 * one they are entitled to, because that is the only tier that would actually
 * take effect for them:
 *
 *   - personal context  -> their own personal default
 *   - organization, admin -> the organization's default
 *   - organization, member -> a proposal, since a personal default is not
 *     consulted at all while an organization is active
 *
 * That last case is the one worth stating plainly. Offering a member a personal
 * override inside an organization would write a row the runtime never reads.
 */

export type ActionPromptVariant = {
	promptId: string;
	promptName: string;
	promptVersionId: string;
	scope: "SYSTEM" | "ORG" | "USER";
	/** Set when this ORG binding is narrowed to one project (PROJECT tier). */
	projectId: string | null;
	isDefault: boolean;
	isEffective: boolean;
};

type Props = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
	prompts: ActionPromptVariant[];
	basePath: string;
	/** Refetch the catalog after a switch lands. */
	onChanged: () => void;
};

/** The tier a variant competes at — an ORG row narrowed to a project is the
 *  PROJECT tier, which is what the resolver ranks by. */
function tierOf(v: Pick<ActionPromptVariant, "scope" | "projectId">) {
	return v.scope === "ORG" && v.projectId ? "PROJECT" : v.scope;
}

const TIER_RANK: Record<string, number> = {
	USER: 0,
	PROJECT: 1,
	ORG: 2,
	SYSTEM: 3,
};

export function ActionPromptList({
	targetKey,
	documentType,
	storyKind,
	prompts,
	basePath,
	onChanged,
}: Props) {
	const { organizationId, isOrgContext } = useOrganizationContext();
	const { isOrganizationAdmin } = useActiveOrganization();

	// Two separate acts, and they stopped being interchangeable once a personal
	// default started winning inside an organization (FR3):
	//
	//   "Use this"  — make it MY default. Effective for everyone, everywhere.
	//   the second  — change it for the whole organization: directly if you may
	//                 write that tier, otherwise as a proposal for review.
	//
	// This row previously offered members only the proposal, because a personal
	// override did nothing in an organization. It does now, so withholding the
	// personal option would deny them the one action that takes effect at once.
	const mustPropose = isOrgContext && !isOrganizationAdmin;

	const target = { targetKey, documentType, storyKind };

	const useForMe = useMutation({
		mutationFn: async (variant: ActionPromptVariant) =>
			await orpcClient.prompts.bind.set({
				targetType: "AGENT",
				...target,
				scope: "USER",
				organizationId: null,
				promptVersionId: variant.promptVersionId,
				isDefault: true,
			}),
		onSuccess: (_result, variant) => {
			toast.success(`"${variant.promptName}" is now your default here`);
			onChanged();
		},
		onError: (error) => {
			toast.error("Could not switch the prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const switchTo = useMutation({
		mutationFn: async (variant: ActionPromptVariant) => {
			if (mustPropose) {
				return await orpcClient.prompts.nominations.create({
					promptVersionId: variant.promptVersionId,
					targetScope: "ORG",
					organizationId: organizationId ?? null,
					targets: [target],
				});
			}

			return await orpcClient.prompts.bind.set({
				targetType: "AGENT",
				...target,
				scope: "ORG",
				organizationId: organizationId ?? null,
				promptVersionId: variant.promptVersionId,
				isDefault: true,
			});
		},
		onSuccess: (_result, variant) => {
			toast.success(
				mustPropose
					? `"${variant.promptName}" proposed — an admin will review it`
					: `"${variant.promptName}" is now the organization default`,
			);
			onChanged();
		},
		onError: (error) => {
			toast.error("Could not switch the prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	/**
	 * FR11: stand this tier's override down and let the tier below take over.
	 *
	 * Only offered on an override that is actually in force and that the caller
	 * may write — clearing changes what everyone at and below the tier receives,
	 * so it is the same authority as setting it. SYSTEM is never offered here:
	 * there is no tier beneath it to reveal, so "clearing" it would leave the
	 * action with no prompt rather than reverting anything.
	 */
	const clearOverride = useMutation({
		mutationFn: async (variant: ActionPromptVariant) =>
			await orpcClient.prompts.bind.clear({
				targetType: "AGENT",
				targetKey,
				documentType,
				storyKind,
				scope: variant.scope,
				organizationId: variant.scope === "ORG" ? organizationId : null,
				projectId:
					variant.scope === "ORG"
						? (variant.projectId ?? null)
						: null,
			}),
		onSuccess: () => {
			toast.success("Override cleared — the tier below now applies");
			onChanged();
		},
		onError: (error) => {
			toast.error("Could not clear the override", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const mayClear = (variant: ActionPromptVariant) => {
		if (!variant.isEffective || variant.scope === "SYSTEM") {
			return false;
		}
		const tier = tierOf(variant);
		// An override only means something if something sits beneath it.
		const hasLowerTier = prompts.some(
			(p) => (TIER_RANK[tierOf(p)] ?? 9) > (TIER_RANK[tier] ?? 9),
		);
		if (!hasLowerTier) {
			return false;
		}
		// An organization's override — org-wide or project-narrowed — is its
		// admins' to stand down. A personal one is always its owner's, in either
		// context — the catalog only ever returns the caller's own USER
		// bindings, so any personal variant shown here belongs to the person
		// looking at it.
		return variant.scope === "ORG" ? isOrganizationAdmin : true;
	};

	if (prompts.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				Nothing is bound to this action — the agent uses its built-in
				text.
			</p>
		);
	}

	const ordered = [...prompts].sort(
		(a, b) => (TIER_RANK[tierOf(a)] ?? 9) - (TIER_RANK[tierOf(b)] ?? 9),
	);

	return (
		<ul className="divide-y rounded-md border">
			{ordered.map((variant) => {
				const pending =
					useForMe.isPending &&
					useForMe.variables?.promptVersionId ===
						variant.promptVersionId;
				const busy = useForMe.isPending || switchTo.isPending;
				return (
					<li
						key={variant.promptVersionId}
						className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
					>
						<div className="flex min-w-0 items-center gap-2">
							<PromptScopeBadge scope={tierOf(variant)} />
							{variant.projectId && (
								<span className="shrink-0 text-muted-foreground text-xs">
									this project
								</span>
							)}
							<Link
								href={`${basePath}/prompts/${variant.promptId}`}
								className="truncate text-sm hover:underline"
							>
								{variant.promptName}
							</Link>
						</div>

						{variant.isEffective ? (
							<div className="flex shrink-0 items-center gap-2">
								<Badge className="bg-success/10 text-success">
									In force
								</Badge>
								{mayClear(variant) && (
									<Button
										variant="ghost"
										size="sm"
										disabled={clearOverride.isPending}
										onClick={() =>
											clearOverride.mutate(variant)
										}
									>
										{clearOverride.isPending && (
											<Loader2Icon className="mr-1.5 size-3 animate-spin" />
										)}
										Clear override
									</Button>
								)}
							</div>
						) : (
							<div className="flex shrink-0 items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => useForMe.mutate(variant)}
								>
									{pending && (
										<Loader2Icon className="mr-1.5 size-3 animate-spin" />
									)}
									Use this
								</Button>
								{isOrgContext && (
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => switchTo.mutate(variant)}
									>
										{mustPropose
											? "Propose for org"
											: "Set for org"}
									</Button>
								)}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
