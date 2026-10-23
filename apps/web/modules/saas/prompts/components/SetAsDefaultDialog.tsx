"use client";

import type { StoryKind } from "@repo/database";
import {
	bindableDocumentTypes,
	findPromptAgentTarget,
	isGeneralOnlyAgent,
	isNonStageAgent,
	listPromptActions,
	PROMPT_AGENT_TARGETS,
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	promptActionId,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { describeGenerationRefusal } from "@saas/projects/components/proposal-artifact/generation-feedback";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useOfferedPromptActions } from "../hooks/use-offered-prompt-actions";
import { ActionMultiSelect } from "./ActionMultiSelect";

const AGENTS = PROMPT_AGENT_TARGETS;
const ALL_ACTIONS = listPromptActions();

/** Mirrors `PromptScope` — the tier a binding is written at. */
type BindingScope = "SYSTEM" | "ORG" | "USER";

/**
 * Agents the bind procedure refuses a personal default for (Fizzy #2801). The
 * client proposal prompt is the whole of what the client reads, so it is
 * chosen for the organization or not at all; offering "just for me" would
 * offer a write the server refuses.
 */
const PERSONAL_DEFAULT_REFUSED_AGENTS: ReadonlySet<string> = new Set([
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
]);

/** One row of `bind.listForPrompt` — an action this prompt already serves. */
type BoundAction = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
};

type SetAsDefaultDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	promptName: string;
	promptVersionId: string;
	/** The prompt this version belongs to. Used to pre-populate the action set
	 *  when proposing (FR22) with the actions this prompt already serves. */
	promptId?: string;
	/** Pre-select a document type when opened from a filtered tab */
	initialDocumentType?: string;
	/** When set, scopes the binding to this story kind and restricts the
	 *  document-type dropdown to drafting-stage values valid for the kind.
	 *  Omit for non-stage bindings (PRD, ARCHITECTURE, etc.) — those resolve
	 *  with storyKind = NULL at lookup time. */
	storyKind?: StoryKind;
	/** Called after successfully setting the default */
	onSuccess?: () => void;
};

