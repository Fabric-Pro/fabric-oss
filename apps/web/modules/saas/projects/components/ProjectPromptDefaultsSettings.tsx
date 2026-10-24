"use client";

/**
 * ProjectPromptDefaultsSettings — which prompt each action runs for THIS
 * project (Fizzy #2068, project tier).
 *
 * The tier already existed everywhere but here: `PromptBinding` carries a
 * `projectId`, the resolver ranks a project-narrowed binding above the
 * organization's and below a personal override, and the catalog marks it
 * "PROJECT". What was missing was any way to create one, so a project could be
 * shown a tier nobody could set.
 *
 * A project default IS an organization binding narrowed to one project — the
 * same row, the same authorization. `bind.set` requires organization admin or
 * owner and `resolveProjectForOrg` proves the project belongs to the caller's
 * organization before writing, so this component adds a surface, never a
 * permission. Everyone else reads.
 *
 * What this project has chosen is pulled out on top; everything else is
 * grouped by product area, searchable and filterable by tier, with the first
 * area open. Seventy-odd expanded rows is how a list does not get read.
 *
 * Only the actions this organization is offered are grouped and counted. With
 * the Proposal artifact on, a project default saved at a legacy Proposal action
 * never runs (Fizzy #2946); it is listed apart as no longer used, with Clear,
 * because dropping it from the list would leave no way to remove it.
 */

import {
	listPromptActions,
	PROMPT_FEATURE_TYPE_OPTIONS,
	PROMPT_FEATURE_TYPES,
	type PromptAction,
	type PromptFeatureTypeKey,
	promptActionId,
} from "@repo/utils/prompt-action-catalog";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useOfferedPromptActions } from "@saas/prompts/hooks/use-offered-prompt-actions";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	ArrowUpRightIcon,
	ChevronRightIcon,
	LockIcon,
	SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PromptDefaultRow } from "./prompt-defaults/PromptDefaultRow";
import { PromptDefaultsGroups } from "./prompt-defaults/PromptDefaultsGroups";
import { PromptTierBadge } from "./prompt-defaults/PromptTierBadge";
import {
	buildRow,
	type CatalogBinding,
	type CatalogEntry,
	countTiers,
	groupRows,
	PROMPT_DEFAULTS_ANCHOR_ID,
	type PromptDefaultRowModel,
	type PromptDefaultsFocusRequest,
	type PromptTier,
	projectDefaultOf,
	rowMatches,
	TIER_LABEL,
	TIER_ORDER,
	type TierFilter,
} from "./prompt-defaults/prompt-default-model";

const ALL_ACTIONS_BY_ID = new Map(
	listPromptActions().map((action) => [action.id, action]),
);

const PRECEDENCE: ReadonlyArray<{
	tier: PromptTier;
	label: string;
}> = [
	{ tier: "USER", label: "Personal" },
	{ tier: "PROJECT", label: "Project · set here" },
	{ tier: "ORG", label: "Organization" },
	{ tier: "SYSTEM", label: "System" },
	{ tier: "NONE", label: "Built-in" },
];

const FIRST_GROUP = PROMPT_FEATURE_TYPE_OPTIONS[0].key;

function MemberLockNote() {
	return (
		<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
			<LockIcon aria-hidden="true" className="size-3" />
			Organization admins and owners can change these.
		</p>
	);
}

