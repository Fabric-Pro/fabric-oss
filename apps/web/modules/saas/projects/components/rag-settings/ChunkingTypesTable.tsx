"use client";

import {
	CHUNK_PROFILES,
	type ChunkProfile,
	type ContentKind,
	CUSTOM_CHUNK_LIMITS,
	type CustomSplitMethod,
	isChunkProfile,
	isContentKind,
	PROFILE_SIZE_LIMITS,
	PROFILE_SIZES,
} from "@repo/rag/lib/chunking/profile-catalog";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useState } from "react";
import { toast } from "sonner";
import { ChunkingAnalysisActions } from "./ChunkingAnalysis";

/**
 * Per-type chunking on RAG Settings (spec 2026-10-28 §6, §8b, §8c): one row
 * per content type found in the project, with what is in the index for it
 * (sources, chunks, sizes), its last measured recall, the chunking chosen
 * for it and a suggestion when one differs. Every type starts on Custom,
 * today's chunker with the project's split method, size and overlap, so
 * nothing changes until someone picks a profile or sets a type's own values.
 * Advanced shows a structural profile's sizes.
 */

export type ChunkTypeEntry = {
	custom?: true;
	/** The earlier name of `custom`, still on stored rows. */
	standard?: true;
	splitMethod?: CustomSplitMethod;
	chunkSize?: number;
	chunkOverlap?: number;
	profile?: ChunkProfile;
	target?: number;
	max?: number;
	overlap?: number;
};

/** The project's own values: where a Custom type without its own starts. */
export type CustomChunkDefaults = {
	splitMethod: CustomSplitMethod;
	chunkSize: number;
	chunkOverlap: number;
};

export type SplitMethodOption = { value: CustomSplitMethod; label: string };

/** Keyed by a content kind, or by the detected profile for untyped content. */
export type ChunkTypeKey = ContentKind | ChunkProfile;

export type ChunkTypeEntries = Partial<Record<ChunkTypeKey, ChunkTypeEntry>>;

/** Whether a quality-panel group can carry a per-type row. */
function isChunkTypeKey(value: string): value is ChunkTypeKey {
	return isContentKind(value) || isChunkProfile(value);
}

type Choice = "custom" | "auto" | ChunkProfile;

const STRUCTURAL = CHUNK_PROFILES.filter(
	(p): p is Exclude<ChunkProfile, "openapi" | "prose"> =>
		p !== "openapi" && p !== "prose",
);

const CHOICE_LABELS: Record<Choice, string> = {
	custom: "Custom",
	auto: "Auto (detected)",
	sectioned: "Sections",
	whole: "Whole",
	items: "List items",
	dated: "Dated entries",
	dialogue: "Speaker turns",
	tabular: "Table rows",
	prose: "Prose (sentence-aware)",
	openapi: "OpenAPI",
};

/**
 * What content a row covers, in plain words. Content-kind rows come from
 * what the source is (a Fabric document type, a repository-import
 * classification); profile rows hold sources without a known kind, grouped
 * by the shape detection found in them.
 */
const TYPE_HINTS: Record<ChunkTypeKey, string> = {
	sectioned:
		"Untyped files and pages with headings: Markdown docs, READMEs, wiki pages",
	prose: "Untyped plain text without clear structure: notes, emails, pasted text",
	items: "Untyped lists: bullet or numbered items, task and backlog lists",
	dated: "Untyped entries under dates: logs, journals, changelogs",
	dialogue: "Untyped conversations: meeting transcripts, chat exports",
	tabular: "Untyped tables: CSV and spreadsheet rows",
	whole: "Untyped short pieces kept as one chunk",
	openapi: "OpenAPI / Swagger API specifications",
	prd: "Product requirement documents",
	spec: "Technical and feature specifications",
	design: "Design documents",
	readme: "README files",
	reference: "Reference documentation",
	adr: "Architecture decision records",
	decision: "Decisions logged in the project",
	note: "Notes",
	backlog: "Backlog items",
	tasks: "Task lists",
	checklist: "Checklists",
	journal: "Journals",
	changelog: "Changelogs",
	"release-notes": "Release notes",
	"meeting-series": "Recurring meeting notes",
	transcript: "Meeting transcripts",
	chat: "Chat exports",
	csv: "CSV files",
	spreadsheet: "Spreadsheets",
	knowledge: "Knowledge entries",
	other: "Typed content with no closer kind",
};

