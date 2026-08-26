"use client";

import { prefixDiffPart } from "@shared/lib/line-diff";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { diffLines } from "diff";
import {
	HistoryIcon,
	Loader2Icon,
	RotateCcwIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type GenerationChoice = "AGENT_RUN_AND_REPO" | "REPO_ONLY" | "MANUAL";

type RevisionOrigin = "MANUAL" | "AGENT_RUN_AND_REPO" | "REPO_ONLY" | "REVERT";

const ORIGIN_KEYS: Record<RevisionOrigin, string> = {
	MANUAL: "origin.manual",
	AGENT_RUN_AND_REPO: "origin.agentRun",
	REPO_ONLY: "origin.repository",
	REVERT: "origin.restore",
};
const HISTORY_PAGE_SIZE = 25;

function isGenerationChoice(value: string): value is GenerationChoice {
	return (
		value === "AGENT_RUN_AND_REPO" ||
		value === "REPO_ONLY" ||
		value === "MANUAL"
	);
}

export function PlaywrightScriptEditor({
	projectId,
	organizationId,
	testCaseId,
	value,
	onChange,
	onPersisted,
	onScriptPersisted,
	readOnly,
}: {
	projectId: string;
	organizationId: string | null;
	testCaseId: string;
	value: string;
	onChange: (value: string) => void;
	onPersisted: () => void;
	onScriptPersisted: (value: string) => void;
	readOnly: boolean;
}) {
	const t = useTranslations("projects.testCases.scripted");
	const queryClient = useQueryClient();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [generateOpen, setGenerateOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [choice, setChoice] =
		useState<GenerationChoice>("AGENT_RUN_AND_REPO");
	const [sourceResultEventId, setSourceResultEventId] = useState<string>("");
	const [selectedRevisionId, setSelectedRevisionId] = useState<string>("");

	const sourcesQuery = useInfiniteQuery({
		...orpc.projects.testCases.playwrightScript.sources.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				organizationId,
				testCaseId,
				limit: HISTORY_PAGE_SIZE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, pages) => {
				const loaded = pages.reduce(
					(sum, page) => sum + page.items.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		enabled: generateOpen,
	});
	const sources =
		sourcesQuery.data?.pages.flatMap((page) => page.items) ?? [];
	useEffect(() => {
		if (
			sources.length > 0 &&
			!sources.some(
				(source) => source.resultEventId === sourceResultEventId,
			)
		) {
			setSourceResultEventId(sources[0].resultEventId);
		}
	}, [sources, sourceResultEventId]);

	const revisionsQuery = useInfiniteQuery({
		...orpc.projects.testCases.playwrightScript.revisions.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				organizationId,
				testCaseId,
				limit: HISTORY_PAGE_SIZE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, pages) => {
				const loaded = pages.reduce(
					(sum, page) => sum + page.items.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		enabled: historyOpen,
	});
	const revisions =
		revisionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
	useEffect(() => {
		if (
			revisions.length > 0 &&
			!revisions.some((revision) => revision.id === selectedRevisionId)
		) {
			setSelectedRevisionId(revisions[0].id);
		}
	}, [revisions, selectedRevisionId]);

	const revisionQuery = useQuery({
		...orpc.projects.testCases.playwrightScript.revision.queryOptions({
			input: {
				projectId,
				organizationId,
				testCaseId,
				revisionId: selectedRevisionId,
			},
		}),
		enabled: historyOpen && Boolean(selectedRevisionId),
	});
	const selectedRevision = revisionQuery.data?.revision;
	const scriptDiff = useMemo(
		() =>
			selectedRevision ? diffLines(selectedRevision.script, value) : [],
		[selectedRevision, value],
	);

	const invalidateHistory = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.playwrightScript.revisions.key(),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.get.queryKey({
				input: { projectId, testCaseId, organizationId },
			}),
		});
		onPersisted();
	};

	const generateMutation = useMutation(
		orpc.projects.testCases.generatePlaywrightScript.mutationOptions({
			onSuccess: ({ script }) => {
				onChange(script);
				onScriptPersisted(script);
				invalidateHistory();
				setGenerateOpen(false);
				toast.success(t("generated"));
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const restoreMutation = useMutation(
		orpc.projects.testCases.playwrightScript.restore.mutationOptions({
			onSuccess: ({ script }) => {
				onChange(script);
				onScriptPersisted(script);
				invalidateHistory();
				toast.success(t("restored"));
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const submitGeneration = () => {
		if (choice === "MANUAL") {
			setGenerateOpen(false);
			requestAnimationFrame(() => textareaRef.current?.focus());
			return;
		}
		generateMutation.mutate({
			projectId,
			testCaseId,
			generationSource: choice,
			...(choice === "AGENT_RUN_AND_REPO" && sourceResultEventId
				? { sourceResultEventId }
				: {}),
		});
	};

	const cannotGenerate =
		generateMutation.isPending ||
		(choice === "AGENT_RUN_AND_REPO" &&
			(sourcesQuery.isLoading || !sourceResultEventId));

	return (
		<div className="space-y-2 border-t pt-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<Label htmlFor="tc-playwright-script">{t("label")}</Label>
					<p className="mt-1 max-w-2xl text-muted-foreground text-xs">
						{t("hint")}
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setHistoryOpen(true)}
					>
						<HistoryIcon
							className="mr-1.5 size-3.5"
							aria-hidden="true"
						/>
						{t("history")}
					</Button>
					{!readOnly && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setGenerateOpen(true)}
						>
							<SparklesIcon
								className="mr-1.5 size-3.5"
								aria-hidden="true"
							/>
							{value.trim() ? t("regenerate") : t("generate")}
						</Button>
					)}
				</div>
			</div>
			<Textarea
				ref={textareaRef}
				id="tc-playwright-script"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				readOnly={readOnly}
				rows={14}
				spellCheck={false}
				className="font-mono text-xs"
				placeholder={'{\n  "version": 1,\n  "steps": []\n}'}
			/>
			{!readOnly && (
				<p className="text-muted-foreground text-xs">
					{t("manualSaveHint")}
				</p>
			)}

			<Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>{t("generator.title")}</DialogTitle>
						<DialogDescription>
							{t("generator.description")}
						</DialogDescription>
					</DialogHeader>
					<RadioGroup
						value={choice}
						onValueChange={(next) => {
							if (isGenerationChoice(next)) {
								setChoice(next);
							}
						}}
						className="gap-3"
					>
						<GenerationOption
							id="script-source-agent"
							value="AGENT_RUN_AND_REPO"
							checked={choice === "AGENT_RUN_AND_REPO"}
							title={t("generator.agent.title")}
							description={t("generator.agent.description")}
						/>
						{choice === "AGENT_RUN_AND_REPO" && (
							<div className="ml-7 space-y-1.5">
								<Label htmlFor="script-agent-run">
									{t("generator.agent.runLabel")}
								</Label>
								{sourcesQuery.isLoading ? (
									<p className="text-muted-foreground text-sm">
										{t("loading")}
									</p>
								) : sourcesQuery.isError ? (
									<div className="rounded-md border border-destructive/30 p-3 text-sm">
										<p>{t("loadFailed")}</p>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onClick={() =>
												sourcesQuery.refetch()
											}
										>
											{t("retry")}
										</Button>
									</div>
								) : sources.length === 0 ? (
									<p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
										{t("generator.agent.empty")}
									</p>
								) : (
									<>
										<Select
											value={sourceResultEventId}
											onValueChange={
												setSourceResultEventId
											}
										>
											<SelectTrigger id="script-agent-run">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{sources.map((source) => (
													<SelectItem
														key={
															source.resultEventId
														}
														value={
															source.resultEventId
														}
													>
														{formatTimestamp(
															source.occurredAt,
														)}{" "}
														· {source.result} ·{" "}
														{source.triggeredByActor ??
															t("unknownAuthor")}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										{sourcesQuery.hasNextPage && (
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={
													sourcesQuery.isFetchingNextPage
												}
												onClick={() =>
													sourcesQuery.fetchNextPage()
												}
											>
												{t("loadMore")}
											</Button>
										)}
									</>
								)}
							</div>
						)}
						<GenerationOption
							id="script-source-repo"
							value="REPO_ONLY"
							checked={choice === "REPO_ONLY"}
							title={t("generator.repository.title")}
							description={t("generator.repository.description")}
						/>
						<GenerationOption
							id="script-source-manual"
							value="MANUAL"
							checked={choice === "MANUAL"}
							title={t("generator.manual.title")}
							description={t("generator.manual.description")}
						/>
					</RadioGroup>
					<p className="rounded-md bg-muted p-3 text-muted-foreground text-xs">
						{t("generator.tokenHint")}
					</p>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setGenerateOpen(false)}
						>
							{t("cancel")}
						</Button>
						<Button
							type="button"
							disabled={cannotGenerate}
							onClick={submitGeneration}
						>
							{generateMutation.isPending && (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							)}
							{choice === "MANUAL"
								? t("generator.edit")
								: t("generator.generate")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
				<DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl">
					<DialogHeader>
						<DialogTitle>{t("revisions.title")}</DialogTitle>
						<DialogDescription>
							{t("revisions.description")}
						</DialogDescription>
					</DialogHeader>
					{revisionsQuery.isLoading ? (
						<div className="flex justify-center p-8">
							<Loader2Icon
								className="size-5 motion-safe:animate-spin"
								aria-label={t("loading")}
							/>
						</div>
					) : revisionsQuery.isError ? (
						<div className="rounded-md border border-destructive/30 p-6 text-center text-sm">
							<p>{t("loadFailed")}</p>
							<Button
								type="button"
								variant="ghost"
								onClick={() => revisionsQuery.refetch()}
							>
								{t("retry")}
							</Button>
						</div>
					) : revisions.length === 0 ? (
						<p className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
							{t("revisions.empty")}
						</p>
					) : (
						<div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[17rem_minmax(0,1fr)]">
							<ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
								{revisions.map((revision) => (
									<li key={revision.id}>
										<button
											type="button"
											onClick={() =>
												setSelectedRevisionId(
													revision.id,
												)
											}
											aria-pressed={
												selectedRevisionId ===
												revision.id
											}
											className={cn(
												"w-full rounded-md border p-3 text-left transition-colors",
												selectedRevisionId ===
													revision.id
													? "border-primary bg-primary/5"
													: "hover:bg-muted",
											)}
										>
											<span className="block font-medium text-sm">
												{t(
													ORIGIN_KEYS[
														revision.origin
													],
												)}
											</span>
											<span
												className="mt-1 block text-muted-foreground text-xs"
												title={formatTimestamp(
													revision.createdAt,
												)}
											>
												{formatTimestamp(
													revision.createdAt,
												)}
											</span>
											<span className="mt-1 block text-muted-foreground text-xs">
												{revision.author ??
													t("unknownAuthor")}
											</span>
										</button>
									</li>
								))}
								{revisionsQuery.hasNextPage && (
									<li>
										<Button
											type="button"
											variant="ghost"
											className="w-full"
											disabled={
												revisionsQuery.isFetchingNextPage
											}
											onClick={() =>
												revisionsQuery.fetchNextPage()
											}
										>
											{t("loadMore")}
										</Button>
									</li>
								)}
							</ul>
							<div className="min-h-0">
								{revisionQuery.isError ? (
									<div className="rounded-md border border-destructive/30 p-6 text-center text-sm">
										<p>{t("loadFailed")}</p>
										<Button
											type="button"
											variant="ghost"
											onClick={() =>
												revisionQuery.refetch()
											}
										>
											{t("retry")}
										</Button>
									</div>
								) : revisionQuery.isLoading ||
									!selectedRevision ? (
									<div className="flex justify-center p-8">
										<Loader2Icon
											className="size-5 motion-safe:animate-spin"
											aria-label={t("loading")}
										/>
									</div>
								) : (
									<div className="space-y-3">
										<div className="flex items-center justify-between gap-3">
											<p className="text-muted-foreground text-xs">
												{t("revisions.diffHint")}
											</p>
											{!readOnly && (
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={
														restoreMutation.isPending ||
														selectedRevision.script ===
															value
													}
													onClick={() =>
														restoreMutation.mutate({
															projectId,
															organizationId,
															testCaseId,
															revisionId:
																selectedRevision.id,
														})
													}
												>
													<RotateCcwIcon
														className="mr-1.5 size-3.5"
														aria-hidden="true"
													/>
													{t("revisions.restore")}
												</Button>
											)}
										</div>
										<pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
											{scriptDiff.map((part, index) => (
												<span
													key={`${index}-${part.value.length}`}
													className={cn(
														part.added &&
															"bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
														part.removed &&
															"bg-red-500/15 text-red-800 dark:text-red-300",
													)}
												>
													{prefixDiffPart(part)}
												</span>
											))}
										</pre>
									</div>
								)}
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

function GenerationOption({
	id,
	value,
	checked,
	title,
	description,
}: {
	id: string;
	value: GenerationChoice;
	checked: boolean;
	title: string;
	description: string;
}) {
	return (
		<Label
			htmlFor={id}
			className={cn(
				"flex cursor-pointer items-start gap-3 rounded-md border p-3",
				checked && "border-primary bg-primary/5",
			)}
		>
			<RadioGroupItem id={id} value={value} className="mt-0.5" />
			<span>
				<span className="block font-medium">{title}</span>
				<span className="mt-0.5 block font-normal text-muted-foreground text-sm">
					{description}
				</span>
			</span>
		</Label>
	);
}

function formatTimestamp(value: Date | string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "—"
		: date.toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			});
}
