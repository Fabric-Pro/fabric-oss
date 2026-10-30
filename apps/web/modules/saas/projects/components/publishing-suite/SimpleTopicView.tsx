"use client";

import { composeCaseStudyWorkingDraftBody } from "@repo/utils/publishing-case-study-body";
import {
	composeNewsletterBlurbWorkingDraftBody,
	PublishingNewsletterBlurbSchema,
} from "@repo/utils/publishing-newsletter-blurb-body";
import { composeStakeholderEmailWorkingDraftBody } from "@repo/utils/publishing-stakeholder-email-body";
import {
	composeWebinarScriptWorkingDraftBody,
	PublishingWebinarScriptSchema,
} from "@repo/utils/publishing-webinar-script-body";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CaseStudyAssets } from "./CaseStudyPanel";
import { CopyDraftButton } from "./CopyDraftButton";
import { DraftRefinementReview, useDraftRefinement } from "./DraftRefinement";
import { FEED_FOLD_ESTIMATE } from "./feed-fold";
import type { TopicDraftState, TopicWorkingDraftState } from "./GenerationTabs";
import {
	decisionLabel,
	type GenerationTabInfo,
	restrictsPostType,
} from "./generation-tab-state";
import { TopicBlockers } from "./TopicBlockers";
import {
	type TopicDecisionThread,
	TopicQuestionsPanel,
} from "./TopicQuestionsPanel";
import {
	GENERATION_ACTIVE_POST_TYPES,
	GUIDANCE_MAX,
	POST_TYPE_LABELS,
	type PostType,
} from "./topic-shared";

const suite = orpc.projects.publishingSuite;
const adopters = {
	BLOG_POST: suite.adoptBlogPostDraft,
	CASE_STUDY: suite.adoptCaseStudyDraft,
	STAKEHOLDER_EMAIL: suite.adoptStakeholderEmailDraft,
	WEBINAR_SCRIPT: suite.adoptWebinarScriptDraft,
	NEWSLETTER_BLURB: suite.adoptNewsletterBlurbDraft,
};

function readyBody(postType: PostType, content: unknown): string | null {
	if (!content || typeof content !== "object") {
		return null;
	}
	if (postType === "WEBINAR_SCRIPT") {
		const parsed = PublishingWebinarScriptSchema.safeParse(content);
		return parsed.success
			? composeWebinarScriptWorkingDraftBody(parsed.data)
			: null;
	}
	if (postType === "NEWSLETTER_BLURB") {
		const parsed = PublishingNewsletterBlurbSchema.safeParse(content);
		return parsed.success
			? composeNewsletterBlurbWorkingDraftBody(parsed.data)
			: null;
	}
	const raw = content as {
		body?: unknown;
		title?: unknown;
		subject?: unknown;
		subtitle?: unknown;
	};
	if (typeof raw.body !== "string" || !raw.body.trim()) {
		return null;
	}
	if (postType === "STAKEHOLDER_EMAIL") {
		return typeof raw.subject === "string"
			? composeStakeholderEmailWorkingDraftBody({
					subject: raw.subject,
					body: raw.body,
				})
			: null;
	}
	if (typeof raw.title !== "string" || !raw.title.trim()) {
		return null;
	}
	if (postType === "CASE_STUDY") {
		return composeCaseStudyWorkingDraftBody({
			title: raw.title,
			body: raw.body,
		});
	}
	return [
		`# ${raw.title.trim()}`,
		typeof raw.subtitle === "string" && raw.subtitle.trim()
			? `_${raw.subtitle.trim()}_`
			: null,
		raw.body.trim(),
	]
		.filter(Boolean)
		.join("\n\n");
}

const generators = {
	TWEET: suite.generateShortPost,
	LINKEDIN_POST: suite.generateLinkedInPost,
	BLOG_POST: suite.generateBlogPost,
	CASE_STUDY: suite.generateCaseStudy,
	STAKEHOLDER_EMAIL: suite.generateStakeholderEmail,
	WEBINAR_SCRIPT: suite.generateWebinarScript,
	NEWSLETTER_BLURB: suite.generateNewsletterBlurb,
};