const PROBLEM_LABELS = {
	cutMidSentence: "end mid-sentence",
	cutMidListItem: "cut a list item",
	splitTables: "split a table",
	tinyChunks: "tiny (under 200 characters)",
	notEmbedded: "sources not embedded",
} as const;

function n(value: number): string {
	return value.toLocaleString();
}

function pct(value: number | null | undefined): string {
	return value === null || value === undefined
		? "–"
		: `${Math.round(value * 100)}%`;
}

interface AnalysisRow {
	contentType: string;
	current: string;
	proposed: string;
	recallBefore: number | null;
	recallAfter: number | null;
	reason: string;
}

/** A finished measure's or suggestion's rows, by content type. */
function rowsOf(
	run: { result?: unknown } | null | undefined,
): Map<string, AnalysisRow> {
	const result = (run?.result ?? null) as {
		stage?: string;
		rows?: AnalysisRow[];
	} | null;
	if (result?.stage !== "proposal" || !result.rows) {
		return new Map();
	}
	return new Map(result.rows.map((row) => [row.contentType, row]));
}

const CHOICES: Choice[] = ["custom", "auto", ...STRUCTURAL, "prose"];

/** What a row shows: its entry, or the default for a type without one. */
function choiceFor(
	entry: ChunkTypeEntry | undefined,
	chunkByContentType: boolean,
): Choice {
	if (!entry) {
		return chunkByContentType ? "auto" : "custom";
	}
	if (entry.custom || entry.standard) {
		return "custom";
	}
	return entry.profile ?? "auto";
}

function entryFor(choice: Choice, previous?: ChunkTypeEntry): ChunkTypeEntry {
	if (choice === "custom") {
		// A type's own Custom values survive a trip through another choice.
		const own = {
			splitMethod: previous?.splitMethod,
			chunkSize: previous?.chunkSize,
			chunkOverlap: previous?.chunkOverlap,
		};
		return {
			custom: true,
			...Object.fromEntries(
				Object.entries(own).filter(([, v]) => v !== undefined),
			),
		};
	}
	const sizes =
		previous && !previous.custom && !previous.standard
			? { target: previous.target, max: previous.max }
			: {};
	const kept = Object.fromEntries(
		Object.entries(sizes).filter(([, v]) => v !== undefined),
	);
	return choice === "auto" ? kept : { profile: choice, ...kept };
}

function isStructural(
	choice: Choice,
): choice is Exclude<ChunkProfile, "openapi" | "prose"> {
	return (STRUCTURAL as readonly string[]).includes(choice);
}

