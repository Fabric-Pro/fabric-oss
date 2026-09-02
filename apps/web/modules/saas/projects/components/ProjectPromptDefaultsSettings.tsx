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
 * Grouped the way the organization overview groups (Fizzy #2068 F7): what this
 * project has overridden, and what it inherits. An admin deciding where to
 * spend effort wants the second list, and thirty expanded rows is how it does
 * not get read.
 */

import {
	listPromptActions,
	PROMPT_FEATURE_TYPES,
	type PromptFeatureTypeKey,
	promptActionId,
} from "@repo/utils/prompt-action-catalog";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type CatalogBinding = {
	promptId: string;
	promptName: string;
	promptVersionId: string;
	scope: "SYSTEM" | "ORG" | "USER";
	projectId: string | null;
	isDefault: boolean;
	isEffective: boolean;
};

type CatalogEntry = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
	effectiveScope: "SYSTEM" | "ORG" | "PROJECT" | "USER" | null;
	prompts: CatalogBinding[];
};

const ALL_ACTIONS = listPromptActions();

const TIER_LABEL: Record<string, string> = {
	PROJECT: "This project",
	ORG: "Organization",
	SYSTEM: "System",
	USER: "Personal",
	NONE: "Built-in",
};

export function ProjectPromptDefaultsSettings({
	projectId,
}: {
	projectId: string;
}) {
	const { organizationId } = useOrganizationContext();
	// Deliberately NOT the project's own settings permission. A project default
	// is an organization binding, and `bind.set` requires organization admin or
	// owner — a project admin who is not one would be shown a control the
	// server refuses. Gate the affordance on the same thing the write gates on.
	const { isOrganizationAdmin } = useActiveOrganization();
	const canEdit = isOrganizationAdmin;
	const [overriddenOpen, setOverriddenOpen] = useState(true);
	// null = follow the project's state. A project that has overridden nothing
	// would otherwise open on two lists it cannot act on, with the only thing
	// worth doing hidden behind a collapsed section.
	const [inheritedOpenChoice, setInheritedOpen] = useState<boolean | null>(
		null,
	);
	const [pending, setPending] = useState<string | null>(null);
	const [filter, setFilter] = useState("");

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

	const target = (action: (typeof ALL_ACTIONS)[number]) => ({
		targetKey: action.targetKey,
		documentType: action.documentType,
		storyKind: action.storyKind ?? null,
	});

	const setForProject = useMutation({
		mutationFn: async ({
			action,
			promptVersionId,
		}: {
			action: (typeof ALL_ACTIONS)[number];
			promptVersionId: string;
		}) =>
			await orpcClient.prompts.bind.set({
				targetType: "AGENT",
				...target(action),
				// A project default is an ORG binding narrowed to one project.
				scope: "ORG",
				organizationId: organizationId ?? null,
				projectId,
				promptVersionId,
				isDefault: true,
			}),
		onSuccess: async () => {
			toast.success("This project now uses that prompt");
			await refetch();
		},
		onError: (e) =>
			toast.error("Could not set the prompt for this project", {
				description: e instanceof Error ? e.message : String(e),
			}),
		onSettled: () => setPending(null),
	});

	const clearForProject = useMutation({
		mutationFn: async (action: (typeof ALL_ACTIONS)[number]) =>
			await orpcClient.prompts.bind.clear({
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

	// What this project has chosen is a property of the project, not of whoever
	// is looking. `effectiveScope` answers "what runs for ME", and a personal
	// override outranks the project tier (SCOPE_RANK: USER 0, PROJECT 1) — so
	// keying off it would file an admin's own project default under "inherited",
	// show it as "Personal", and hide the control to clear it.
	const projectDefaultOf = (action: (typeof ALL_ACTIONS)[number]) =>
		byAction
			.get(action.id)
			?.prompts.find(
				(p) =>
					p.scope === "ORG" &&
					p.projectId === projectId &&
					p.isDefault,
			);

	const { overridden, inherited } = useMemo(() => {
		const overridden: Array<(typeof ALL_ACTIONS)[number]> = [];
		const inherited: Array<(typeof ALL_ACTIONS)[number]> = [];
		for (const action of ALL_ACTIONS) {
			const own = byAction
				.get(action.id)
				?.prompts.find(
					(p) =>
						p.scope === "ORG" &&
						p.projectId === projectId &&
						p.isDefault,
				);
			(own ? overridden : inherited).push(action);
		}
		return { overridden, inherited };
	}, [byAction, projectId]);

	const inheritedOpen = inheritedOpenChoice ?? overridden.length === 0;

	if (!organizationId) {
		return null;
	}

	if (isLoading) {
		return (
			<Card className="space-y-2 p-6">
				<h3 className="font-medium text-base">
					Prompt defaults for this project
				</h3>
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
			<Card className="space-y-4 p-6" role="alert">
				<h3 className="font-medium text-base">
					Prompt defaults for this project
				</h3>
				<p className="text-muted-foreground text-sm">
					Could not load which prompts this project uses.
				</p>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					Try again
				</Button>
			</Card>
		);
	}

	const row = (action: (typeof ALL_ACTIONS)[number]) => {
		const entry = byAction.get(action.id);
		const own = projectDefaultOf(action);
		const isProject = !!own;
		// The tier badge reports the project's own choice when it has one, even
		// if the reader's personal override is what actually runs for them.
		const tier = isProject ? "PROJECT" : (entry?.effectiveScope ?? "NONE");
		const inForce = entry?.prompts.find((p) => p.isEffective);
		// Said plainly rather than left as a contradiction between the badge and
		// what the reader gets.
		const shadowed = isProject && entry?.effectiveScope === "USER";
		// Candidates a project can be pointed at: anything already available for
		// this action that is not already this project's own binding.
		const candidates = (entry?.prompts ?? []).filter(
			(p) => !(p.scope === "ORG" && p.projectId === projectId),
		);
		const busy = pending === action.id;

		return (
			<li
				key={action.id}
				className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
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
						{isProject && own
							? ` · ${own.promptName}`
							: inForce
								? ` · ${inForce.promptName}`
								: " · built-in text"}
						{shadowed && " · your personal default runs instead"}
					</p>
				</div>

				<div className="flex shrink-0 items-center gap-2">
					<Badge
						variant="outline"
						className={
							isProject
								? "border-primary/40 text-primary-ink"
								: undefined
						}
					>
						{TIER_LABEL[tier]}
					</Badge>

					{canEdit && isProject && (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							aria-label={`Clear the project override for ${action.label}`}
							onClick={() => {
								setPending(action.id);
								clearForProject.mutate(action);
							}}
						>
							Clear
						</Button>
					)}

					{canEdit && !isProject && candidates.length > 0 && (
						<Select
							disabled={busy}
							onValueChange={(promptVersionId) => {
								setPending(action.id);
								setForProject.mutate({
									action,
									promptVersionId,
								});
							}}
						>
							<SelectTrigger
								className="w-[190px]"
								aria-label={`Set the prompt this project uses for ${action.label}`}
							>
								<SelectValue placeholder="Use a different prompt" />
							</SelectTrigger>
							<SelectContent>
								{candidates.map((p) => (
									<SelectItem
										key={p.promptVersionId}
										value={p.promptVersionId}
									>
										{p.promptName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
			</li>
		);
	};

	return (
		<Card className="space-y-4 p-6">
			<div>
				<h3 className="font-medium text-base">
					Prompt defaults for this project
				</h3>
				<p className="mt-1 text-muted-foreground text-sm">
					{isLoading
						? "Checking every action…"
						: `${overridden.length} of ${ALL_ACTIONS.length} actions use a prompt chosen for this project. The rest follow the organization, then Fabric.`}
				</p>
				{!canEdit && (
					<p className="mt-1 text-muted-foreground text-xs">
						Organization admins and owners can change these.
					</p>
				)}
			</div>

			<section>
				<button
					type="button"
					onClick={() => setOverriddenOpen((v) => !v)}
					aria-expanded={overriddenOpen}
					className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/40"
				>
					<span className="font-medium text-sm">
						Chosen for this project
					</span>
					<span className="flex items-center gap-2">
						<Badge variant="outline">{overridden.length}</Badge>
						<span className="text-muted-foreground text-xs">
							{overriddenOpen ? "Hide" : "Show"}
						</span>
					</span>
				</button>
				{overriddenOpen &&
					(overridden.length > 0 ? (
						<ul className="divide-y rounded-lg border">
							{overridden.map(row)}
						</ul>
					) : (
						<p className="px-1 py-2 text-muted-foreground text-sm">
							Nothing yet. This project follows the organization's
							prompts.
						</p>
					))}
			</section>

			<section>
				<button
					type="button"
					onClick={() => setInheritedOpen(!inheritedOpen)}
					aria-expanded={inheritedOpen}
					className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/40"
				>
					<span className="font-medium text-sm">Inherited</span>
					<span className="flex items-center gap-2">
						<Badge variant="outline">{inherited.length}</Badge>
						<span className="text-muted-foreground text-xs">
							{inheritedOpen ? "Hide" : "Show"}
						</span>
					</span>
				</button>
				{inheritedOpen && (
					<div className="space-y-2">
						<Input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Search actions…"
							aria-label="Search actions this project inherits"
						/>
						<ul className="divide-y rounded-lg border">
							{inherited
								.filter((a) =>
									a.label
										.toLowerCase()
										.includes(filter.trim().toLowerCase()),
								)
								.map(row)}
						</ul>
					</div>
				)}
			</section>
		</Card>
	);
}
