"use client";

import {
	listPromptActions,
	PROMPT_FEATURE_TYPES,
	type PromptFeatureTypeKey,
	promptActionId,
} from "@repo/utils/prompt-action-catalog";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

/**
 * Where an organization's prompt configuration stands, in one view (FR24).
 *
 * The catalog answers "what runs this action?" one action at a time. An admin
 * deciding where to spend effort has the opposite question — which actions has
 * nobody here configured — and answering it by opening thirty catalog entries in
 * turn is how it does not get answered at all.
 *
 * Restructured per the PM's review (Fizzy #2068 F7): the actions split into two
 * collapsible groups — the ones this organization has overridden, and the ones
 * still falling back to Universal or built-in text. Built from the catalog
 * payload rather than a query of its own: the tier in force is already computed
 * there, by the same rule the runtime resolver uses, and a second computation is
 * a second chance to disagree with it.
 */

type CatalogEntry = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
	effectiveScope: "SYSTEM" | "ORG" | "USER" | null;
};

type Tier = "ORG" | "SYSTEM" | "NONE";

const ALL_ACTIONS = listPromptActions();

/** What an org admin can do about each state, which is why they are grouped. */
const TIER_PRESENTATION: Record<
	string,
	{ label: string; className: string; hint: string }
> = {
	ORG: {
		label: "Organization",
		className: "bg-success/10 text-success",
		hint: "This organization has set its own prompt.",
	},
	SYSTEM: {
		label: "System",
		className: "bg-muted text-muted-foreground",
		hint: "Falling back to the Fabric default — no organization override.",
	},
	NONE: {
		label: "Built-in",
		className: "bg-muted text-muted-foreground",
		// Deliberately hedged: this bucket holds actions with nothing bound AND
		// actions whose only default is somebody's personal override, which is
		// not an organization-level answer (see tierByAction) but is also not
		// "nothing bound". Claiming the latter outright would be false.
		hint: "No organization or Fabric default; the agent uses its in-code text unless someone has a personal override.",
	},
};

function Section({
	title,
	count,
	expanded,
	onToggle,
	children,
}: {
	title: string;
	count: number;
	expanded: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	return (
		<section>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/40"
			>
				<span className="font-medium text-sm">{title}</span>
				<span className="flex items-center gap-2">
					<Badge variant="outline">{count}</Badge>
					<span className="text-muted-foreground text-xs">
						{expanded ? "Hide" : "Show"}
					</span>
				</span>
			</button>
			{expanded && (
				<ul className="divide-y rounded-lg border">{children}</ul>
			)}
		</section>
	);
}

export function PromptGovernanceDashboard() {
	const { organizationId, basePath } = useOrganizationContext();
	const [overridesOpen, setOverridesOpen] = useState(true);
	const [fallbacksOpen, setFallbacksOpen] = useState(true);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["prompt-catalog", organizationId],
		queryFn: async () =>
			await orpcClient.prompts.catalog.list({
				organizationId: organizationId ?? null,
			}),
	});

	const tierByAction = useMemo(() => {
		const map = new Map<string, Tier>();
		for (const entry of (data?.entries ?? []) as CatalogEntry[]) {
			const id = promptActionId(
				entry.targetKey,
				entry.documentType,
				entry.storyKind,
			);
			// A personal override belongs to one person and is not an
			// organization-level answer, so it does not count as configured here.
			map.set(
				id,
				entry.effectiveScope === "ORG"
					? "ORG"
					: entry.effectiveScope === "SYSTEM"
						? "SYSTEM"
						: "NONE",
			);
		}
		return map;
	}, [data]);

	const { overridden, fallbacks } = useMemo(() => {
		const overridden: Array<{
			action: (typeof ALL_ACTIONS)[number];
			tier: Tier;
		}> = [];
		const fallbacks: Array<{
			action: (typeof ALL_ACTIONS)[number];
			tier: Tier;
		}> = [];
		for (const action of ALL_ACTIONS) {
			const tier = tierByAction.get(action.id) ?? "NONE";
			(tier === "ORG" ? overridden : fallbacks).push({ action, tier });
		}
		return { overridden, fallbacks };
	}, [tierByAction]);

	const renderRow = ({
		action,
		tier,
	}: {
		action: (typeof ALL_ACTIONS)[number];
		tier: Tier;
	}) => {
		const presentation = TIER_PRESENTATION[tier];
		return (
			<li key={action.id}>
				<Link
					href={`${basePath}/prompts/catalog?action=${encodeURIComponent(action.id)}`}
					className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40"
				>
					<div className="min-w-0">
						<p className="truncate font-medium text-sm">
							{action.label}
						</p>
						<p className="truncate text-muted-foreground text-xs">
							{
								PROMPT_FEATURE_TYPES[
									action.featureType as PromptFeatureTypeKey
								].label
							}
							{" · "}
							{presentation.hint}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Badge className={presentation.className}>
							{presentation.label}
						</Badge>
						<ChevronRightIcon className="size-4 text-muted-foreground" />
					</div>
				</Link>
			</li>
		);
	};

	// A failed catalog read leaves every action in the fallback bucket, which
	// would render as the confident claim that the organization has configured
	// nothing. Say we could not check instead — this page is read as a
	// governance audit.
	if (error) {
		return (
			<div className="space-y-4 py-8 text-center" role="alert">
				<p className="text-muted-foreground text-sm">
					Could not load your organization's prompt configuration.
				</p>
				<button
					type="button"
					onClick={() => refetch()}
					className="font-medium text-primary text-sm underline-offset-4 hover:underline"
				>
					Try again
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">
				{isLoading
					? "Checking every action…"
					: `${fallbacks.length} of ${ALL_ACTIONS.length} actions have no organization prompt.`}
			</p>

			<Section
				title="Organization overrides"
				count={overridden.length}
				expanded={overridesOpen}
				onToggle={() => setOverridesOpen((v) => !v)}
			>
				{overridden.map(renderRow)}
			</Section>

			<Section
				title="No organization override"
				count={fallbacks.length}
				expanded={fallbacksOpen}
				onToggle={() => setFallbacksOpen((v) => !v)}
			>
				{fallbacks.map(renderRow)}
			</Section>
		</div>
	);
}