export function ChunkingTypesTable({
	projectId,
	organizationId,
	value,
	chunkByContentType,
	onChange,
	customDefaults,
	splitMethodOptions,
	editable = true,
	compact,
}: {
	projectId: string;
	organizationId: string | null;
	value: ChunkTypeEntries;
	/** The earlier per-project toggle: types without a row read as Auto. */
	chunkByContentType: boolean;
	onChange: (next: ChunkTypeEntries) => void;
	/** The project's values a Custom type starts from. */
	customDefaults: CustomChunkDefaults;
	splitMethodOptions: SplitMethodOption[];
	/**
	 * Off while per-type chunking is off for the organization: the figures
	 * still show (quality is for any project), the choices do not.
	 */
	editable?: boolean;
	compact?: boolean;
}) {
	const queryClient = useQueryClient();
	const [advanced, setAdvanced] = useState(false);
	const [sourcesOf, setSourcesOf] = useState<string | null>(null);
	const { data: quality } = useQuery(
		orpc.projects.ragSettings.chunkingQuality.queryOptions({
			input: { projectId },
		}),
	);
	const { data: runs } = useQuery({
		...orpc.projects.ragSettings.chunkingRuns.queryOptions({
			input: { projectId },
		}),
		refetchInterval: (query) =>
			query.state.data?.measure?.status === "RUNNING" ||
			query.state.data?.tune?.status === "RUNNING"
				? 5000
				: false,
	});
	const { data: ragSettings } = useQuery(
		orpc.projects.ragSettings.get.queryOptions({ input: { projectId } }),
	);
	const codeRow = ragSettings?.settings?.codeSearchMode === "RAG";
	const { data: codeIndex } = useQuery({
		...orpc.agents.codeIndex.status.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: codeRow,
	});
	const codeFiles =
		typeof codeIndex?.filesIndexed === "number"
			? codeIndex.filesIndexed
			: null;
	const codeChunks =
		typeof codeIndex?.chunksCreated === "number"
			? codeIndex.chunksCreated
			: null;
	const apply = useMutation(
		orpc.projects.ragSettings.applyChunkingProposal.mutationOptions({
			onSuccess: () => {
				toast.success("Settings applied; re-chunking the project");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.ragSettings.chunkingRuns.queryKey({
						input: { projectId },
					}),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.ragSettings.get.queryKey({
						input: { projectId },
					}),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const byType = new Map(
		(quality?.byType ?? []).map((row) => [row.contentType, row]),
	);
	const recall = rowsOf(runs?.measure);
	// Only a measured improvement is worth showing: a row the analysis could
	// not measure, or one that keeps the current choice, proposes nothing.
	const suggestions = new Map(
		[...rowsOf(runs?.tune)].filter(
			([, row]) =>
				row.proposed !== row.current &&
				row.recallAfter !== null &&
				(row.recallBefore === null ||
					row.recallAfter > row.recallBefore),
		),
	);
	const suggestionWaiting =
		suggestions.size > 0 &&
		runs?.tune?.kind === "TUNE" &&
		runs.tune.status === "AWAITING_APPROVAL" &&
		(runs.tune.result as { stage?: string } | null)?.stage === "proposal"
			? runs.tune.id
			: null;
	const runningAnalysis =
		runs?.measure?.status === "RUNNING"
			? "Measuring…"
			: runs?.tune?.status === "RUNNING"
				? "Working out suggestions…"
				: null;
	const failedRun = [runs?.measure, runs?.tune].find(
		(run) => run?.status === "FAILED",
	);

	// A document type with no content kind cannot carry a row; it chunks on
	// Custom with the project's values.
	const types = [...new Set([...byType.keys(), ...Object.keys(value)])]
		.filter(isChunkTypeKey)
		.sort(
			(a, b) =>
				(byType.get(b)?.sources ?? 0) - (byType.get(a)?.sources ?? 0),
		);

	const setEntry = (type: ChunkTypeKey, entry: ChunkTypeEntry) =>
		onChange({ ...value, [type]: entry });

	/** A Custom type's own value; clearing it falls back to the project's. */
	const setCustom = <K extends "splitMethod" | "chunkSize" | "chunkOverlap">(
		type: ChunkTypeKey,
		key: K,
		next: ChunkTypeEntry[K],
	) => {
		const entry: ChunkTypeEntry = { ...(value[type] ?? {}), custom: true };
		delete entry.standard;
		if (next === undefined || Number.isNaN(next)) {
			delete entry[key];
		} else {
			entry[key] = next;
		}
		setEntry(type, entry);
	};

	const setSize = (
		type: ChunkTypeKey,
		key: "target" | "max",
		raw: string,
	) => {
		const entry = value[type] ?? {};
		const number = raw === "" ? undefined : Number.parseInt(raw, 10);
		const next = { ...entry, [key]: number };
		if (next[key] === undefined || Number.isNaN(next[key])) {
			delete next[key];
		}
		setEntry(type, next);
	};

	const columns = editable ? (advanced ? 9 : 7) : 5;

	return (
		<div className="space-y-3">
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-1">
					<h4
						className={
							compact
								? "font-medium text-xs"
								: "font-medium text-sm"
						}
					>
						{editable
							? "Chunking by content type"
							: "Chunks by content type"}
					</h4>
					<p className="text-foreground/50 text-xs">
						{editable
							? ""
							: "What is in the index for each content type. "}
						Every type starts on Custom: today's chunking with this
						project's split method, size and overlap, which a type
						can change for itself. Pick a profile to split a type on
						its own structure. Saving a change re-chunks the
						project. Measure checks how often search finds the
						answer; Suggest settings proposes a better choice per
						type.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<ChunkingAnalysisActions projectId={projectId} />
					{editable && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-expanded={advanced}
							onClick={() => setAdvanced((open) => !open)}
						>
							{advanced ? "Hide sizes" : "Advanced"}
						</Button>
					)}
				</div>
			</div>

			{runningAnalysis && (
				<output className="block text-foreground/60 text-xs">
					{runningAnalysis}
				</output>
			)}
			{failedRun && (
				<p className="text-foreground/60 text-xs">
					The last analysis failed:{" "}
					{failedRun.error ?? "unknown error"}
				</p>
			)}

			{types.length === 0 && !codeRow ? (
				<p className="text-foreground/50 text-xs">
					No content in this project yet. Types appear here once
					sources are added.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-foreground/50 text-xs">
								<th className="pb-2 font-normal">Type</th>
								<th className="pb-2 font-normal">Sources</th>
								<th className="pb-2 font-normal">Chunks</th>
								<th className="pb-2 font-normal">
									Size (median / p90 / max)
								</th>
								<th className="pb-2 font-normal">Recall</th>
								{editable && (
									<>
										<th className="pb-2 font-normal">
											Chunking
										</th>
										<th className="pb-2 font-normal">
											Suggested
										</th>
									</>
								)}
								{editable && advanced && (
									<>
										<th className="pb-2 font-normal">
											Target
										</th>
										<th className="pb-2 font-normal">
											Max
										</th>
									</>
								)}
							</tr>
						</thead>
						<tbody>
							{types.map((type) => {
								const choice = choiceFor(
									value[type],
									chunkByContentType,
								);
								const sizes = isStructural(choice)
									? PROFILE_SIZES[choice]
									: null;
								const stats = byType.get(type);
								const measured = recall.get(type);
								const suggestion = suggestions.get(type);
								return [
									<tr
										key={type}
										className="border-t align-top"
									>
										<td className="py-2 pr-3">
											<div>{type}</div>
											<div className="text-foreground/50 text-xs">
												{TYPE_HINTS[type]}
											</div>
										</td>
										<td className="py-2 pr-3 tabular-nums">
											{stats && stats.sources > 0 ? (
												<button
													type="button"
													className="text-primary underline-offset-2 hover:underline"
													aria-label={`Show the ${stats.sources} sources of ${type}`}
													onClick={() =>
														setSourcesOf(type)
													}
												>
													{n(stats.sources)}
												</button>
											) : (
												0
											)}
										</td>
										<td className="py-2 pr-3 tabular-nums">
											{stats ? n(stats.chunks) : "–"}
										</td>
										<td className="py-2 pr-3 font-mono text-xs">
											{stats?.sizes
												? `${n(stats.sizes.p50)} / ${n(stats.sizes.p90)} / ${n(stats.sizes.max)}`
												: "–"}
										</td>
										<td
											className="py-2 pr-3 font-mono text-xs"
											title={measured?.reason}
										>
											{pct(measured?.recallBefore)}
										</td>
										{editable && (
											<td className="py-2 pr-3">
												<Select
													value={choice}
													onValueChange={(next) =>
														setEntry(
															type,
															entryFor(
																next as Choice,
																value[type],
															),
														)
													}
												>
													<SelectTrigger
														className="h-8 w-48"
														aria-label={`Chunking for ${type}`}
													>
														<SelectValue>
															{
																CHOICE_LABELS[
																	choice
																]
															}
														</SelectValue>
													</SelectTrigger>
													<SelectContent>
														{CHOICES.map(
															(option) => (
																<SelectItem
																	key={option}
																	value={
																		option
																	}
																>
																	{
																		CHOICE_LABELS[
																			option
																		]
																	}
																</SelectItem>
															),
														)}
													</SelectContent>
												</Select>
											</td>
										)}
										{editable && (
											<td
												className="py-2 pr-3 text-xs"
												title={suggestion?.reason}
											>
												{suggestion ? (
													<span>
														{suggestion.proposed}{" "}
														<span className="font-mono text-foreground/60">
															{pct(
																suggestion.recallBefore,
															)}{" "}
															→{" "}
															{pct(
																suggestion.recallAfter,
															)}
														</span>
													</span>
												) : (
													<span className="text-foreground/40">
														–
													</span>
												)}
											</td>
										)}
										{editable &&
											advanced &&
											(["target", "max"] as const).map(
												(key) => (
													<td
														key={key}
														className="py-2 pr-2"
													>
														{sizes ? (
															<Input
																type="number"
																className="h-8 w-24"
																aria-label={`${key === "target" ? "Target" : "Max"} size for ${type}`}
																min={
																	PROFILE_SIZE_LIMITS.minTarget
																}
																max={
																	PROFILE_SIZE_LIMITS.maxChars
																}
																placeholder={String(
																	sizes[key],
																)}
																value={
																	value[
																		type
																	]?.[key] ??
																	""
																}
																onChange={(
																	event,
																) =>
																	setSize(
																		type,
																		key,
																		event
																			.target
																			.value,
																	)
																}
															/>
														) : (
															<span className="text-foreground/40 text-xs">
																–
															</span>
														)}
													</td>
												),
											)}
									</tr>,
									editable && choice === "custom" && (
										<tr key={`${type}-custom`}>
											<td />
											<td
												colSpan={columns - 1}
												className="pb-3"
											>
												<CustomChunkFields
													type={type}
													entry={value[type]}
													defaults={customDefaults}
													options={splitMethodOptions}
													onChange={(key, next) =>
														setCustom(
															type,
															key,
															next,
														)
													}
												/>
											</td>
										</tr>
									),
								];
							})}
							{codeRow && (
								<tr className="border-t align-top">
									<td className="py-2 pr-3">
										<div>code</div>
										<div className="text-foreground/50 text-xs">
											Repository code for AI code search,
											indexed on its own (see Code search
											above)
										</div>
									</td>
									<td className="py-2 pr-3 tabular-nums">
										{codeFiles === null
											? "–"
											: n(codeFiles)}
									</td>
									<td className="py-2 pr-3 tabular-nums">
										{codeChunks === null
											? "–"
											: n(codeChunks)}
									</td>
									<td className="py-2 pr-3">–</td>
									<td className="py-2 pr-3">–</td>
									{editable && (
										<>
											<td className="py-2 pr-3 text-foreground/70 text-xs">
												Functions and classes for
												TypeScript, JavaScript, Python,
												Rust, Go and Java; line blocks
												for every other language
											</td>
											<td
												className="py-2 pr-3"
												colSpan={columns - 6}
											/>
										</>
									)}
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}

			{quality && (
				<p className="text-foreground/50 text-xs">
					Problems found:{" "}
					{(
						Object.keys(PROBLEM_LABELS) as Array<
							keyof typeof PROBLEM_LABELS
						>
					)
						.map(
							(key) =>
								`${n(quality.problems[key])} ${PROBLEM_LABELS[key]}`,
						)
						.join(" · ")}
					{quality.problems.truncatedKnowledge.entries > 0
						? ` · ${n(quality.problems.truncatedKnowledge.entries)} knowledge entries cut at 24,000 characters`
						: ""}
					{quality.truncated
						? " · large index: figures are from the first 20,000 chunks"
						: ""}
				</p>
			)}

			{/* The server checks the permission to change settings. */}
			{editable && suggestionWaiting && (
				<Button
					type="button"
					size="sm"
					disabled={apply.isPending}
					onClick={() =>
						apply.mutate({ projectId, runId: suggestionWaiting })
					}
				>
					Apply suggestions and re-chunk
				</Button>
			)}

			<SourcesDialog
				projectId={projectId}
				contentType={sourcesOf}
				onClose={() => setSourcesOf(null)}
			/>
		</div>
	);
}

/** A Custom type's own split method, size and overlap; empty = the project's. */
function CustomChunkFields({
	type,
	entry,
	defaults,
	options,
	onChange,
}: {
	type: string;
	entry: ChunkTypeEntry | undefined;
	defaults: CustomChunkDefaults;
	options: SplitMethodOption[];
	onChange: <K extends "splitMethod" | "chunkSize" | "chunkOverlap">(
		key: K,
		next: ChunkTypeEntry[K],
	) => void;
}) {
	const labelFor = (method: CustomSplitMethod) =>
		options.find((o) => o.value === method)?.label ?? method;
	const number = (raw: string) =>
		raw === "" ? undefined : Number.parseInt(raw, 10);
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs">
			<Select
				value={entry?.splitMethod ?? "__project__"}
				onValueChange={(next) =>
					onChange(
						"splitMethod",
						next === "__project__"
							? undefined
							: (next as CustomSplitMethod),
					)
				}
			>
				<SelectTrigger
					className="h-8 w-48"
					aria-label={`Split method for ${type}`}
				>
					<SelectValue>
						{entry?.splitMethod
							? labelFor(entry.splitMethod)
							: `${labelFor(defaults.splitMethod)} (project)`}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__project__">
						{labelFor(defaults.splitMethod)} (project)
					</SelectItem>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Input
				type="number"
				className="h-8 w-28"
				aria-label={`Chunk size for ${type}`}
				min={CUSTOM_CHUNK_LIMITS.minSize}
				max={CUSTOM_CHUNK_LIMITS.maxSize}
				step={100}
				placeholder={`${defaults.chunkSize} size`}
				value={entry?.chunkSize ?? ""}
				onChange={(event) =>
					onChange("chunkSize", number(event.target.value))
				}
			/>
			<Input
				type="number"
				className="h-8 w-28"
				aria-label={`Chunk overlap for ${type}`}
				min={0}
				max={CUSTOM_CHUNK_LIMITS.maxOverlap}
				step={50}
				placeholder={`${defaults.chunkOverlap} overlap`}
				value={entry?.chunkOverlap ?? ""}
				onChange={(event) =>
					onChange("chunkOverlap", number(event.target.value))
				}
			/>
			<span className="text-foreground/50">
				chars · empty uses the project's value
			</span>
		</div>
	);
}

const SOURCES_PAGE = 25;

/** The sources one type counts, a page at a time. */
function SourcesDialog({
	projectId,
	contentType,
	onClose,
}: {
	projectId: string;
	contentType: string | null;
	onClose: () => void;
}) {
	const [offset, setOffset] = useState(0);
	const { data, isLoading, isError } = useQuery({
		...orpc.projects.ragSettings.chunkingSources.queryOptions({
			input: {
				projectId,
				contentType: contentType ?? "",
				offset,
				limit: SOURCES_PAGE,
			},
		}),
		enabled: contentType !== null,
	});
	const total = data?.total ?? 0;
	const last = Math.min(offset + SOURCES_PAGE, total);
	const hint =
		contentType && isChunkTypeKey(contentType)
			? TYPE_HINTS[contentType]
			: "Sources of this type";

	return (
		<Dialog
			open={contentType !== null}
			onOpenChange={(open) => {
				if (!open) {
					setOffset(0);
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Sources chunked as {contentType}</DialogTitle>
					<DialogDescription>{hint}</DialogDescription>
				</DialogHeader>
				{isLoading && (
					<div className="h-24 animate-pulse rounded-lg bg-foreground/5" />
				)}
				{isError && (
					<p className="text-foreground/60 text-sm">
						The sources could not be read right now.
					</p>
				)}
				{data && (
					<div className="max-h-[60vh] overflow-auto">
						<table className="w-full text-left text-sm">
							<thead className="text-foreground/50 text-xs">
								<tr>
									<th className="py-1 pr-3 font-normal">
										Source
									</th>
									<th className="py-1 pr-3 font-normal">
										From
									</th>
									<th className="py-1 pr-3 font-normal">
										Characters
									</th>
									<th className="py-1 pr-3 font-normal">
										Chunks
									</th>
									<th className="py-1 font-normal">
										Chunked by
									</th>
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row) => (
									<tr
										key={row.id}
										className="border-foreground/5 border-t"
									>
										<td className="max-w-xs py-1.5 pr-3">
											<div
												className="truncate"
												title={row.title}
											>
												{row.title}
											</div>
											{row.location &&
												row.location !== row.title && (
													<div
														className="truncate text-foreground/50 text-xs"
														title={row.location}
													>
														{row.location}
													</div>
												)}
										</td>
										<td className="py-1.5 pr-3 text-xs">
											{row.origin === "document"
												? "Document"
												: "Context"}
										</td>
										<td className="py-1.5 pr-3 tabular-nums">
											{n(row.characters)}
										</td>
										<td className="py-1.5 pr-3 tabular-nums">
											{row.embedded
												? n(row.chunks)
												: "not embedded"}
										</td>
										<td className="py-1.5 text-xs">
											{row.chunkedBy
												.map((p) =>
													p === "setting"
														? "project setting"
														: p,
												)
												.join(", ") || "–"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{total > SOURCES_PAGE && (
					<div className="flex items-center justify-between text-xs">
						<span className="text-foreground/60">
							{n(offset + 1)}–{n(last)} of {n(total)}
						</span>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={offset === 0}
								onClick={() =>
									setOffset(
										Math.max(0, offset - SOURCES_PAGE),
									)
								}
							>
								Previous
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={last >= total}
								onClick={() => setOffset(offset + SOURCES_PAGE)}
							>
								Next
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