export function ProjectPromptDefaultsSettings({
	projectId,
	focusRequest,
}: {
	projectId: string;
	focusRequest?: PromptDefaultsFocusRequest | null;
}) {
	const { organizationId, basePath } = useOrganizationContext();
	const offered = useOfferedPromptActions();
	const tSuperseded = useTranslations(
		"projects.proposalArtifact.supersededAction",
	);
	// Deliberately NOT the project's own settings permission. A project default
	// is an organization binding, and `bind.set` requires organization admin or
	// owner — a project admin who is not one would be shown a control the
	// server refuses. Gate the affordance on the same thing the write gates on.
	const { isOrganizationAdmin } = useActiveOrganization();
	const canEdit = isOrganizationAdmin;
	const [pending, setPending] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [tierFilter, setTierFilter] = useState<TierFilter>("ALL");
	const [openGroups, setOpenGroups] = useState<
		ReadonlySet<PromptFeatureTypeKey>
	>(() => new Set([FIRST_GROUP]));

	useEffect(() => {
		if (focusRequest) {
			setSearch(focusRequest.search);
			setTierFilter("ALL");
		}
	}, [focusRequest]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["project-prompt-catalog", organizationId, projectId],
		queryFn: async () =>
			await orpcClient.prompts.catalog.list({
				organizationId: organizationId ?? null,
				projectId,
			}),
		// Personal context has no project tier to configure.
		enabled: !!organizationId,
	});

	const byAction = useMemo(() => {
		const map = new Map<string, CatalogEntry>();
		for (const entry of (data?.entries ?? []) as CatalogEntry[]) {
			map.set(
				promptActionId(
					entry.targetKey,
					entry.documentType,
					entry.storyKind,
				),
				entry,
			);
		}
		return map;
	}, [data]);

	const target = (action: PromptAction) => ({
		targetKey: action.targetKey,
		documentType: action.documentType,
		storyKind: action.storyKind ?? null,
	});

	const setForProject = useMutation({
		mutationFn: async ({
			action,
			promptVersionId,
		}: {
			action: PromptAction;
			promptVersionId: string;
			/** Whether the writer's own personal default was in force for this
			 *  action, and so is about to be stood down by this write. */
			clearsOwnPersonal: boolean;
		}) =>
			await orpcClient.prompts.bindings.set({
				targetType: "AGENT",
				...target(action),
				// A project default is an ORG binding narrowed to one project.
				scope: "ORG",
				organizationId: organizationId ?? null,
				projectId,
				promptVersionId,
				isDefault: true,
			}),
		onSuccess: async (_result, { clearsOwnPersonal }) => {
			// Setting an org-scope default stands the writer's own personal
			// default for that action down, so that what they just chose is
			// what they get. Saying nothing left them to discover it later,
			// somewhere else, with no way to connect it to this click.
			toast.success("This project now uses that prompt", {
				description: clearsOwnPersonal
					? "Your personal default for this action was cleared, so this is what you will get too. You can set it again from the prompt catalog."
					: undefined,
			});
			await refetch();
		},
		onError: (e) =>
			toast.error("Could not set the prompt for this project", {
				description: e instanceof Error ? e.message : String(e),
			}),
		onSettled: () => setPending(null),
	});

	const clearForProject = useMutation({
		mutationFn: async (action: PromptAction) =>
			await orpcClient.prompts.bindings.clear({
				targetType: "AGENT",
				...target(action),
				scope: "ORG",
				organizationId: organizationId ?? null,
				projectId,
			}),
		onSuccess: async () => {
			toast.success(
				"Cleared — this project follows the organization again",
			);
			await refetch();
		},
		onError: (e) =>
			toast.error("Could not clear the project override", {
				description: e instanceof Error ? e.message : String(e),
			}),
		onSettled: () => setPending(null),
	});

	const rows = useMemo(
		() =>
			offered.actions.map((action) =>
				buildRow(action, byAction.get(action.id), projectId),
			),
		[byAction, projectId, offered.actions],
	);

	// Project defaults at an action the Proposal artifact supersedes. Named
	// from the full catalog, so the row reads as the action it was saved at.
	const noLongerUsed = useMemo(() => {
		const result: PromptDefaultRowModel[] = [];
		for (const [id, entry] of byAction) {
			if (
				!offered.isSuperseded(entry.targetKey, entry.documentType) ||
				!projectDefaultOf(entry, projectId)
			) {
				continue;
			}
			const action = ALL_ACTIONS_BY_ID.get(id);
			if (action) {
				result.push(buildRow(action, entry, projectId));
			}
		}
		return result;
	}, [byAction, projectId, offered]);

	const overridden = rows.filter((row) => row.own);
	const tierCounts = countTiers(rows);
	const filtering = search.trim() !== "" || tierFilter !== "ALL";
	const groups = groupRows(rows, (row) =>
		rowMatches(row, search, tierFilter),
	).filter((group) => !filtering || group.items.length > 0);

	if (!organizationId) {
		return null;
	}

	if (isLoading) {
		return (
			<Card id={PROMPT_DEFAULTS_ANCHOR_ID} className="space-y-2 p-6">
				<h3 className="font-semibold text-base">Prompt defaults</h3>
				<p className="text-muted-foreground text-sm">
					Checking every action…
				</p>
			</Card>
		);
	}

	// A failed read would otherwise render as "this project overrides nothing",
	// which is a claim rather than an answer.
	if (error) {
		return (
			<Card
				id={PROMPT_DEFAULTS_ANCHOR_ID}
				className="space-y-4 p-6"
				role="alert"
			>
				<h3 className="font-semibold text-base">Prompt defaults</h3>
				<p className="text-muted-foreground text-sm">
					Could not load which prompts this project uses.
				</p>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					Try again
				</Button>
			</Card>
		);
	}

	const rowActions = {
		basePath,
		canEdit,
		onSet: (row: PromptDefaultRowModel, binding: CatalogBinding) => {
			setPending(row.action.id);
			setForProject.mutate({
				action: row.action,
				promptVersionId: binding.promptVersionId,
				clearsOwnPersonal: row.clearsOwnPersonal,
			});
		},
		onClear: (row: PromptDefaultRowModel) => {
			setPending(row.action.id);
			clearForProject.mutate(row.action);
		},
	};

	const tierChips: ReadonlyArray<{
		key: TierFilter;
		label: string;
		count: number;
	}> = [
		{ key: "ALL", label: "All", count: rows.length },
		// Personal only when someone has one: an empty chip for a tier this
		// card never sets reads as something to set.
		...TIER_ORDER.filter(
			(tier) => tier !== "USER" || tierCounts.USER > 0,
		).map((tier) => ({
			key: tier,
			label: TIER_LABEL[tier],
			count: tierCounts[tier],
		})),
	];

	const query = search.trim();

	return (
		<Card
			id={PROMPT_DEFAULTS_ANCHOR_ID}
			className="scroll-mt-6 overflow-hidden p-0"
		>
			<div className="space-y-3 px-4 pt-5 pb-4 sm:px-6">
				<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
					<div className="min-w-0">
						<h3 className="font-semibold text-base">
							Prompt defaults
						</h3>
						<p className="mt-1 text-pretty text-muted-foreground text-sm">
							{`${overridden.length} of ${rows.length} actions use a prompt chosen for this project. The rest follow the organization, then the system default.`}
						</p>
					</div>
					<Link
						href={`${basePath}/prompts/catalog`}
						className="mt-1 inline-flex items-center gap-1 whitespace-nowrap text-foreground/90 text-xs hover:text-foreground hover:underline"
					>
						Open Prompt Library
						<ArrowUpRightIcon
							aria-hidden="true"
							className="size-3"
						/>
					</Link>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
					<span className="mr-1">First one set wins</span>
					{PRECEDENCE.map(({ tier, label }, i) => (
						<span
							key={tier}
							className="inline-flex items-center gap-1.5"
						>
							{i > 0 && (
								<>
									<ChevronRightIcon
										aria-hidden="true"
										className="size-3"
									/>
									<span className="sr-only">then</span>
								</>
							)}
							<PromptTierBadge tier={tier}>
								{label}
							</PromptTierBadge>
						</span>
					))}
				</div>
				<p className="text-muted-foreground text-xs">
					Anyone who has set their own prompt for an action keeps it
					here.
				</p>
				{!canEdit && <MemberLockNote />}
			</div>

			{overridden.length > 0 && (
				<section
					aria-labelledby="project-prompt-defaults-chosen"
					className="mx-4 mb-4 rounded-lg border border-primary/30 bg-primary/5 sm:mx-6"
				>
					<div className="flex items-center justify-between gap-3 border-primary/20 border-b px-4 py-2.5">
						<span
							id="project-prompt-defaults-chosen"
							className="font-medium text-[13px]"
						>
							Chosen for this project
						</span>
						<PromptTierBadge tier="PROJECT">
							{overridden.length}
						</PromptTierBadge>
					</div>
					<ul className="p-1">
						{overridden.map((row) => (
							<PromptDefaultRow
								key={row.action.id}
								row={row}
								title={row.action.label}
								subtitle={
									PROMPT_FEATURE_TYPES[row.action.featureType]
										.label
								}
								busy={pending === row.action.id}
								{...rowActions}
							/>
						))}
					</ul>
				</section>
			)}

			<div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 sm:px-6">
				<div className="relative min-w-0 flex-[1_1_240px]">
					<SearchIcon
						aria-hidden="true"
						className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
					/>
					<SearchInput
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search actions or prompts…"
						aria-label="Search prompt actions"
						className="pl-9"
					/>
				</div>
				<fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
					<legend className="sr-only">
						Filter by where the prompt comes from
					</legend>
					{tierChips.map((chip) => {
						const active = tierFilter === chip.key;
						return (
							<button
								key={chip.key}
								type="button"
								aria-pressed={active}
								onClick={() =>
									setTierFilter(
										active && chip.key !== "ALL"
											? "ALL"
											: chip.key,
									)
								}
								className={cn(
									"inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "border-foreground/30 bg-muted text-foreground"
										: "border-border text-muted-foreground hover:text-foreground",
								)}
							>
								{chip.label}{" "}
								<span className="font-mono text-[10.5px] text-muted-foreground">
									{chip.count}
								</span>
							</button>
						);
					})}
				</fieldset>
			</div>

			{groups.length > 0 ? (
				<PromptDefaultsGroups
					groups={groups}
					filtering={filtering}
					openGroups={openGroups}
					onToggleGroup={(key) => {
						if (filtering) {
							return;
						}
						setOpenGroups((current) => {
							const next = new Set(current);
							if (!next.delete(key)) {
								next.add(key);
							}
							return next;
						});
					}}
					pendingActionId={pending}
					{...rowActions}
				/>
			) : (
				<div className="flex flex-col items-center gap-2.5 border-t px-6 py-8 text-center">
					<p className="text-muted-foreground text-sm">
						{query
							? `No actions match “${query}”.`
							: "No actions in this tier."}
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setSearch("");
							setTierFilter("ALL");
						}}
					>
						Clear filters
					</Button>
				</div>
			)}

			{noLongerUsed.length > 0 && (
				<section
					aria-labelledby="project-prompt-defaults-no-longer-used"
					className="border-t px-4 py-4 sm:px-6"
				>
					<p
						id="project-prompt-defaults-no-longer-used"
						className="font-medium text-sm"
					>
						{tSuperseded("projectGroupTitle")}
					</p>
					<p className="pb-2 text-muted-foreground text-sm">
						{tSuperseded("projectGroupDescription")}
					</p>
					<ul>
						{noLongerUsed.map((row) => (
							<PromptDefaultRow
								key={row.action.id}
								row={row}
								title={row.action.label}
								subtitle={null}
								note={tSuperseded("actionNote")}
								busy={pending === row.action.id}
								{...rowActions}
							/>
						))}
					</ul>
				</section>
			)}
		</Card>
	);
}
