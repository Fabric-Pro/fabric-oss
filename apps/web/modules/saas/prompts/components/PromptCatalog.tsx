"use client";

import {
	listPromptActions,
	PROMPT_FEATURE_TYPE_OPTIONS,
	type PromptAction,
	type PromptFeatureTypeKey,
	promptActionId,
} from "@repo/utils/prompt-action-catalog";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionPromptList } from "./ActionPromptList";
import { PromptDefaultBadge } from "./PromptDefaultBadge";

/**
 * Browse prompts by the action they are for, rather than by their name.
 *
 * The old flow asked you to know which prompt drove which agent before you
 * could find it. This inverts that: pick the thing you are trying to do, and
 * see every prompt that could serve it and which one currently does.
 *
 * The action grid is static and comes from the shared catalog — it is derived
 * from what can actually be BOUND, so an action here is never a dead end. What
 * the server supplies is only which prompts are attached and which tier is in
 * force, since that is the part that varies per tenant.
 */

type CatalogEntry = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
	effectiveScope: "SYSTEM" | "ORG" | "USER" | null;
	prompts: Array<{
		promptId: string;
		promptName: string;
		// Needed to switch to a variant: a binding points at a VERSION, and the
		// catalog payload has carried it all along.
		promptVersionId: string;
		scope: "SYSTEM" | "ORG" | "USER";
		/** Set when this ORG binding is narrowed to one project (PROJECT tier). */
		projectId: string | null;
		isDefault: boolean;
		isEffective: boolean;
	}>;
};

const ALL_ACTIONS = listPromptActions();

export function PromptCatalog() {
	const { organizationId, basePath } = useOrganizationContext();
	const searchParams = useSearchParams();
	// FR14: arriving from a prompt selector. `prompt` highlights every action
	// that prompt serves — a prompt bound to several actions has no single
	// "entry" to land on, so landing on all of them is the honest answer.
	// `action` is the narrower link used by the "Also used for" references.
	const focusPromptId = searchParams.get("prompt");
	const focusActionId = searchParams.get("action");
	const [search, setSearch] = useState("");
	const [openFeatureType, setOpenFeatureType] =
		useState<PromptFeatureTypeKey | null>(null);

	const { data, isLoading, refetch } = useQuery({
		queryKey: ["prompt-catalog", organizationId],
		queryFn: async () =>
			await orpcClient.prompts.catalog.list({
				organizationId: organizationId ?? null,
			}),
	});

	const bindingsByAction = useMemo(() => {
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

	// FR20: which OTHER actions each prompt serves. Built from the same catalog
	// payload rather than a second request, because the answer is already in it.
	const actionsByPrompt = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const [actionId, entry] of bindingsByAction) {
			for (const p of entry.prompts) {
				const list = map.get(p.promptId) ?? [];
				list.push(actionId);
				map.set(p.promptId, list);
			}
		}
		return map;
	}, [bindingsByAction]);

	/** Action ids to draw attention to, from a deep link. */
	const focusedActionIds = useMemo(() => {
		if (focusActionId) {
			return new Set([focusActionId]);
		}
		if (focusPromptId) {
			return new Set(actionsByPrompt.get(focusPromptId) ?? []);
		}
		return new Set<string>();
	}, [focusActionId, focusPromptId, actionsByPrompt]);

	// FR13: searching by the action's name must work without first knowing
	// which feature type it sits under, so the filter runs across the whole
	// grid and the tier groups collapse to whatever matched.
	const query = search.trim().toLowerCase();
	const matching = useMemo(
		() =>
			query
				? ALL_ACTIONS.filter(
						(a) =>
							a.label.toLowerCase().includes(query) ||
							a.agentLabel.toLowerCase().includes(query) ||
							a.targetKey.toLowerCase().includes(query),
					)
				: ALL_ACTIONS,
		[query],
	);

	const byFeatureType = useMemo(() => {
		const map = new Map<PromptFeatureTypeKey, PromptAction[]>();
		for (const action of matching) {
			const list = map.get(action.featureType) ?? [];
			list.push(action);
			map.set(action.featureType, list);
		}
		return map;
	}, [matching]);

	return (
		<div className="space-y-6">
			<div className="relative">
				<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
				<Input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search actions — for example “test case” or “PRD”"
					className="pl-9"
					aria-label="Search prompt actions"
				/>
			</div>

			{query && matching.length === 0 && (
				<p className="text-muted-foreground text-sm">
					No action matches “{search}”.
				</p>
			)}

			{PROMPT_FEATURE_TYPE_OPTIONS.map((featureType) => {
				const actions = byFeatureType.get(featureType.key) ?? [];
				if (actions.length === 0) {
					return null;
				}

				// A search narrows the grid enough that collapsing would only
				// hide the answer the user just asked for. A deep link is the
				// same situation: arriving at a collapsed page shows nothing of
				// what the link promised.
				const holdsFocus = actions.some((a) =>
					focusedActionIds.has(a.id),
				);
				const expanded =
					Boolean(query) ||
					holdsFocus ||
					openFeatureType === featureType.key;

				return (
					<section key={featureType.key} className="space-y-3">
						<button
							type="button"
							onClick={() =>
								setOpenFeatureType(
									expanded && !query ? null : featureType.key,
								)
							}
							aria-expanded={expanded}
							className="flex w-full items-center gap-2 text-left"
						>
							<ChevronRightIcon
								className={`size-4 shrink-0 text-muted-foreground transition-transform ${
									expanded ? "rotate-90" : ""
								}`}
							/>
							<span className="editorial-label">
								{featureType.label}
							</span>
							<Badge variant="outline" className="ml-1">
								{actions.length}
							</Badge>
						</button>

						{expanded && (
							<>
								<p className="pl-6 text-muted-foreground text-sm">
									{featureType.description}
								</p>
								<ul className="space-y-2 pl-6">
									{actions.map((action) => (
										<li key={action.id}>
											<ActionRow
												action={action}
												entry={bindingsByAction.get(
													action.id,
												)}
												basePath={basePath}
												isLoading={isLoading}
												isFocused={focusedActionIds.has(
													action.id,
												)}
												actionsByPrompt={
													actionsByPrompt
												}
												onChanged={() => {
													void refetch();
												}}
											/>
										</li>
									))}
								</ul>
							</>
						)}
					</section>
				);
			})}
		</div>
	);
}

