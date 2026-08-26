"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ChevronsUpDownIcon,
	Loader2Icon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	DECISION_DOMAINS,
	DECISION_STATUSES,
	type DecisionDomain,
	type DecisionDuration,
	type DecisionStatus,
	DOMAIN_CONFIG,
	DURATION_CONFIG,
	formatDecisionDate,
	STATUS_CONFIG,
	toDateInputValue,
} from "./constants";
import { DomainTag } from "./DecisionAtoms";
import { DecisionStatusBadge } from "./DecisionStatusSelect";
import { ParticipantPicker } from "./ParticipantPicker";

export type EditableDecision = {
	id: string;
	title: string;
	decision: string;
	contextProblem: string;
	rationale: string;
	decisionDrivers: string | null;
	alternativesConsidered: string | null;
	consequences: string | null;
	status: DecisionStatus;
	domain: string | null;
	decisionDate: string | Date;
	participantUserIds: string[];
	participantsText: string | null;
	supersededById: string | null;
	relatedDecisionIds: string[];
	supersedesIds: string[];
	decisionTypeId?: string | null;
	ownerUserId?: string | null;
	duration?: DecisionDuration | null;
	priorityFlagged?: boolean;
};

type SupersedeOption = { id: string; identifier: string; title: string };

type Props = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** When set, the dialog edits this decision; otherwise it creates a new one. */
	decision?: EditableDecision | null;
	supersedeOptions?: SupersedeOption[];
	onSaved?: (decisionId: string) => void;
};

const NONE_VALUE = "__none__";
/** Select sentinel that swaps the Type control into "add a new label" mode. */
const NEW_TYPE_VALUE = "__new__type";