interface Props {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
	postTypes: readonly PostType[];
	selectedType: PostType | null;
	onSelectType: (type: PostType) => void;
	onAddType: (types: PostType[]) => Promise<void>;
	onAdvanced: (type: PostType) => void;
	drafts: TopicDraftState[];
	workingDrafts: TopicWorkingDraftState[];
	threads: TopicDecisionThread[];
	tabs: readonly GenerationTabInfo[];
	isLoading: boolean;
	isActive?: boolean;
	hasBlockers: boolean;
	members: ComponentProps<typeof TopicQuestionsPanel>["members"];
}

export function SimpleTopicView(props: Props) {
	const generation = useSimpleGeneration(props);
	const [visitedTypes, setVisitedTypes] = useState<PostType[]>([]);
	if (props.selectedType && !visitedTypes.includes(props.selectedType)) {
		setVisitedTypes([...visitedTypes, props.selectedType]);
	}
	const [more, setMore] = useState(false);
	return (
		<div className="mx-auto w-full max-w-3xl space-y-6">
			<section
				className="space-y-3"
				aria-label="Make a post from this topic"
			>
				<h2 className="font-semibold">Make a post from this topic</h2>
				<div className="flex flex-wrap gap-2">
					{POST_TYPE_LABELS.filter(
						(t) =>
							GENERATION_ACTIVE_POST_TYPES.has(t.value) &&
							(more || props.postTypes.includes(t.value)),
					).map((t) => (
						<Button
							key={t.value}
							variant={
								props.selectedType === t.value
									? "primary"
									: "outline"
							}
							size="sm"
							className="rounded-full"
							aria-pressed={props.selectedType === t.value}
							onClick={async () => {
								if (!props.postTypes.includes(t.value)) {
									if (!props.canEdit) {
										return;
									}
									try {
										await props.onAddType([
											...props.postTypes,
											t.value,
										]);
									} catch {
										return;
									}
								}
								if (
									props.canEdit &&
									!props.isLoading &&
									!props.workingDrafts.some(
										(w) => w.postType === t.value,
									) &&
									!props.drafts.some(
										(d) =>
											d.postType === t.value &&
											(d.latestAttempt || d.latestReady),
									) &&
									!props.hasBlockers &&
									!props.threads.some((thread) =>
										restrictsPostType(thread, t.value),
									)
								) {
									generation.start(t.value);
								}
								props.onSelectType(t.value);
							}}
						>
							<span className="sr-only">
								{t.generationLabel ?? t.label}
							</span>
							<span aria-hidden="true">{t.shortLabel}</span>
							{props.tabs.find((tab) => tab.postType === t.value)
								?.bucket === "recommended"
								? " · Recommended"
								: ""}
						</Button>
					))}
					{props.canEdit &&
					!more &&
					props.postTypes.length < POST_TYPE_LABELS.length ? (
						<Button
							variant="outline"
							size="sm"
							className="rounded-full border-dashed"
							onClick={() => setMore(true)}
						>
							More types
						</Button>
					) : null}
				</div>
			</section>
			{visitedTypes.map((value) => (
				<div
					key={value}
					hidden={props.selectedType !== value}
					inert={props.selectedType !== value}
				>
					<SimpleDraft
						{...props}
						postType={value}
						generation={generation}
						isActive={
							props.isActive !== false &&
							props.selectedType === value
						}
					/>
				</div>
			))}
		</div>
	);
}