function ActionRow({
	action,
	entry,
	basePath,
	isLoading,
	isFocused,
	actionsByPrompt,
	onChanged,
}: {
	action: PromptAction;
	entry?: CatalogEntry;
	basePath: string;
	isLoading: boolean;
	isFocused: boolean;
	actionsByPrompt: Map<string, string[]>;
	onChanged: () => void;
}) {
	const effective = entry?.prompts.find((p) => p.isEffective);
	const others = (entry?.prompts.length ?? 0) - (effective ? 1 : 0);
	const ref = useRef<HTMLDivElement>(null);
	// FR9/FR10: Tier 3. Collapsed by default so a catalog of sixty actions
	// stays scannable, and opened automatically when a deep link points here —
	// the FR8 notification lands on this row expressly so the reader can switch.
	const [expanded, setExpanded] = useState(false);

	// A deep link that lands above or below the fold has not really arrived.
	useEffect(() => {
		if (isFocused && ref.current) {
			ref.current.scrollIntoView({ block: "center" });
			setExpanded(true);
		}
	}, [isFocused]);

	// FR20: the same prompt bound to several actions. Editing it there changes
	// it here, so the cross-reference belongs next to the prompt, not hidden.
	const alsoUsedFor = effective
		? (actionsByPrompt.get(effective.promptId) ?? []).filter(
				(id) => id !== action.id,
			)
		: [];

	return (
		// The ref lives on a wrapper because Card does not forward one.
		<div ref={ref} data-action-id={action.id}>
			<Card
				className={`flex flex-wrap items-center justify-between gap-3 p-3 ${
					isFocused ? "ring-2 ring-primary" : ""
				}`}
			>
				<div className="min-w-0">
					<p className="truncate font-medium text-sm">
						{action.label}
					</p>
					{isLoading ? (
						<p className="text-muted-foreground text-xs">
							Loading…
						</p>
					) : effective ? (
						<p className="truncate text-muted-foreground text-xs">
							<Link
								href={`${basePath}/prompts/${effective.promptId}`}
								className="hover:underline"
							>
								{effective.promptName}
							</Link>
							{others > 0 && (
								<button
									type="button"
									onClick={() => setExpanded((v) => !v)}
									aria-expanded={expanded}
									className="ml-1 underline underline-offset-2 hover:text-foreground"
								>
									{" · "}
									{others} other{others === 1 ? "" : "s"}{" "}
									available
								</button>
							)}
						</p>
					) : null}

					{alsoUsedFor.length > 0 && (
						<p className="mt-1 text-muted-foreground text-xs">
							Also used for:{" "}
							{alsoUsedFor.map((id, i) => (
								<span key={id}>
									{i > 0 && ", "}
									<Link
										href={`${basePath}/prompts/catalog?action=${encodeURIComponent(id)}`}
										className="underline underline-offset-2 hover:text-foreground"
									>
										{ALL_ACTIONS.find((a) => a.id === id)
											?.label ?? id}
									</Link>
								</span>
							))}
						</p>
					)}

					{!isLoading && !effective && (
						// Not an error state: plenty of actions ship with no bound
						// prompt and fall back to the agent's in-code text.
						<p className="text-muted-foreground text-xs">
							No prompt bound — uses the built-in default
						</p>
					)}
				</div>

				{!isLoading && (
					<PromptDefaultBadge
						isDefault={Boolean(effective)}
						isBound={Boolean(entry?.prompts.length)}
						defaultScope={entry?.effectiveScope ?? null}
					/>
				)}

				{/* FR9/FR10: every prompt bound to this action, and a way to
				    switch to one of them. */}
				{expanded && !isLoading && (
					<div className="w-full">
						<ActionPromptList
							targetKey={action.targetKey}
							documentType={action.documentType}
							storyKind={action.storyKind}
							prompts={entry?.prompts ?? []}
							basePath={basePath}
							onChanged={onChanged}
						/>
					</div>
				)}
			</Card>
		</div>
	);
}
