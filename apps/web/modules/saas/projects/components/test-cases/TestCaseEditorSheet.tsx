"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ActivitySection } from "./ActivitySection";
import { AutomationLinkFields } from "./AutomationLinkFields";
import { isLinkableAutomationUrl, statusAfterRefEdit } from "./automation-link";
import {
	AUTOMATION_I18N_KEY,
	AUTOMATION_STATUSES,
	type AutomationStatus,
	PRIORITY_I18N_KEY,
	RESULT_I18N_KEY,
	STATE_I18N_KEY,
	type TestCasePriority,
	type TestCaseState,
} from "./constants";
import { EditablePriorityChip } from "./EditablePriorityChip";
import { EditableStateChip } from "./EditableStateChip";
import { PlanMembershipControl } from "./PlanMembershipControl";
import { PlaywrightScriptEditor } from "./PlaywrightScriptEditor";
import { PmSyncControls } from "./PmSyncControls";
import { RunsSection } from "./RunsSection";
import { type StepDraft, StepEditor } from "./StepEditor";
import { TestCaseResultPill } from "./TestCaseResultPill";
import { TestCaseStatusChip } from "./TestCaseStatusChip";
import {
	WorkItemLinkControl,
	type WorkItemLinkDraft,
} from "./WorkItemLinkControl";

const OWNER_NONE = "__none__";

type Props = {
	projectId: string;
	organizationId: string | null;
	testCaseId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canEdit: boolean;
	/** Called after a successful create/update so the list can refresh + focus. */
	onSaved?: (testCaseId: string) => void;
};