function useSimpleGeneration(props: Props) {
	const queryClient = useQueryClient();
	const [inProgress, setInProgress] = useState<PostType | null>(null);
	const input = {
		projectId: props.projectId,
		topicId: props.topicId,
		organizationId: props.organizationId,
	};
	const generate = useMutation({
		mutationFn: ({ postType }: { postType: PostType }, context) =>
			generators[postType].mutationOptions().mutationFn!(
				{
					...input,
					guidance: null,
					...(postType === "TWEET" || postType === "LINKEDIN_POST"
						? { seedWorkingDraft: true }
						: {}),
				},
				context,
			),
		onSuccess: async (result, { postType }) => {
			const reason = (result as { reason?: string }).reason;
			if (!result.started && reason === "in-progress") {
				setInProgress(postType);
			} else if (!result.started) {
				toast.info(
					reason === "unavailable"
						? "Generation is temporarily unavailable. Try again shortly."
						: `Generation could not start: ${reason}.`,
				);
			}
			await queryClient.invalidateQueries({
				queryKey: suite.listTopicDrafts.queryKey({ input }),
			});
		},
		onError: () => toast.error("Could not start generation."),
	});
	const start = (postType: PostType) => {
		if (!props.canEdit || props.isLoading || generate.isPending) {
			return;
		}
		generate.mutate({ postType });
	};
	return { generate, start, inProgress };
}