export function SetAsDefaultDialog({
	open,
	onOpenChange,
	promptName,
	promptVersionId,
	promptId,
	initialDocumentType,
	storyKind,
	onSuccess,
}: SetAsDefaultDialogProps) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const { organizationId, isOrgContext, basePath } = useOrganizationContext();
	const tFeedback = useTranslations(
		"projects.proposalArtifact.generationFeedback",
	);
	const tSuperseded = useTranslations(
		"projects.proposalArtifact.supersededAction",
	);
	const tBinding = useTranslations("projects.proposalArtifact.promptBinding");
	// Fizzy #2946: with the Proposal artifact on, the legacy Proposal actions
	// are neither offered nor submitted from here.
	const offered = useOfferedPromptActions();
	const { user } = useSession();
	const { isOrganizationAdmin } = useActiveOrganization();
	// Platform admin (User.role), not an organization admin — two orthogonal
	// fields. The API enforces both rules; these only decide which verb the
	// dialog offers.
	const canSetSystemDefault = user?.role === "admin";

	const [selectedDocType, setSelectedDocType] = useState(
		initialDocumentType ?? "",
	);
	const [selectedAgent, setSelectedAgent] = useState<string>(AGENTS[0].key);
	const [selectedScope, setSelectedScope] = useState<BindingScope>("USER");
	// FR22: the extra actions this nomination or binding also covers.
	const [alsoApplyTo, setAlsoApplyTo] = useState<string[]>([]);
	// Set once per open, so a user who clears a pre-filled action does not have
	// it reappear when the query refetches underneath them.
	const prefilled = useRef(false);
	// Whether the pre-fill held an action the Proposal artifact supersedes,
	// which is dropped rather than submitted.
	const [prefillDroppedSuperseded, setPrefillDroppedSuperseded] =
		useState(false);

	// Sync document type when the parent filter tab changes
	useEffect(() => {
		setSelectedDocType(initialDocumentType ?? "");
	}, [initialDocumentType]);

	// Start every visit from the same place.
	//
	// Each row keys its own dialog by prompt id, so state does not leak BETWEEN
	// prompts — an earlier comment here claimed it did, which was wrong. What
	// does leak is a previous visit to the SAME prompt: pick an agent, cancel,
	// reopen, and the selects still show the earlier pick. Every field here
	// decides which action gets rebound and at which tier, so a value the user
	// did not choose in this visit is a binding they did not intend.
	useEffect(() => {
		if (open) {
			setSelectedScope("USER");
			setSelectedAgent(AGENTS[0].key);
			setSelectedDocType(initialDocumentType ?? "");
			setAlsoApplyTo([]);
			setPrefillDroppedSuperseded(false);
			prefilled.current = false;
		}
	}, [open, initialDocumentType]);

	// FR22: pre-populate with the actions this prompt already serves. Someone
	// proposing a prompt that already runs three actions is almost always
	// proposing it for those three, and re-ticking them by hand is where the
	// fourth gets forgotten. Only while the dialog is open, and only for a
	// prompt we were given an id for.
	const {
		data: boundActions,
		error: boundActionsError,
		isFetching: boundActionsFetching,
		isPending: boundActionsPending,
		refetch: refetchBoundActions,
	} = useQuery({
		queryKey: ["prompt-bound-actions", promptId, organizationId],
		queryFn: async () =>
			await orpcClient.prompts.bindings.listForPrompt({
				promptId: promptId as string,
				organizationId: organizationId ?? null,
			}),
		enabled: open && Boolean(promptId),
	});

	// Opened from a stage panel (Feature/Bug drafting defaults), the surrounding
	// page is about one stage, and an agent with no stages cannot bind to it —
	// picking one would quietly abandon that context and write an unrelated
	// GENERAL binding. Offer only the agents the context can actually use.
	const agentOptions = storyKind
		? AGENTS.filter((agent) => !isNonStageAgent(agent))
		: AGENTS;

	const selectedAgentTarget = findPromptAgentTarget(selectedAgent);
	// An agent with no drafting stages never resolves a storyKind, so a
	// kind-scoped binding on it would never be read.
	const nonStageAgent = selectedAgentTarget
		? isNonStageAgent(selectedAgentTarget)
		: false;
	// A GENERAL-only agent resolves exactly one binding, so its document type is
	// not the user's to choose. This is a narrower set than the above — see
	// isGeneralOnlyAgent.
	const generalOnlyAgent = selectedAgentTarget
		? isGeneralOnlyAgent(selectedAgentTarget)
		: false;

	// A document type carried in from a filter tab is set before the list
	// below is narrowed, so with the Proposal artifact on it can name an action
	// the gate supersedes. Such a choice reads as no choice: the dialog asks
	// for one, and it is never submitted.
	const primarySuperseded =
		selectedDocType !== "" &&
		offered.isSuperseded(
			selectedAgent,
			generalOnlyAgent ? "GENERAL" : selectedDocType,
		);
	const chosenDocType = primarySuperseded ? "" : selectedDocType;

	const primaryActionId = chosenDocType
		? promptActionId(
				selectedAgent,
				generalOnlyAgent ? "GENERAL" : chosenDocType,
				nonStageAgent ? null : (storyKind ?? null),
			)
		: undefined;

	useEffect(() => {
		if (prefilled.current || !boundActions || !primaryActionId) {
			return;
		}
		const bound: BoundAction[] = boundActions.actions ?? [];
		const ids = bound
			.filter((a) => !offered.isSuperseded(a.targetKey, a.documentType))
			.map((a) =>
				promptActionId(
					a.targetKey,
					a.documentType,
					a.storyKind ?? null,
				),
			)
			.filter((id: string) => id !== primaryActionId);
		if (ids.length > 0) {
			setAlsoApplyTo((current) => [
				...new Set<string>([...current, ...ids]),
			]);
		}
		setPrefillDroppedSuperseded(
			bound.some((a) =>
				offered.isSuperseded(a.targetKey, a.documentType),
			),
		);
		prefilled.current = true;
	}, [boundActions, primaryActionId, offered]);

	const handleAlsoApplyToChange = (next: string[]) => {
		setAlsoApplyTo(next);
	};

	const documentTypeOptions = selectedAgentTarget
		? offered.documentTypesFor(
				selectedAgentTarget,
				nonStageAgent ? null : (storyKind ?? null),
			)
		: [];
	// Said in one line rather than leaving Proposal silently missing.
	const showSupersededNote =
		primarySuperseded ||
		prefillDroppedSuperseded ||
		(selectedAgentTarget !== undefined &&
			bindableDocumentTypes(
				selectedAgentTarget,
				nonStageAgent ? null : (storyKind ?? null),
			).length !== documentTypeOptions.length);

	const handleAgentChange = (agent: string) => {
		setSelectedAgent(agent);
		// Snap the doc type synchronously when switching into a GENERAL-only
		// agent so a fast Submit can't race a useEffect and persist (PRD, NULL).
		const target = findPromptAgentTarget(agent);
		if (target && isGeneralOnlyAgent(target)) {
			setSelectedDocType("GENERAL");
		}
	};

	// Fizzy #2801: no personal default for the client proposal prompt, whether
	// it is the action chosen above or one ticked under "Also apply to" — the
	// batch binds every action at one tier, so one refused action refuses the
	// write. Derived rather than written into the scope state: a fast submit
	// cannot race it, and leaving that action gives the user back the tier
	// they chose.
	const personalScopeRefused =
		PERSONAL_DEFAULT_REFUSED_AGENTS.has(selectedAgent) ||
		alsoApplyTo.some((id) => {
			const action = ALL_ACTIONS.find((a) => a.id === id);
			return action
				? PERSONAL_DEFAULT_REFUSED_AGENTS.has(action.targetKey)
				: false;
		});
	// Fizzy #2946: a Proposal's diagrams come from Fabric's own step after
	// generation, not from this prompt, so binding it says so.
	const coversClientMain =
		selectedAgent === PROPOSAL_CLIENT_MAIN_AGENT_KEY ||
		alsoApplyTo.some(
			(id) =>
				ALL_ACTIONS.find((a) => a.id === id)?.targetKey ===
				PROPOSAL_CLIENT_MAIN_AGENT_KEY,
		);
	const scope: BindingScope =
		personalScopeRefused && selectedScope === "USER"
			? isOrgContext
				? "ORG"
				: "SYSTEM"
			: selectedScope;

	// A shared tier you may not write yourself is one you may PROPOSE (FR15).
	// Rather than hide the option — which leaves a member no route at all and
	// no hint that one exists — the same dialog changes its verb.
	const mustPropose =
		(scope === "ORG" && !isOrganizationAdmin) ||
		(scope === "SYSTEM" && !canSetSystemDefault);

	const bindMutation = useMutation({
		mutationFn: async () => {
			if (!chosenDocType) {
				throw new Error("Please select a document type");
			}
			// Defense in depth: override the payload regardless of in-flight
			// state. The dropdown is already constrained, but a stale value or
			// an out-of-band setter shouldn't be able to write a binding shape
			// the classifier runtime can never resolve.
			const documentType = generalOnlyAgent ? "GENERAL" : chosenDocType;

			const primary = {
				targetKey: selectedAgent,
				documentType,
				storyKind: nonStageAgent ? null : (storyKind ?? null),
			};
			// FR22: the actions ticked alongside the one above. Only offered
			// ones: an id the gate supersedes is never submitted.
			const extras = alsoApplyTo
				.map((id) => offered.actions.find((a) => a.id === id))
				.filter((a): a is NonNullable<typeof a> => Boolean(a))
				.map((a) => ({
					targetKey: a.targetKey,
					documentType: a.documentType,
					storyKind: a.storyKind,
				}));

			if (mustPropose) {
				// Never USER here: mustPropose is false for a personal default,
				// which is nobody else's to approve.
				return await orpcClient.prompts.nominations.create({
					promptVersionId,
					targetScope: scope === "ORG" ? "ORG" : "SYSTEM",
					organizationId:
						scope === "ORG" ? (organizationId ?? null) : null,
					targets: [primary, ...extras],
				});
			}

			const organizationIdForScope =
				scope === "ORG" ? (organizationId ?? null) : null;

			// One call for one action so the common case keeps the simpler
			// endpoint; the batch is a transaction, so several actions either
			// all bind or none do.
			if (extras.length === 0) {
				return await orpcClient.prompts.bindings.set({
					targetType: "AGENT",
					...primary,
					storyKind: nonStageAgent ? undefined : storyKind,
					scope,
					organizationId: organizationIdForScope,
					promptVersionId,
					isDefault: true,
				});
			}

			return await orpcClient.prompts.bindings.setMany({
				targets: [primary, ...extras].map((t) => ({
					targetType: "AGENT" as const,
					...t,
				})),
				scope,
				organizationId: organizationIdForScope,
				promptVersionId,
				isDefault: true,
			});
		},
		onSuccess: () => {
			toast.success(
				mustPropose
					? `"${promptName}" proposed as the default — an admin will review it`
					: `"${promptName}" set as default`,
			);
			onOpenChange(false);
			queryClient.invalidateQueries({
				queryKey: ["prompt-bound-actions", promptId],
			});
			onSuccess?.();
		},
		onError: (error) => {
			const title = mustPropose
				? "Failed to propose as default"
				: "Failed to set as default";
			// A default refused at an action the Proposal artifact supersedes
			// is said in the reader's locale, with the way to the action that
			// does write Proposals.
			const refusal = describeGenerationRefusal(error, {
				t: tFeedback,
				basePath,
			});
			if (refusal) {
				toast.error(title, {
					description: refusal.message,
					action: {
						label: refusal.catalog.label,
						onClick: () => router.push(refusal.catalog.href),
					},
				});
				return;
			}
			toast.error(title, {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* Pinned header/footer, scrolling body — see PromptBindingManager:
			    the action list can exceed a short window and the submit button
			    must never sit below the fold. */}
			<DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-md">
				<DialogHeader className="shrink-0">
					<DialogTitle>
						{mustPropose ? "Propose as Default" : "Set as Default"}
					</DialogTitle>
					<DialogDescription>
						{mustPropose
							? `Propose "${promptName}" as the default prompt for a document type.`
							: `Set "${promptName}" as the default prompt for a document type.`}
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 pr-1">
					<div className="space-y-2">
						<Label htmlFor="set-default-document-type">
							Document Type
						</Label>
						<Select
							value={chosenDocType}
							onValueChange={setSelectedDocType}
						>
							<SelectTrigger id="set-default-document-type">
								<SelectValue placeholder="Select document type" />
							</SelectTrigger>
							<SelectContent>
								{documentTypeOptions.map((dt) => (
									<SelectItem key={dt} value={dt}>
										{promptDocumentTypeLabel(dt)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{showSupersededNote && (
							<p
								data-testid="set-default-superseded-note"
								className="text-xs text-muted-foreground"
							>
								{tSuperseded("dialogNote")}
							</p>
						)}
					</div>

					<div className="space-y-2">
						<Label htmlFor="set-default-agent">Agent</Label>
						<Select
							value={selectedAgent}
							onValueChange={handleAgentChange}
						>
							<SelectTrigger id="set-default-agent">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{agentOptions.map((a) => (
									<SelectItem key={a.key} value={a.key}>
										{a.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{coversClientMain && (
							<p
								data-testid="set-default-diagrams-note"
								className="text-xs text-muted-foreground"
							>
								{tBinding("diagramsNote")}
							</p>
						)}
					</div>

					<div className="space-y-2">
						<Label htmlFor="set-default-scope">Scope</Label>
						<Select
							value={scope}
							onValueChange={(val) =>
								setSelectedScope(val as BindingScope)
							}
						>
							<SelectTrigger id="set-default-scope">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{!personalScopeRefused && (
									<SelectItem value="USER">
										My prompts (just for me)
									</SelectItem>
								)}
								{isOrgContext && (
									<SelectItem value="ORG">
										Organization (for all members)
									</SelectItem>
								)}
								{/* Offered to everyone: someone who cannot set
								    it can still propose it, and hiding the tier
								    hides that route as well. */}
								<SelectItem value="SYSTEM">
									System (every organization)
								</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							{scope === "USER"
								? "This will only affect your documents"
								: mustPropose
									? scope === "ORG"
										? "An organization admin reviews this before it applies to anyone else."
										: "A platform admin reviews this before it applies to any organization."
									: scope === "ORG"
										? "This will affect all organization members"
										: "This becomes the default for every organization that has not set its own"}
						</p>
						{personalScopeRefused && (
							<p
								data-testid="set-default-personal-refused"
								className="text-xs text-muted-foreground"
							>
								The client proposal prompt is chosen for the
								whole organization, so it cannot be a personal
								default.
							</p>
						)}
					</div>

					{/* FR22 / FR19: the other actions this applies to. */}
					{primaryActionId && (
						<div className="space-y-2">
							{(boundActionsPending || boundActionsFetching) && (
								<output className="text-muted-foreground text-xs">
									Loading actions this prompt already serves…
								</output>
							)}
							{boundActionsError && (
								// FR22's pre-fill silently comes up empty on this
								// failure — say so, and offer a retry, without
								// blocking the rest of the form on it.
								<div
									role="alert"
									className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-highlight/40 bg-highlight/5 px-3 py-2 text-highlight-ink text-xs"
								>
									<span>
										Could not refresh the actions this
										prompt already serves. Your current
										selection is kept, but it may be
										incomplete.
									</span>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="text-xs"
										onClick={() => refetchBoundActions()}
									>
										Try again
									</Button>
								</div>
							)}
							<ActionMultiSelect
								id="set-default-also"
								label="Also apply to"
								alwaysIncluded={primaryActionId}
								value={alsoApplyTo}
								onChange={handleAlsoApplyToChange}
								hint={
									alsoApplyTo.length > 0
										? `${
												mustPropose
													? "Proposed"
													: "Applies"
											} for ${alsoApplyTo.length + 1} actions. They share one body, so editing it later changes all of them.`
										: "Optional. The action selected above is always included."
								}
							/>
						</div>
					)}
				</div>

				<DialogFooter className="shrink-0 border-t pt-4">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						onClick={() => bindMutation.mutate()}
						disabled={
							bindMutation.isPending ||
							boundActionsPending ||
							boundActionsFetching ||
							!chosenDocType
						}
					>
						{bindMutation.isPending && (
							<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
						)}
						{mustPropose ? "Propose as Default" : "Set as Default"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