export function TestCaseEditorSheet({
	projectId,
	organizationId,
	testCaseId,
	open,
	onOpenChange,
	canEdit,
	onSaved,
}: Props) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const isEdit = Boolean(testCaseId);

	const detailEnabled = open && isEdit;
	const { data: detailData, isLoading: detailLoading } = useQuery({
		...orpc.projects.testCases.get.queryOptions({
			input: {
				projectId,
				testCaseId: testCaseId ?? "",
				organizationId,
			},
		}),
		enabled: detailEnabled,
	});
	const detail = detailData?.testCase;

	const { data: membersData } = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
	});
	const members = membersData?.members ?? [];

	// Form state
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [state, setState] = useState<TestCaseState>("DRAFT");
	const [priority, setPriority] = useState<TestCasePriority>("MEDIUM");
	const [automationStatus, setAutomationStatus] =
		useState<AutomationStatus>("NOT_AUTOMATED");
	const [automationRef, setAutomationRef] = useState("");
	const [automationFilePath, setAutomationFilePath] = useState("");
	const [automationExternalUrl, setAutomationExternalUrl] = useState("");
	const [ownerId, setOwnerId] = useState<string>(OWNER_NONE);
	const [tags, setTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const [steps, setSteps] = useState<StepDraft[]>([]);
	const [links, setLinks] = useState<WorkItemLinkDraft[]>([]);
	const [pmAutoSyncEnabled, setPmAutoSyncEnabled] = useState(false);
	const [playwrightScript, setPlaywrightScript] = useState("");

	// Seed the form once per open (edit: when detail arrives; create: blank). The
	// guard ref prevents a later detail refetch from stomping in-progress edits.
	const seededRef = useRef<string | null>(null);
	useEffect(() => {
		if (!open) {
			seededRef.current = null;
			return;
		}
		if (isEdit) {
			if (detail && seededRef.current !== detail.id) {
				seededRef.current = detail.id;
				setTitle(detail.title);
				setDescription(detail.description ?? "");
				setState(detail.state);
				setPriority(detail.priority);
				setAutomationStatus(detail.automationStatus);
				setAutomationRef(detail.automationRef ?? "");
				setAutomationFilePath(detail.automationFilePath ?? "");
				setAutomationExternalUrl(detail.automationExternalUrl ?? "");
				setOwnerId(detail.ownerId ?? OWNER_NONE);
				setTags(detail.tags);
				setSteps(
					detail.steps.map((s) => ({
						key: s.id,
						id: s.id,
						action: s.action,
						expected: s.expected,
					})),
				);
				setLinks(
					detail.workItemLinks.map((l) => ({
						userStoryId: l.userStoryId,
						acceptanceCriterionRefs: l.acceptanceCriterionRefs,
						identifier: l.userStory.identifier,
						title: l.userStory.title,
						kind: l.userStory.kind,
					})),
				);
				setPmAutoSyncEnabled(detail.pmAutoSyncEnabled);
				setPlaywrightScript(detail.playwrightScript ?? "");
			}
		} else if (seededRef.current !== "__create__") {
			seededRef.current = "__create__";
			setTitle("");
			setDescription("");
			setState("DRAFT");
			setPriority("MEDIUM");
			setAutomationStatus("NOT_AUTOMATED");
			setAutomationRef("");
			setAutomationFilePath("");
			setAutomationExternalUrl("");
			setOwnerId(OWNER_NONE);
			setTags([]);
			setTagInput("");
			setSteps([]);
			setLinks([]);
			setPmAutoSyncEnabled(false);
			setPlaywrightScript("");
		}
	}, [open, isEdit, detail]);

	const invalidateLists = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.list.key(),
		});
		if (testCaseId) {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.testCases.get.queryKey({
					input: { projectId, testCaseId, organizationId },
				}),
			});
			// A save records state/priority/title/steps/automation changes on
			// the case's Activity timeline — refresh it, or reopening the sheet
			// shows the edit missing from its own history until the cache goes
			// stale on its own. Procedure-level key: the timeline is split
			// across the 5-row panel and the paged "View all" dialog, and the
			// latter is an `infinite` query an input-scoped key would miss.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.testCases.activityHistory.key(),
			});
		}
	};

	const createMutation = useMutation(
		orpc.projects.testCases.create.mutationOptions({
			onSuccess: (data) => {
				toast.success(t("toasts.created"));
				invalidateLists();
				onSaved?.(data.testCase.id);
				onOpenChange(false);
			},
			onError: (e) =>
				toast.error(t("toasts.createFailed", { error: e.message })),
		}),
	);
	const updateMutation = useMutation(
		orpc.projects.testCases.update.mutationOptions({
			onSuccess: (data) => {
				toast.success(t("toasts.saved"));
				invalidateLists();
				onSaved?.(data.testCase.id);
				onOpenChange(false);
			},
			onError: (e) =>
				toast.error(t("toasts.saveFailed", { error: e.message })),
		}),
	);
	const linkMutation = useMutation(
		orpc.projects.testCases.linkWorkItem.mutationOptions({
			onSuccess: invalidateLists,
			onError: (e) =>
				toast.error(t("toasts.linkFailed", { error: e.message })),
		}),
	);
	const unlinkMutation = useMutation(
		orpc.projects.testCases.unlinkWorkItem.mutationOptions({
			onSuccess: invalidateLists,
			onError: (e) =>
				toast.error(t("toasts.unlinkFailed", { error: e.message })),
		}),
	);

	const pending = createMutation.isPending || updateMutation.isPending;

	const addTag = () => {
		const v = tagInput.trim();
		if (v && !tags.includes(v)) {
			setTags([...tags, v]);
		}
		setTagInput("");
	};

	// A case with no automation intent has nothing to link, so the whole block
	// stays out of the form until the reader says otherwise.
	const automationLinkVisible = automationStatus !== "NOT_AUTOMATED";

	// Recording the first ref marks the case AUTOMATED. The rule lives in the
	// write path, but this form always submits `automationStatus` — and an
	// explicit status wins there — so the flip has to happen here for the two to
	// agree (see `statusAfterRefEdit`).
	const handleAutomationRefChange = (next: string) => {
		setAutomationStatus((current) =>
			statusAfterRefEdit(current, automationRef, next),
		);
		setAutomationRef(next);
	};

	// Link callbacks: edit-mode persists immediately; create-mode holds locally.
	// In edit-mode the local list is updated optimistically, then reverted if the
	// link/unlink mutation fails so the UI never drifts from the server.
	const handleAddLink = (story: {
		id: string;
		identifier: string;
		title: string;
		kind?: string | null;
	}) => {
		setLinks((prev) => [
			...prev,
			{
				userStoryId: story.id,
				acceptanceCriterionRefs: [],
				identifier: story.identifier,
				title: story.title,
				kind: story.kind,
			},
		]);
		if (isEdit && testCaseId) {
			linkMutation.mutate(
				{
					projectId,
					testCaseId,
					organizationId,
					userStoryId: story.id,
				},
				{
					onError: () =>
						setLinks((prev) =>
							prev.filter((l) => l.userStoryId !== story.id),
						),
				},
			);
		}
	};
	const handleRemoveLink = (userStoryId: string) => {
		const removed = links.find((l) => l.userStoryId === userStoryId);
		setLinks((prev) => prev.filter((l) => l.userStoryId !== userStoryId));
		if (isEdit && testCaseId) {
			unlinkMutation.mutate(
				{
					projectId,
					testCaseId,
					organizationId,
					userStoryId,
				},
				{
					onError: () => {
						if (removed) {
							setLinks((prev) =>
								prev.some((l) => l.userStoryId === userStoryId)
									? prev
									: [...prev, removed],
							);
						}
					},
				},
			);
		}
	};
	const handleChangeAcRef = (userStoryId: string, refs: string[]) => {
		setLinks((prev) =>
			prev.map((l) =>
				l.userStoryId === userStoryId
					? { ...l, acceptanceCriterionRefs: refs }
					: l,
			),
		);
	};
	const handleCommitAcRef = (userStoryId: string, refs: string[]) => {
		if (isEdit && testCaseId) {
			linkMutation.mutate({
				projectId,
				testCaseId,
				organizationId,
				userStoryId,
				// The server trims, drops blanks and de-duplicates; this only
				// avoids sending obvious empties.
				acceptanceCriterionRefs: refs
					.map((r) => r.trim())
					.filter(Boolean),
			});
		}
	};

	const handleSave = () => {
		if (!title.trim()) {
			toast.error(t("toasts.titleRequired"));
			return;
		}
		// Only what the reader can see is worth blocking on: a hidden link keeps
		// whatever it already held.
		if (
			automationLinkVisible &&
			automationExternalUrl.trim() &&
			!isLinkableAutomationUrl(automationExternalUrl)
		) {
			toast.error(t("fields.automationUrlInvalid"));
			return;
		}
		const cleanSteps = steps
			.filter((s) => s.action.trim() || s.expected.trim())
			.map((s) => ({
				...(s.id ? { id: s.id } : {}),
				action: s.action,
				expected: s.expected,
			}));
		// Blank clears the field; the write path collapses "" and null to the same
		// stored NULL.
		const automation = {
			automationRef: automationRef.trim() || null,
			automationFilePath: automationFilePath.trim() || null,
			automationExternalUrl: automationExternalUrl.trim() || null,
		};
		const normalizedScript = playwrightScript.trim() || null;
		const originalScript = detail?.playwrightScript ?? null;

		if (isEdit && testCaseId) {
			updateMutation.mutate({
				projectId,
				testCaseId,
				organizationId,
				title: title.trim(),
				description: description.trim() || null,
				state,
				priority,
				automationStatus,
				...automation,
				ownerId: ownerId === OWNER_NONE ? null : ownerId,
				tags,
				pmAutoSyncEnabled,
				...(normalizedScript !== originalScript
					? { playwrightScript: normalizedScript }
					: {}),
				steps: cleanSteps,
			});
		} else {
			createMutation.mutate({
				projectId,
				organizationId,
				title: title.trim(),
				description: description.trim() || null,
				state,
				priority,
				automationStatus,
				...automation,
				ownerId: ownerId === OWNER_NONE ? null : ownerId,
				tags,
				steps: cleanSteps,
				// `acceptanceCriterionRefs`, plural, is the key the create schema
				// declares. Sending the old singular name meant Zod stripped it as
				// an unknown key and every criterion chosen while creating a case
				// was discarded on the way to the server — silently, because a
				// stripped key is not a validation error.
				workItemLinks: links.map((l) => ({
					userStoryId: l.userStoryId,
					acceptanceCriterionRefs: l.acceptanceCriterionRefs ?? [],
				})),
			});
		}
	};

	const showLoading = isEdit && detailLoading && !detail;
	// Edit mode settled with no case = a deleted/foreign id (e.g. a stale
	// `?case=` deep-link). Show a not-found state, not a blank edit form.
	const showNotFound = isEdit && !detailLoading && !detail;
	const readOnly = !canEdit;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
			>
				{showLoading ? (
					<>
						<SheetHeader className="sr-only">
							<SheetTitle>{t("title")}</SheetTitle>
							{/* Radix requires a Description (or aria-describedby) on
							    every Dialog/Sheet — the loaded branch renders a
							    visible SheetDescription, so mirror it here (sr-only)
							    for the brief detail-fetch loading state. */}
							<SheetDescription>
								{t("editor.editDescription")}
							</SheetDescription>
						</SheetHeader>
						<div className="flex flex-1 items-center justify-center text-muted-foreground">
							<Loader2Icon className="size-5 animate-spin" />
						</div>
					</>
				) : showNotFound ? (
					<>
						<SheetHeader className="sr-only">
							<SheetTitle>{t("title")}</SheetTitle>
							<SheetDescription>
								{t("editor.notFound")}
							</SheetDescription>
						</SheetHeader>
						<div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
							<p className="max-w-sm text-muted-foreground text-sm">
								{t("editor.notFound")}
							</p>
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								{t("actions.cancel")}
							</Button>
						</div>
					</>
				) : (
					<>
						<SheetHeader className="space-y-2.5 border-b p-6 text-left">
							<div className="flex flex-wrap items-center gap-2">
								{detail?.identifier && (
									<span className="font-mono text-muted-foreground text-xs tabular-nums">
										{detail.identifier}
									</span>
								)}
								<TestCaseStatusChip
									status={state}
									label={t(STATE_I18N_KEY[state])}
								/>
								{isEdit && detail && (
									<div className="ml-auto">
										<TestCaseResultPill
											result={detail.currentResult}
											label={t(
												RESULT_I18N_KEY[
													detail.currentResult
												],
											)}
										/>
									</div>
								)}
							</div>
							<SheetTitle className="break-words font-serif font-normal text-2xl leading-tight">
								{isEdit
									? title || t("title")
									: t("actions.new")}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{isEdit
									? t("editor.editDescription")
									: t("editor.createDescription")}
							</SheetDescription>
						</SheetHeader>

						<div className="flex-1 space-y-6 overflow-y-auto p-6">
							{/* Title */}
							<div className="space-y-1.5">
								<Label htmlFor="tc-title">
									{t("fields.title")}{" "}
									<span className="text-destructive">*</span>
								</Label>
								<Input
									id="tc-title"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									disabled={readOnly}
									placeholder={t("fields.titlePlaceholder")}
								/>
							</div>

							{/* Description / preconditions */}
							<div className="space-y-1.5">
								<Label htmlFor="tc-desc">
									{t("fields.summary")}
								</Label>
								<Textarea
									id="tc-desc"
									value={description}
									onChange={(e) =>
										setDescription(e.target.value)
									}
									disabled={readOnly}
									rows={3}
									placeholder={t("fields.summaryPlaceholder")}
								/>
							</div>

							{/* State / priority / automation */}
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
								<div className="space-y-1.5">
									<span className="block font-medium text-muted-foreground text-xs">
										{t("fields.state")}
									</span>
									<div>
										<EditableStateChip
											value={state}
											onChange={setState}
											labelFor={(s) =>
												t(STATE_I18N_KEY[s])
											}
											ariaLabel={t(
												"fields.stateEditAria",
											)}
											disabled={readOnly}
										/>
									</div>
								</div>
								<div className="space-y-1.5">
									<span className="block font-medium text-muted-foreground text-xs">
										{t("fields.priority")}
									</span>
									<div>
										<EditablePriorityChip
											value={priority}
											onChange={setPriority}
											labelFor={(p) =>
												t(PRIORITY_I18N_KEY[p])
											}
											ariaLabel={t(
												"fields.priorityEditAria",
											)}
											disabled={readOnly}
										/>
									</div>
								</div>
								<div className="space-y-1.5">
									<Label
										htmlFor="tc-automation"
										className="font-medium text-muted-foreground text-xs"
									>
										{t("fields.automation")}
									</Label>
									<Select
										value={automationStatus}
										onValueChange={(v) =>
											setAutomationStatus(
												v as AutomationStatus,
											)
										}
										disabled={readOnly}
									>
										<SelectTrigger
											id="tc-automation"
											className="h-8"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{AUTOMATION_STATUSES.map((a) => (
												<SelectItem key={a} value={a}>
													{t(AUTOMATION_I18N_KEY[a])}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>

							{/* Automation link — the ref, its spec file and a run link */}
							{automationLinkVisible && (
								<AutomationLinkFields
									automationRef={automationRef}
									automationFilePath={automationFilePath}
									automationExternalUrl={
										automationExternalUrl
									}
									onRefChange={handleAutomationRefChange}
									onFilePathChange={setAutomationFilePath}
									onExternalUrlChange={
										setAutomationExternalUrl
									}
									disabled={readOnly}
								/>
							)}

							{/* Owner + tags */}
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<div className="space-y-1.5">
									<Label htmlFor="tc-owner">
										{t("fields.owner")}
									</Label>
									<Select
										value={ownerId}
										onValueChange={setOwnerId}
										disabled={readOnly}
									>
										<SelectTrigger id="tc-owner">
											<SelectValue
												placeholder={t(
													"fields.ownerNone",
												)}
											/>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={OWNER_NONE}>
												{t("fields.ownerNone")}
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
									<Label htmlFor="tc-tags">
										{t("fields.tags")}
									</Label>
									<Input
										id="tc-tags"
										value={tagInput}
										onChange={(e) =>
											setTagInput(e.target.value)
										}
										onKeyDown={(e) => {
											if (
												e.key === "Enter" ||
												e.key === ","
											) {
												e.preventDefault();
												addTag();
											}
										}}
										onBlur={addTag}
										disabled={readOnly}
										placeholder={t(
											"fields.tagsPlaceholder",
										)}
									/>
									{tags.length > 0 && (
										<div className="flex flex-wrap gap-1.5 pt-1">
											{tags.map((tag) => (
												<span
													key={tag}
													className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
												>
													{tag}
													{!readOnly && (
														<button
															type="button"
															onClick={() =>
																setTags(
																	tags.filter(
																		(x) =>
																			x !==
																			tag,
																	),
																)
															}
															aria-label={t(
																"fields.removeTagAria",
																{ tag },
															)}
															className="rounded-full transition-colors hover:text-foreground"
														>
															<XIcon className="size-3" />
														</button>
													)}
												</span>
											))}
										</div>
									)}
								</div>
							</div>

							{/* Steps */}
							<div className="border-t pt-5">
								<StepEditor
									steps={steps}
									onChange={setSteps}
									disabled={readOnly}
								/>
							</div>

							{isEdit && detail && (
								<PlaywrightScriptEditor
									projectId={projectId}
									organizationId={organizationId}
									testCaseId={detail.id}
									value={playwrightScript}
									onChange={setPlaywrightScript}
									onPersisted={invalidateLists}
									onScriptPersisted={(script) => {
										if (script.trim()) {
											setAutomationStatus("AUTOMATED");
										}
									}}
									readOnly={readOnly}
								/>
							)}

							{/* Work-item links */}
							<div className="border-t pt-5">
								<WorkItemLinkControl
									projectId={projectId}
									organizationId={organizationId}
									links={links}
									onAdd={handleAddLink}
									onRemove={handleRemoveLink}
									onChangeAcRef={handleChangeAcRef}
									onCommitAcRef={
										isEdit ? handleCommitAcRef : undefined
									}
									disabled={readOnly}
								/>
							</div>

							{/* Plan membership (edit-only — needs a persisted case) */}
							{isEdit && detail && (
								<div className="border-t pt-5">
									<PlanMembershipControl
										projectId={projectId}
										organizationId={organizationId}
										testCaseId={detail.id}
										memberships={detail.planLinks.map(
											(p) => ({
												id: p.id,
												planId: p.planId,
												identifier: p.plan.identifier,
												name: p.plan.name,
											}),
										)}
										canEdit={!readOnly}
										onChanged={invalidateLists}
									/>
								</div>
							)}

							{/* Runs — current result, mark + provenance
							    history (edit-only — needs a persisted case) */}
							{isEdit && detail && (
								<div className="border-t pt-5">
									<RunsSection
										projectId={projectId}
										organizationId={organizationId}
										testCaseId={detail.id}
										currentResult={detail.currentResult}
										planLinks={detail.planLinks.map(
											(p) => ({
												planId: p.planId,
												identifier: p.plan.identifier,
												name: p.plan.name,
											}),
										)}
										canEdit={!readOnly}
									/>
								</div>
							)}

							{/* Activity — the edit half of the case history
							    (creation, state/priority/title/steps/automation
							    changes). Sibling of Runs above. */}
							{isEdit && detail && (
								<div className="border-t pt-5">
									<ActivitySection
										projectId={projectId}
										organizationId={organizationId}
										testCaseId={detail.id}
									/>
								</div>
							)}

							{/* PM sync controls (edit-only) */}
							{isEdit && detail && (
								<PmSyncControls
									projectId={projectId}
									organizationId={organizationId}
									testCaseId={detail.id}
									pmAutoSyncEnabled={pmAutoSyncEnabled}
									onToggle={setPmAutoSyncEnabled}
									lastPmSyncStatus={detail.lastPmSyncStatus}
									lastPmSyncError={detail.lastPmSyncError}
									disabled={readOnly}
								/>
							)}
						</div>

						{/* Footer */}
						<div className="flex items-center justify-end gap-2 border-t p-4">
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={pending}
							>
								{t("actions.cancel")}
							</Button>
							{!readOnly && (
								<Button onClick={handleSave} disabled={pending}>
									{pending && (
										<Loader2Icon className="mr-2 size-4 animate-spin" />
									)}
									{isEdit
										? t("actions.save")
										: t("actions.create")}
								</Button>
							)}
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