function SimpleDraft(
	props: Props & {
		postType: PostType;
		generation: ReturnType<typeof useSimpleGeneration>;
	},
) {
	const { projectId, topicId, organizationId, postType, canEdit } = props;
	const input = { projectId, topicId, organizationId };
	const queryClient = useQueryClient();
	const working =
		props.workingDrafts.find((w) => w.postType === postType) ?? null;
	const draft = props.drafts.find((d) => d.postType === postType);
	const label =
		POST_TYPE_LABELS.find((t) => t.value === postType)?.label ?? postType;
	const [preview, setPreview] = useState<string | null>(null);
	const [instruction, setInstruction] = useState("");
	const [answers, setAnswers] = useState<string[]>([]);
	const unanswered = props.threads
		.filter(
			(t) =>
				t.root.kind === "QUESTION" &&
				t.root.decisionKind !== "CONTENT_TYPE" &&
				(t.root.status === "OPEN" ||
					t.root.status === "POSSIBLY_RESOLVED"),
		)
		.slice(0, 3);
	const questions = unanswered.length ? (
		<section className="space-y-3">
			<h2 className="font-semibold">Make it better (optional)</h2>
			<TopicQuestionsPanel
				isActive={props.isActive}
				{...input}
				canEdit={canEdit}
				threads={unanswered}
				members={props.members}
				onAnswerSaved={(question) =>
					setAnswers((previous) => [...previous, question])
				}
			/>
		</section>
	) : null;
	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: suite.listTopicDrafts.queryKey({ input }),
		});
	const { generate } = props.generation;
	const select = useMutation(
		(postType === "LINKEDIN_POST"
			? suite.selectLinkedInPostOption
			: suite.selectShortPostOption
		).mutationOptions({
			onSuccess: invalidate,
			onError: async (error) => {
				toast.error(error.message);
				await invalidate();
			},
		}),
	);
	const refinement = useDraftRefinement({
		...input,
		postType,
		working,
		label,
		onStarted: () => setAnswers([]),
	});
	const proposalRef = useRef<HTMLDivElement>(null);
	const proposalKey =
		refinement.state?.status === "READY"
			? String(refinement.state.updatedAt)
			: null;
	const seenProposal = useRef<string | null>(null);
	useEffect(() => {
		if (!proposalKey || seenProposal.current === proposalKey) {
			return;
		}
		seenProposal.current = proposalKey;
		const focused = document.activeElement;
		if (
			props.isActive !== false &&
			!(
				focused instanceof HTMLElement &&
				focused.closest(
					"input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
				)
			)
		) {
			proposalRef.current?.focus();
		}
	}, [proposalKey, props.isActive]);

	const attempt = draft?.latestAttempt;
	const warnings = props.threads.filter((t) =>
		restrictsPostType(t, postType),
	);
	const hasBlockers = props.hasBlockers || warnings.length > 0;
	const running =
		(props.generation.inProgress === postType && !attempt) ||
		(generate.isPending && generate.variables?.postType === postType) ||
		(attempt?.status === "GENERATING" && !attempt.isExpired);
	const start = () => props.generation.start(postType);
	const raw = draft?.latestReady?.content as {
		options?: { label: string; text: string }[];
	} | null;
	const options =
		(postType === "TWEET" || postType === "LINKEDIN_POST") &&
		Array.isArray(raw?.options)
			? raw.options.filter(
					(o) =>
						o != null &&
						typeof o.label === "string" &&
						typeof o.text === "string",
				)
			: [];

	const candidateBody =
		postType in adopters
			? readyBody(postType, draft?.latestReady?.content)
			: null;
	const adopt = useMutation({
		mutationFn: (_: void, context) =>
			adopters[postType as keyof typeof adopters].mutationOptions()
				.mutationFn!(
				{
					...input,
					draftId: draft!.latestReady!.id,
					expectedUpdatedAt: working
						? new Date(working.updatedAt)
						: null,
				},
				context,
			),
		onSuccess: invalidate,
		onError: async (error) => {
			toast.error(error.message);
			await invalidate();
		},
	});

	return (
		<>
			{props.threads.some((t) => t.root.kind === "BLOCKER") ? (
				<TopicBlockers
					{...input}
					threads={props.threads}
					canEdit={canEdit}
				/>
			) : null}
			{warnings.length ? (
				<div className="rounded-lg border border-highlight/40 bg-highlight/10 p-3 text-sm">
					<p>
						Unresolved approvals or questions constrain this draft:
					</p>
					<ul>
						{warnings.map((t) => (
							<li key={t.root.id}>
								{decisionLabel(
									t.root.subject,
									t.root.decisionKind,
								)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{!working && !attempt && hasBlockers && canEdit ? (
				<section className="space-y-3 rounded-lg border p-4">
					<h2 className="font-semibold">
						One quick question first (optional)
					</h2>
					{questions}
					<Button
						onClick={start}
						disabled={running || props.isLoading}
					>
						Generate
					</Button>
					<Button
						variant="outline"
						onClick={start}
						disabled={running || props.isLoading}
					>
						Skip and generate
					</Button>
				</section>
			) : null}
			{postType === "CASE_STUDY" ? (
				<CaseStudyAssets
					content={
						working?.sourceContent ?? draft?.latestReady?.content
					}
				/>
			) : null}
			<Card>
				<CardHeader className="gap-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 className="font-semibold">{label}</h2>
						{working?.hasBody ? (
							<CopyDraftButton
								markdown={working.body}
								variant="primary"
							/>
						) : null}
					</div>
					{options.length ? (
						<div className="space-y-3">
							<div
								role="group"
								aria-label="Takes"
								className="flex flex-wrap gap-2"
							>
								{options.map((o) => (
									<Button
										key={o.label}
										variant="outline"
										aria-pressed={preview === o.label}
										onClick={() => setPreview(o.label)}
									>
										{o.label}
									</Button>
								))}
							</div>
							{preview ? (
								<>
									<p className="whitespace-pre-wrap">
										{
											options.find(
												(o) => o.label === preview,
											)?.text
										}
									</p>
									{canEdit ? (
										<Button
											disabled={
												select.isPending ||
												props.isLoading
											}
											onClick={() => {
												if (!draft?.latestReady) {
													return;
												}
												const sameBody =
													working?.body ===
													options.find(
														(option) =>
															option.label ===
															preview,
													)?.text;
												if (
													working?.hasBody &&
													!sameBody &&
													!window.confirm(
														postType ===
															"LINKEDIN_POST"
															? "This replaces the LinkedIn post you saved earlier. Continue?"
															: "This replaces the short post you saved earlier. Continue?",
													)
												) {
													return;
												}
												select.mutate({
													...input,
													draftId:
														draft.latestReady.id,
													optionLabel: preview,
													expectedUpdatedAt: working
														? new Date(
																working.updatedAt,
															)
														: null,
												});
											}}
										>
											Use this take
										</Button>
									) : null}
								</>
							) : null}
						</div>
					) : null}
				</CardHeader>
				<CardContent className="space-y-4">
					{running ? (
						<p role="status">Writing your {label.toLowerCase()}…</p>
					) : null}
					{attempt?.status === "FAILED" || attempt?.isExpired ? (
						<div role="alert">
							<p>
								{attempt.error ?? "Generation did not finish."}
							</p>
							{canEdit ? (
								<Button onClick={start} disabled={running}>
									Retry
								</Button>
							) : null}
						</div>
					) : null}
					{working?.hasBody ? (
						<>
							<div className="whitespace-pre-wrap break-words">
								{working.body}
							</div>
							<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
								<span>
									{working.body.length} characters
									{(postType === "TWEET" ||
										postType === "LINKEDIN_POST") &&
									working.body.length > FEED_FOLD_ESTIMATE
										? ` · first ~${FEED_FOLD_ESTIMATE} show before see more`
										: ""}{" "}
									· Saved{" "}
									{new Date(
										working.updatedAt,
									).toLocaleString()}
								</span>
								<Button
									variant="link"
									size="sm"
									onClick={() => props.onAdvanced(postType)}
								>
									{draft?.versions.length ?? 0}{" "}
									{draft?.versions.length === 1
										? "version"
										: "versions"}
								</Button>
								{canEdit ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() =>
											props.onAdvanced(postType)
										}
									>
										Edit text
									</Button>
								) : null}
							</div>
						</>
					) : candidateBody ? (
						<div className="space-y-3">
							<div className="whitespace-pre-wrap break-words">
								{candidateBody}
							</div>
							{canEdit ? (
								<Button
									disabled={
										adopt.isPending || props.isLoading
									}
									onClick={() => adopt.mutate()}
								>
									Use this draft
								</Button>
							) : null}
						</div>
					) : options.length ? (
						<div className="space-y-3">
							{options.map((o) => (
								<p
									key={o.label}
									className="whitespace-pre-wrap"
								>
									{o.text}
								</p>
							))}
						</div>
					) : !running && !hasBlockers && canEdit ? (
						<Button onClick={start} disabled={props.isLoading}>
							Generate
						</Button>
					) : null}
					<div ref={proposalRef} tabIndex={-1}>
						<DraftRefinementReview
							refinement={refinement}
							baseline={working?.body ?? ""}
							label={label}
							canEdit={canEdit}
						/>
					</div>
				</CardContent>
			</Card>
			{canEdit && working?.hasBody ? (
				<section className="space-y-3" aria-label="Change it">
					<h2 className="font-semibold">Change it</h2>
					<div className="flex flex-wrap gap-2">
						{[
							"Shorter",
							"More casual",
							"More technical",
							"Stronger opening",
							"Add a call to action",
						].map((text) => (
							<Button
								key={text}
								variant="outline"
								size="sm"
								className="rounded-full"
								disabled={!refinement.canStart}
								onClick={() => refinement.start(text)}
							>
								{text}
							</Button>
						))}
					</div>
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (instruction.trim()) {
								refinement.start(instruction);
							}
						}}
					>
						<Input
							aria-label="Describe a change"
							maxLength={GUIDANCE_MAX}
							value={instruction}
							onChange={(e) => setInstruction(e.target.value)}
						/>
						<Button
							type="submit"
							disabled={
								!instruction.trim() || !refinement.canStart
							}
						>
							Refine
						</Button>
					</form>
					{refinement.isRunning ? (
						<p role="status">Refining your draft…</p>
					) : null}
				</section>
			) : null}
			{canEdit && (!hasBlockers || working) ? questions : null}
			{canEdit && working?.hasBody && answers.length ? (
				<Button
					variant="outline"
					disabled={!refinement.canStart}
					onClick={() =>
						refinement.start(
							`Revise the draft to reflect my new answers to these questions:\n${answers.map((question) => question.slice(0, 500)).join("\n")}`.slice(
								0,
								1900,
							),
						)
					}
				>
					Update draft with my answers
				</Button>
			) : null}
		</>
	);
}