export function DecisionFormDialog({
	projectId,
	open,
	onOpenChange,
	decision,
	supersedeOptions = [],
	onSaved,
}: Props) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const isEdit = Boolean(decision);

	const [title, setTitle] = useState("");
	const [decisionText, setDecisionText] = useState("");
	const [contextProblem, setContextProblem] = useState("");
	const [rationale, setRationale] = useState("");
	const [decisionDrivers, setDecisionDrivers] = useState("");
	const [alternatives, setAlternatives] = useState("");
	const [consequences, setConsequences] = useState("");
	const [status, setStatus] = useState<DecisionStatus>("PROPOSED");
	const [domain, setDomain] = useState<string>(NONE_VALUE);
	const [dateStr, setDateStr] = useState("");
	const [participantUserIds, setParticipantUserIds] = useState<string[]>([]);
	const [participantsText, setParticipantsText] = useState("");
	const [supersededById, setSupersededById] = useState<string | null>(null);
	const [relatedDecisionIds, setRelatedDecisionIds] = useState<string[]>([]);
	const [supersedesIds, setSupersedesIds] = useState<string[]>([]);
	const [typeId, setTypeId] = useState<string>(NONE_VALUE);
	const [addingNewType, setAddingNewType] = useState(false);
	const [newTypeName, setNewTypeName] = useState("");
	const [ownerUserId, setOwnerUserId] = useState<string>(NONE_VALUE);
	const [duration, setDuration] = useState<string>(NONE_VALUE);
	const [priorityFlagged, setPriorityFlagged] = useState(false);
	const [suggestionReason, setSuggestionReason] = useState("");
	const [previewMode, setPreviewMode] = useState(false);

	// The project's decision-type taxonomy + member roster for the owner picker.
	const { data: typesData } = useQuery(
		orpc.projects.architectureDecisions.types.list.queryOptions({
			input: { projectId, organizationId },
			enabled: open,
		}),
	);
	const types = typesData?.types ?? [];
	const { data: membersData } = useQuery(
		orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
			enabled: open,
		}),
	);
	const members = membersData?.members ?? [];

	// Re-seed the form whenever it opens (edit = existing values, create = blank).
	useEffect(() => {
		if (!open) {
			return;
		}
		setTitle(decision?.title ?? "");
		setDecisionText(decision?.decision ?? "");
		setContextProblem(decision?.contextProblem ?? "");
		setRationale(decision?.rationale ?? "");
		setDecisionDrivers(decision?.decisionDrivers ?? "");
		setAlternatives(decision?.alternativesConsidered ?? "");
		setConsequences(decision?.consequences ?? "");
		setStatus(decision?.status ?? "PROPOSED");
		setDomain(decision?.domain ?? NONE_VALUE);
		setDateStr(toDateInputValue(decision?.decisionDate ?? new Date()));
		setParticipantUserIds(decision?.participantUserIds ?? []);
		setParticipantsText(decision?.participantsText ?? "");
		setSupersededById(decision?.supersededById ?? null);
		setRelatedDecisionIds(decision?.relatedDecisionIds ?? []);
		setSupersedesIds(decision?.supersedesIds ?? []);
		setTypeId(decision?.decisionTypeId ?? NONE_VALUE);
		setAddingNewType(false);
		setNewTypeName("");
		setOwnerUserId(decision?.ownerUserId ?? NONE_VALUE);
		setDuration(decision?.duration ?? NONE_VALUE);
		setPriorityFlagged(decision?.priorityFlagged ?? false);
		setSuggestionReason("");
		setPreviewMode(false);
	}, [open, decision]);

	const onMutationError = (error: { message: string }) => {
		toast.error(`Failed to save decision: ${error.message}`);
	};

	const afterSave = (savedId: string) => {
		// Refresh the edited entry's detail + version history precisely.
		if (isEdit && decision) {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.architectureDecisions.get.queryKey({
					input: { projectId, id: decision.id, organizationId },
				}),
			});
			queryClient.invalidateQueries({
				queryKey:
					orpc.projects.architectureDecisions.versions.list.queryKey({
						input: {
							projectId,
							architectureDecisionId: decision.id,
							organizationId,
						},
					}),
			});
		}
		toast.success(isEdit ? "Decision updated" : "Decision created");
		onOpenChange(false);
		onSaved?.(savedId);
	};

	const createMutation = useMutation(
		orpc.projects.architectureDecisions.create.mutationOptions({
			onSuccess: (data) => afterSave(data.decision.id),
			onError: onMutationError,
		}),
	);
	const updateMutation = useMutation(
		orpc.projects.architectureDecisions.update.mutationOptions({
			onSuccess: (data) => afterSave(data.decision.id),
			onError: onMutationError,
		}),
	);

	const pending = createMutation.isPending || updateMutation.isPending;

	const suggestMutation = useMutation(
		orpc.projects.architectureDecisions.suggestMetadata.mutationOptions({
			onSuccess: ({ suggestion }) => {
				if (!suggestion) {
					toast.info(
						"No metadata suggestion right now — fill in the tags manually.",
					);
					return;
				}
				const existingType = types.find(
					(t) => t.name === suggestion.decisionType,
				);
				if (existingType) {
					setTypeId(existingType.id);
					setAddingNewType(false);
					setNewTypeName("");
				} else {
					setAddingNewType(true);
					setNewTypeName(suggestion.decisionType);
					setTypeId(NONE_VALUE);
				}
				setDuration(suggestion.duration);
				setPriorityFlagged(suggestion.priorityFlagged);
				setOwnerUserId(suggestion.ownerUserId ?? NONE_VALUE);
				setSuggestionReason(suggestion.reason);
			},
			onError: (e) =>
				toast.error(`Could not suggest metadata: ${e.message}`),
		}),
	);

	const handleSuggest = () => {
		if (!title.trim() || !decisionText.trim()) {
			toast.error("Add a title and the decision first");
			return;
		}
		suggestMutation.mutate({
			projectId,
			organizationId,
			title: title.trim(),
			decision: decisionText.trim(),
			contextProblem: contextProblem.trim() || null,
			participantsText: participantsText.trim() || null,
		});
	};

	const handleSubmit = () => {
		if (!title.trim()) {
			toast.error("A decision title is required");
			return;
		}
		if (!decisionText.trim()) {
			toast.error("The decision itself is required");
			return;
		}

		const shared = {
			title: title.trim(),
			decision: decisionText.trim(),
			contextProblem: contextProblem.trim(),
			rationale: rationale.trim(),
			decisionDrivers: decisionDrivers.trim() || null,
			alternativesConsidered: alternatives.trim() || null,
			consequences: consequences.trim() || null,
			status,
			domain: domain === NONE_VALUE ? null : (domain as DecisionDomain),
			decisionDate: dateStr || undefined,
			participantUserIds,
			participantsText: participantsText.trim() || null,
			relatedDecisionIds,
			supersedesIds,
			duration:
				duration === NONE_VALUE ? null : (duration as DecisionDuration),
			priorityFlagged,
			ownerUserId: ownerUserId === NONE_VALUE ? null : ownerUserId,
			...(addingNewType && newTypeName.trim()
				? {
						newDecisionTypeName: newTypeName.trim(),
						decisionTypeId: null,
					}
				: {
						decisionTypeId: typeId === NONE_VALUE ? null : typeId,
						newDecisionTypeName: null,
					}),
		};

		if (isEdit && decision) {
			updateMutation.mutate({
				projectId,
				id: decision.id,
				organizationId,
				...shared,
				supersededById: status === "SUPERSEDED" ? supersededById : null,
			});
		} else {
			createMutation.mutate({ projectId, organizationId, ...shared });
		}
	};

	const otherDecisions = supersedeOptions.filter(
		(o) => o.id !== decision?.id,
	);

	const tabClass = (active: boolean) =>
		cn(
			"-mb-px border-b-2 px-3 py-1.5 font-medium text-sm transition-colors",
			active
				? "border-primary text-foreground"
				: "border-transparent text-muted-foreground hover:text-foreground",
		);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{isEdit ? "Edit decision" : "New architecture decision"}
					</DialogTitle>
					<DialogDescription>
						Capture what was decided, why, and who was involved — a
						permanent, AI-aware record for your team.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center gap-1 border-b">
					<button
						type="button"
						onClick={() => setPreviewMode(false)}
						className={tabClass(!previewMode)}
					>
						Edit
					</button>
					<button
						type="button"
						onClick={() => setPreviewMode(true)}
						className={tabClass(previewMode)}
					>
						Preview
					</button>
				</div>

				{previewMode ? (
					<DecisionPreview
						title={title}
						decision={decisionText}
						contextProblem={contextProblem}
						decisionDrivers={decisionDrivers}
						rationale={rationale}
						alternatives={alternatives}
						consequences={consequences}
						status={status}
						domain={domain === NONE_VALUE ? null : domain}
						dateStr={dateStr}
						participantsText={participantsText}
					/>
				) : (
					<div className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="adl-title">
								Title{" "}
								<span className="text-destructive">*</span>
							</Label>
							<Input
								id="adl-title"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="e.g. Adopt Temporal for durable workflows"
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-decision">
								Decision{" "}
								<span className="text-destructive">*</span>
							</Label>
							<Textarea
								id="adl-decision"
								value={decisionText}
								onChange={(e) =>
									setDecisionText(e.target.value)
								}
								placeholder="What was decided?"
								rows={3}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-context">
								Context / problem
							</Label>
							<Textarea
								id="adl-context"
								value={contextProblem}
								onChange={(e) =>
									setContextProblem(e.target.value)
								}
								placeholder="What problem or forces led to this decision?"
								rows={3}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-drivers">
								Decision drivers
							</Label>
							<Textarea
								id="adl-drivers"
								value={decisionDrivers}
								onChange={(e) =>
									setDecisionDrivers(e.target.value)
								}
								placeholder="What forces or criteria drove this — constraints, requirements, priorities?"
								rows={2}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-rationale">Rationale</Label>
							<Textarea
								id="adl-rationale"
								value={rationale}
								onChange={(e) => setRationale(e.target.value)}
								placeholder="Why was this the right choice?"
								rows={3}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-alternatives">
								Alternatives considered
							</Label>
							<Textarea
								id="adl-alternatives"
								value={alternatives}
								onChange={(e) =>
									setAlternatives(e.target.value)
								}
								placeholder="What else was evaluated and rejected?"
								rows={2}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-consequences">
								Consequences
							</Label>
							<Textarea
								id="adl-consequences"
								value={consequences}
								onChange={(e) =>
									setConsequences(e.target.value)
								}
								placeholder="What are the trade-offs and follow-on effects of this decision?"
								rows={2}
							/>
						</div>

						<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
							<div className="space-y-1.5">
								<Label htmlFor="adl-status">Status</Label>
								<Select
									value={status}
									onValueChange={(v) =>
										setStatus(v as DecisionStatus)
									}
								>
									<SelectTrigger id="adl-status">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{DECISION_STATUSES.map((s) => (
											<SelectItem key={s} value={s}>
												{STATUS_CONFIG[s].label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="adl-domain">Domain</Label>
								<Select
									value={domain}
									onValueChange={setDomain}
								>
									<SelectTrigger id="adl-domain">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={NONE_VALUE}>
											No domain
										</SelectItem>
										{DECISION_DOMAINS.map((d) => (
											<SelectItem key={d} value={d}>
												{DOMAIN_CONFIG[d].label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="adl-date">Decision date</Label>
								<Input
									id="adl-date"
									type="date"
									value={dateStr}
									onChange={(e) => setDateStr(e.target.value)}
								/>
							</div>
						</div>

						<div className="space-y-2 rounded-lg border bg-muted/20 p-3">
							<div className="flex items-center justify-between gap-2">
								<p className="app-editorial-label">
									Classification
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={
										suggestMutation.isPending || pending
									}
									onClick={handleSuggest}
								>
									{suggestMutation.isPending ? (
										<Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
									) : (
										<SparklesIcon className="mr-1.5 size-3.5 text-primary" />
									)}
									Suggest metadata
								</Button>
							</div>
							{suggestionReason && (
								<p className="text-muted-foreground text-xs">
									{suggestionReason}
								</p>
							)}

							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<div className="space-y-1.5">
									<Label htmlFor="adl-type">Type</Label>
									{addingNewType ? (
										<div className="flex items-center gap-1.5">
											<Input
												id="adl-type-new"
												value={newTypeName}
												onChange={(e) =>
													setNewTypeName(
														e.target.value,
													)
												}
												placeholder="New type label"
												maxLength={60}
												// The select that had focus unmounts when
												// this swaps in — carry focus over.
												autoFocus
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label="Cancel new type"
												onClick={() => {
													setAddingNewType(false);
													setNewTypeName("");
													document
														.getElementById(
															"adl-type",
														)
														?.focus();
												}}
											>
												<XIcon className="size-4" />
											</Button>
										</div>
									) : (
										<Select
											value={typeId}
											onValueChange={(v) => {
												if (v === NEW_TYPE_VALUE) {
													setAddingNewType(true);
													setTypeId(NONE_VALUE);
													return;
												}
												setTypeId(v);
											}}
										>
											<SelectTrigger id="adl-type">
												<SelectValue placeholder="No type" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value={NONE_VALUE}>
													No type
												</SelectItem>
												{types.map((t) => (
													<SelectItem
														key={t.id}
														value={t.id}
													>
														{t.name}
													</SelectItem>
												))}
												<SelectItem
													value={NEW_TYPE_VALUE}
												>
													+ New type…
												</SelectItem>
											</SelectContent>
										</Select>
									)}
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="adl-owner">Owner</Label>
									<Select
										value={ownerUserId}
										onValueChange={setOwnerUserId}
									>
										<SelectTrigger id="adl-owner">
											<SelectValue placeholder="Unassigned" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={NONE_VALUE}>
												Unassigned
											</SelectItem>
											{members.map((m) => (
												<SelectItem
													key={m.userId}
													value={m.userId}
												>
													{m.user.name ||
														m.user.email}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="adl-duration">
										Duration
									</Label>
									<Select
										value={duration}
										onValueChange={setDuration}
									>
										<SelectTrigger id="adl-duration">
											<SelectValue placeholder="Unclassified" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={NONE_VALUE}>
												Unclassified
											</SelectItem>
											{(
												Object.keys(
													DURATION_CONFIG,
												) as DecisionDuration[]
											).map((d) => (
												<SelectItem key={d} value={d}>
													{DURATION_CONFIG[d].label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								<div className="flex items-end space-y-1.5">
									<label
										htmlFor="adl-priority"
										className="flex cursor-pointer items-center gap-2 py-2 font-normal text-sm"
									>
										<Checkbox
											id="adl-priority"
											checked={priorityFlagged}
											onCheckedChange={(v) =>
												setPriorityFlagged(v === true)
											}
										/>
										Priority
										<span className="text-muted-foreground text-xs">
											— informs roadmap prioritization
										</span>
									</label>
								</div>
							</div>
						</div>

						{status === "SUPERSEDED" &&
							otherDecisions.length > 0 && (
								<div className="space-y-1.5">
									<Label htmlFor="adl-superseded">
										Superseded by
									</Label>
									<Select
										value={supersededById ?? NONE_VALUE}
										onValueChange={(v) =>
											setSupersededById(
												v === NONE_VALUE ? null : v,
											)
										}
									>
										<SelectTrigger id="adl-superseded">
											<SelectValue placeholder="Select a decision" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={NONE_VALUE}>
												None
											</SelectItem>
											{otherDecisions.map((o) => (
												<SelectItem
													key={o.id}
													value={o.id}
												>
													{o.identifier} · {o.title}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}

						{otherDecisions.length > 0 && (
							<div className="space-y-1.5">
								<Label>Supersedes</Label>
								<RelatedDecisionsPicker
									placeholder="Decisions this one replaces…"
									options={otherDecisions}
									value={supersedesIds}
									onChange={setSupersedesIds}
								/>
								<p className="text-muted-foreground text-xs">
									Marks those decisions as Superseded and
									links them to this one.
								</p>
							</div>
						)}

						{otherDecisions.length > 0 && (
							<div className="space-y-1.5">
								<Label>Related decisions</Label>
								<RelatedDecisionsPicker
									options={otherDecisions}
									value={relatedDecisionIds}
									onChange={setRelatedDecisionIds}
								/>
							</div>
						)}

						<div className="space-y-1.5">
							<Label>Participants (project members)</Label>
							<ParticipantPicker
								projectId={projectId}
								value={participantUserIds}
								onChange={setParticipantUserIds}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="adl-external">
								Other participants
							</Label>
							<Input
								id="adl-external"
								value={participantsText}
								onChange={(e) =>
									setParticipantsText(e.target.value)
								}
								placeholder="External architects, consultants… (comma-separated)"
							/>
						</div>
					</div>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={pending}>
						{pending && (
							<Loader2Icon className="mr-2 size-4 animate-spin" />
						)}
						{isEdit ? "Save changes" : "Create decision"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PreviewSection({
	label,
	value,
}: {
	label: string;
	value?: string | null;
}) {
	if (!value?.trim()) {
		return null;
	}
	return (
		<div>
			<p className="app-editorial-label">{label}</p>
			<p className="mt-1 whitespace-pre-wrap text-foreground/90 text-sm">
				{value}
			</p>
		</div>
	);
}

function DecisionPreview({
	title,
	decision,
	contextProblem,
	decisionDrivers,
	rationale,
	alternatives,
	consequences,
	status,
	domain,
	dateStr,
	participantsText,
}: {
	title: string;
	decision: string;
	contextProblem: string;
	decisionDrivers: string;
	rationale: string;
	alternatives: string;
	consequences: string;
	status: DecisionStatus;
	domain: string | null;
	dateStr: string;
	participantsText: string;
}) {
	return (
		<div className="space-y-5 rounded-lg border bg-muted/20 p-5">
			<div className="flex flex-wrap items-center gap-2">
				<DecisionStatusBadge status={status} />
				<DomainTag domain={domain} />
				{dateStr && (
					<span className="text-muted-foreground text-xs">
						{formatDecisionDate(dateStr)}
					</span>
				)}
			</div>
			<h3 className="font-serif text-xl font-normal leading-tight">
				{title.trim() || "Untitled decision"}
			</h3>
			<div className="space-y-4">
				<PreviewSection
					label="Context / problem"
					value={contextProblem}
				/>
				<PreviewSection
					label="Decision drivers"
					value={decisionDrivers}
				/>
				<PreviewSection label="Decision" value={decision} />
				<PreviewSection label="Rationale" value={rationale} />
				<PreviewSection
					label="Alternatives considered"
					value={alternatives}
				/>
				<PreviewSection label="Consequences" value={consequences} />
				<PreviewSection
					label="Other participants"
					value={participantsText}
				/>
			</div>
		</div>
	);
}

function RelatedDecisionsPicker({
	options,
	value,
	onChange,
	placeholder = "Link related decisions…",
}: {
	options: SupersedeOption[];
	value: string[];
	onChange: (ids: string[]) => void;
	placeholder?: string;
}) {
	const [open, setOpen] = useState(false);
	const toggle = (id: string) =>
		onChange(
			value.includes(id) ? value.filter((x) => x !== id) : [...value, id],
		);
	const selected = options.filter((o) => value.includes(o.id));

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className="h-auto min-h-9 w-full justify-between gap-2 py-2 font-normal"
				>
					<span className="flex flex-wrap gap-1">
						{selected.length === 0 ? (
							<span className="text-muted-foreground">
								{placeholder}
							</span>
						) : (
							selected.map((o) => (
								<span
									key={o.id}
									className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
								>
									{o.identifier}
								</span>
							))
						)}
					</span>
					<ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[var(--radix-popover-trigger-width)] p-1"
			>
				<ul className="max-h-56 overflow-y-auto">
					{options.map((o) => {
						const checked = value.includes(o.id);
						return (
							<li key={o.id}>
								<button
									type="button"
									onClick={() => toggle(o.id)}
									className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
								>
									<span
										className={cn(
											"flex size-4 shrink-0 items-center justify-center rounded border",
											checked
												? "border-primary bg-primary text-primary-foreground"
												: "border-input",
										)}
									>
										{checked && (
											<CheckIcon className="size-3" />
										)}
									</span>
									<span className="shrink-0 font-mono text-xs">
										{o.identifier}
									</span>
									<span className="truncate">{o.title}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
