"use client";

/**
 * The repository import on the project overview
 * (specs/2026-10-23-repository-import §3): the checklist while Fabric reads
 * the repository, the proposal to review, and afterwards a short guide to
 * where each kind of work lives from now on (§3a).
 *
 * Shows nothing for a project that was never imported.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleIcon,
	Loader2Icon,
	MinusCircleIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type Destination =
	| "document"
	| "context"
	| "decision"
	| "backlog"
	| "knowledge"
	| "skip";

type Step = {
	key: string;
	status: "PENDING" | "RUNNING" | "DONE" | "SKIPPED" | "FAILED";
	detail?: string;
};

type DocumentFinding = {
	path: string;
	title: string;
	kind: string;
	documentType?: string;
	reason: string;
	destination: Destination;
	itemCount?: number;
};

type Findings = {
	repository: { name: string; branch: string; url: string };
	profile: { fileCount: number; documentCount: number; kind: string };
	stack: { name: string; category: string; evidence: string[] }[];
	summary: {
		description: string;
		goals: string;
		features: string[];
		generated: boolean;
	};
	documents: DocumentFinding[];
	aiFileCount: number;
	contextSyncConfigured: boolean;
	/** The separate repository the coding instructions sync from. */
	instructionsRepository?: string | null;
	applied?: {
		projectFields: boolean;
		documents: number;
		contextPaths: number;
		contextSynced: boolean;
		contexts: number;
		decisions: number;
		backlogProposals: number;
		backlogItems: number;
		knowledge: number;
		failed: number;
	};
};

const STEP_LABELS: Record<string, string> = {
	connect: "Connect the repository",
	structure: "Read the structure",
	stack: "Stack and dependencies",
	code: "Analyse the code",
	docs: "Find documentation",
	classify: "Classify by content",
	summary: "Summarise the project",
	documents: "Documents",
	context: "Context",
	decisions: "Decisions",
	backlog: "Backlog",
	knowledge: "Knowledge",
	instructions: "Coding instructions",
	review: "Review and create",
};

const DESTINATIONS: { value: Destination; label: string }[] = [
	{ value: "document", label: "Document" },
	{ value: "context", label: "Context" },
	{ value: "decision", label: "Decision" },
	{ value: "backlog", label: "Backlog" },
	{ value: "knowledge", label: "Knowledge" },
	{ value: "skip", label: "Skip" },
];

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
	PRD: "Product requirements",
	ARCHITECTURE: "Architecture",
	TECHNICAL_SPEC: "Technical specification",
	DESIGN_SYSTEM: "Design system",
};

const GROUP_TITLES: Record<Destination, string> = {
	document: "Fabric documents",
	context: "Context",
	decision: "Decisions",
	backlog: "Backlog, for review",
	knowledge: "Knowledge",
	skip: "Skipped",
};

function dismissKey(projectId: string, runId: string) {
	return `fabric-import-guide-dismissed-${projectId}-${runId}`;
}

function StepIcon({ status }: { status: Step["status"] }) {
	switch (status) {
		case "RUNNING":
			return (
				<Loader2Icon
					className="size-4 text-primary motion-safe:animate-spin"
					aria-hidden="true"
				/>
			);
		case "DONE":
			return (
				<CheckCircle2Icon
					className="size-4 text-emerald-600"
					aria-hidden="true"
				/>
			);
		case "SKIPPED":
			return (
				<MinusCircleIcon
					className="size-4 text-muted-foreground"
					aria-hidden="true"
				/>
			);
		case "FAILED":
			return (
				<AlertCircleIcon
					className="size-4 text-destructive"
					aria-hidden="true"
				/>
			);
		default:
			return (
				<CircleIcon
					className="size-4 text-muted-foreground/50"
					aria-hidden="true"
				/>
			);
	}
}

function DestinationSelect({
	value,
	onChange,
	label,
	disabled,
}: {
	value: Destination | "mixed";
	onChange: (next: Destination) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<select
			aria-label={label}
			className="h-7 rounded-md border bg-background px-1.5 text-xs"
			value={value}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value as Destination)}
		>
			{value === "mixed" ? <option value="mixed">Mixed</option> : null}
			{DESTINATIONS.map((d) => (
				<option key={d.value} value={d.value}>
					{d.label}
				</option>
			))}
		</select>
	);
}

function folderOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "(root)" : path.slice(0, i);
}

/** The person's choice per path, grouped for review: destination → folder → files. */
function groupForReview(
	documents: DocumentFinding[],
	chosen: Record<string, Destination>,
) {
	const groups = new Map<Destination, Map<string, DocumentFinding[]>>();
	for (const doc of documents) {
		const destination = chosen[doc.path] ?? doc.destination;
		const folders = groups.get(destination) ?? new Map();
		const folder = folderOf(doc.path);
		folders.set(folder, [...(folders.get(folder) ?? []), doc]);
		groups.set(destination, folders);
	}
	return groups;
}

function ReviewFolder({
	folder,
	files,
	chosen,
	setDestination,
	disabled,
}: {
	folder: string;
	files: DocumentFinding[];
	chosen: Record<string, Destination>;
	setDestination: (paths: string[], next: Destination) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const values = new Set(files.map((f) => chosen[f.path] ?? f.destination));
	const items = files.reduce((n, f) => n + (f.itemCount ?? 0), 0);
	const only = files.length === 1 ? files[0] : null;
	return (
		<li className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-2">
				<button
					type="button"
					className="flex min-w-0 items-center gap-1 text-left text-sm"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					{open ? (
						<ChevronDownIcon
							className="size-3.5 shrink-0"
							aria-hidden="true"
						/>
					) : (
						<ChevronRightIcon
							className="size-3.5 shrink-0"
							aria-hidden="true"
						/>
					)}
					<span className="truncate">
						{only ? only.title : folder}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						{only ? only.path : `${files.length} files`}
						{only?.documentType &&
						(chosen[only.path] ?? only.destination) === "document"
							? ` · ${DOCUMENT_TYPE_LABELS[only.documentType] ?? only.documentType}`
							: ""}
						{items > 0 ? ` · ${items} open items` : ""}
					</span>
				</button>
				<DestinationSelect
					label={`Where ${only ? only.path : folder} goes`}
					value={
						values.size === 1
							? ([...values][0] ?? "context")
							: "mixed"
					}
					disabled={disabled}
					onChange={(next) =>
						setDestination(
							files.map((f) => f.path),
							next,
						)
					}
				/>
			</div>
			{open ? (
				<ul className="ml-5 flex flex-col gap-1 border-l pl-3">
					{files.map((file) => (
						<li
							key={file.path}
							className="flex items-center justify-between gap-2"
						>
							<span className="min-w-0 truncate text-xs">
								{file.title}{" "}
								<span className="text-muted-foreground">
									{file.path} · {file.reason}
								</span>
							</span>
							<DestinationSelect
								label={`Where ${file.path} goes`}
								value={chosen[file.path] ?? file.destination}
								disabled={disabled}
								onChange={(next) =>
									setDestination([file.path], next)
								}
							/>
						</li>
					))}
				</ul>
			) : null}
		</li>
	);
}

function Guide({
	findings,
	projectsHref,
	onDismiss,
}: {
	findings: Findings;
	projectsHref: string;
	onDismiss: () => void;
}) {
	const applied = findings.applied;
	if (!applied) {
		return null;
	}
	// Where most of the open work was kept: the files to stop adding to.
	const backlogSources = findings.documents
		.filter((d) => d.destination === "backlog")
		.sort((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0))
		.slice(0, 2)
		.map((d) => d.path);
	const lines: { what: string; where: string; habit: string }[] = [];
	if (applied.backlogItems > 0) {
		lines.push({
			what: "Backlog",
			where: "Fabric Roadmap",
			habit: `${applied.backlogItems} open items wait for your approval in the inbox. Add new features and bugs in Fabric${backlogSources.length > 0 ? `, not in ${backlogSources.join(" or ")}` : ""}.`,
		});
	}
	if (applied.documents > 0) {
		lines.push({
			what: "Product documents",
			where: "Fabric Documents",
			habit: "Edit them in Fabric; the copies in the repository are no longer the source.",
		});
	}
	if (applied.contextSynced) {
		lines.push({
			what: "Reference docs",
			where: "The repository, synced to Fabric context",
			habit: "Keep writing them in the repository; sync again from Living Memory after changes.",
		});
	} else if (applied.contexts > 0) {
		lines.push({
			what: "Reference docs",
			where: "Fabric context (copied once)",
			habit: "Add new reference material in Fabric's Context tab.",
		});
	}
	if (applied.decisions > 0) {
		lines.push({
			what: "Decisions",
			where: "Fabric Decisions",
			habit: "Record new architecture decisions in Fabric.",
		});
	}
	lines.push({
		what: "Notes, specs and plans from AI tools",
		where: "Fabric Knowledge",
		habit: "Ask your AI tool to save them to Fabric (its fabric-knowledge skill), not as files in the repository.",
	});
	// Instructions synced from their own repository: nothing to move.
	const movableAiFiles = findings.instructionsRepository
		? 0
		: findings.aiFileCount;
	if (findings.instructionsRepository) {
		lines.push({
			what: "Coding instructions, skills, agents",
			where: `${findings.instructionsRepository}, changed through Fabric`,
			habit: "Change rules by asking your AI tool, never by editing files.",
		});
	}
	if (movableAiFiles > 0) {
		lines.push({
			what: "Coding instructions, skills, agents",
			where: "The instructions repository, changed through Fabric",
			habit: "Move the AI files out of the code repository once; then change rules by asking your AI tool, never by editing files.",
		});
	}
	lines.push({
		what: "Your coding tool",
		where: "Connect your agent (plugin + MCP)",
		habit: "One command per machine; the code repository then holds only software.",
	});
	return (
		<section
			aria-labelledby="import-guide-title"
			className="app-surface rounded-xl px-5 py-4 sm:px-6"
		>
			<div className="flex items-start justify-between gap-2">
				<div>
					<p id="import-guide-title" className="font-medium text-sm">
						How to work from now on
					</p>
					<p className="text-muted-foreground text-xs">
						Imported from {findings.repository.name}
						{applied.failed > 0
							? ` · ${applied.failed} items could not be created`
							: ""}
					</p>
				</div>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					aria-label="Dismiss the guide"
					onClick={onDismiss}
				>
					<XIcon className="size-4" aria-hidden="true" />
				</Button>
			</div>
			<dl className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
				{lines.map((line) => (
					<div key={line.what} className="contents">
						<dt className="font-medium text-sm">{line.what}</dt>
						<dd className="text-sm">
							<span className="text-foreground">
								{line.where}.
							</span>{" "}
							<span className="text-muted-foreground">
								{line.habit}
							</span>
						</dd>
					</div>
				))}
			</dl>
			{movableAiFiles > 0 ? (
				<Button asChild size="sm" variant="outline" className="mt-3">
					<Link
						href={`${projectsHref}?tab=coding-instructions&consolidate=1`}
					>
						Move {movableAiFiles} AI files out
					</Link>
				</Button>
			) : null}
		</section>
	);
}

export function RepositoryImportPanel({
	projectId,
	organizationId,
	onApplied,
}: {
	projectId: string;
	organizationId?: string | null;
	onApplied?: () => void;
}) {
	const id = useId();
	const { basePath } = useOrganizationContext();
	const projectsHref = `${basePath}/projects/${projectId}`;
	const queryClient = useQueryClient();
	const query = useQuery({
		...orpc.projects.repositoryImport.get.queryOptions({
			input: { projectId, organizationId },
		}),
		refetchInterval: (q) => {
			const status = q.state.data?.run?.status;
			return status === "RUNNING" || status === "APPLYING" ? 3000 : false;
		},
	});
	const run = query.data?.run ?? null;
	const findings = (run?.findings ?? null) as Findings | null;
	const apply = useMutation(
		orpc.projects.repositoryImport.apply.mutationOptions(),
	);
	const restart = useMutation(
		orpc.projects.repositoryImport.start.mutationOptions(),
	);
	const [chosen, setChosen] = useState<Record<string, Destination>>({});
	const [fields, setFields] = useState({
		description: true,
		goals: true,
		techStack: true,
		features: true,
	});
	const [stepsOpen, setStepsOpen] = useState(true);
	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		if (!run) {
			return;
		}
		try {
			setDismissed(
				window.localStorage.getItem(dismissKey(projectId, run.id)) ===
					"1",
			);
		} catch {
			// Storage can be unavailable; the guide stays.
		}
	}, [projectId, run]);

	// Once applied, the project's fields and counts changed: refresh them,
	// when this page saw the apply finish (not on every visit afterwards).
	const status = run?.status;
	const previous = useRef(status);
	useEffect(() => {
		if (status === "COMPLETED" && previous.current === "APPLYING") {
			onApplied?.();
		}
		previous.current = status;
	}, [status, onApplied]);

	const groups = useMemo(
		() => (findings ? groupForReview(findings.documents, chosen) : null),
		[findings, chosen],
	);

	if (!run) {
		return null;
	}
	const steps = run.steps as Step[];
	const busy = run.status === "RUNNING" || run.status === "APPLYING";
	const doneCount = steps.filter(
		(s) => s.status === "DONE" || s.status === "SKIPPED",
	).length;

	const setDestination = (paths: string[], next: Destination) =>
		setChosen((current) => {
			const copy = { ...current };
			for (const path of paths) {
				copy[path] = next;
			}
			return copy;
		});

	async function submit() {
		if (!run || !findings) {
			return;
		}
		try {
			await apply.mutateAsync({
				projectId,
				organizationId,
				runId: run.id,
				selection: {
					projectFields: fields,
					documents: findings.documents.map((d) => ({
						path: d.path,
						destination: chosen[d.path] ?? d.destination,
					})),
				},
			});
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.repositoryImport.get.key(),
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The import could not be applied.",
			);
		}
	}

	async function startAgain() {
		try {
			await restart.mutateAsync({ projectId, organizationId });
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.repositoryImport.get.key(),
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The import could not start.",
			);
		}
	}

	if (run.status === "COMPLETED" && findings?.applied) {
		return dismissed ? null : (
			<Guide
				findings={findings}
				projectsHref={projectsHref}
				onDismiss={() => {
					setDismissed(true);
					try {
						window.localStorage.setItem(
							dismissKey(projectId, run.id),
							"1",
						);
					} catch {
						// Storage can be unavailable; dismissed for now.
					}
				}}
			/>
		);
	}

	return (
		<section
			aria-labelledby={`${id}-title`}
			className="app-surface flex flex-col gap-4 rounded-xl px-5 py-4 sm:px-6"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p id={`${id}-title`} className="font-medium text-sm">
						Importing{" "}
						{findings?.repository.name ?? "the repository"}
					</p>
					<p
						className="text-muted-foreground text-xs"
						aria-live="polite"
					>
						{run.status === "REVIEW"
							? "Review what Fabric found, then create it."
							: run.status === "APPLYING"
								? "Creating what you kept…"
								: run.status === "FAILED"
									? (run.error ?? "The import stopped.")
									: `${doneCount} of ${steps.length} steps done`}
					</p>
				</div>
				<div className="flex items-center gap-2">
					{run.status === "FAILED" ? (
						<Button
							type="button"
							size="sm"
							disabled={restart.isPending}
							onClick={() => void startAgain()}
						>
							Try again
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						aria-expanded={stepsOpen}
						aria-controls={`${id}-steps`}
						onClick={() => setStepsOpen((o) => !o)}
					>
						{stepsOpen ? "Hide steps" : "Show steps"}
					</Button>
				</div>
			</div>

			{stepsOpen ? (
				<ol id={`${id}-steps`} className="flex flex-col gap-1.5">
					{steps.map((s) => (
						<li key={s.key} className="flex items-start gap-2">
							<span className="mt-0.5">
								<StepIcon status={s.status} />
							</span>
							<span className="min-w-0 text-sm">
								<span
									className={
										s.status === "PENDING"
											? "text-muted-foreground"
											: "text-foreground"
									}
								>
									{STEP_LABELS[s.key] ?? s.key}
								</span>
								{s.detail ? (
									<span className="block text-muted-foreground text-xs">
										{s.detail}
									</span>
								) : null}
							</span>
							<span className="sr-only">
								{s.status.toLowerCase()}
							</span>
						</li>
					))}
				</ol>
			) : null}

			{run.status === "REVIEW" && findings && groups ? (
				<div className="flex flex-col gap-4 border-t pt-4">
					<fieldset className="flex flex-col gap-2">
						<legend className="font-medium text-sm">
							Project details
						</legend>
						{findings.summary.description ? (
							<label
								htmlFor={`${id}-description`}
								className="flex items-start gap-2 text-sm"
							>
								<Checkbox
									id={`${id}-description`}
									checked={fields.description}
									onCheckedChange={(c) =>
										setFields((f) => ({
											...f,
											description: c === true,
										}))
									}
								/>
								<span>
									<span className="font-medium">
										Description
									</span>
									<span className="block text-muted-foreground">
										{findings.summary.description}
									</span>
								</span>
							</label>
						) : null}
						{findings.summary.goals ? (
							<label
								htmlFor={`${id}-goals`}
								className="flex items-start gap-2 text-sm"
							>
								<Checkbox
									id={`${id}-goals`}
									checked={fields.goals}
									onCheckedChange={(c) =>
										setFields((f) => ({
											...f,
											goals: c === true,
										}))
									}
								/>
								<span>
									<span className="font-medium">Goals</span>
									<span className="block text-muted-foreground">
										{findings.summary.goals}
									</span>
								</span>
							</label>
						) : null}
						{findings.stack.length > 0 ? (
							<label
								htmlFor={`${id}-techStack`}
								className="flex items-start gap-2 text-sm"
							>
								<Checkbox
									id={`${id}-techStack`}
									checked={fields.techStack}
									onCheckedChange={(c) =>
										setFields((f) => ({
											...f,
											techStack: c === true,
										}))
									}
								/>
								<span className="flex flex-col gap-1">
									<span className="font-medium">
										Tech stack ({findings.stack.length})
									</span>
									<span className="flex flex-wrap gap-1">
										{findings.stack.map((t) => (
											<Badge
												key={t.name}
												status="secondary"
												title={`${t.category}: ${t.evidence.join(", ")}`}
											>
												{t.name}
											</Badge>
										))}
									</span>
								</span>
							</label>
						) : null}
						{findings.summary.features.length > 0 ? (
							<label
								htmlFor={`${id}-features`}
								className="flex items-start gap-2 text-sm"
							>
								<Checkbox
									id={`${id}-features`}
									checked={fields.features}
									onCheckedChange={(c) =>
										setFields((f) => ({
											...f,
											features: c === true,
										}))
									}
								/>
								<span>
									<span className="font-medium">
										Features (
										{findings.summary.features.length})
									</span>
									<span className="block text-muted-foreground">
										{findings.summary.features.join(" · ")}
									</span>
								</span>
							</label>
						) : null}
					</fieldset>

					{DESTINATIONS.map(({ value }) => {
						const folders = groups.get(value);
						if (!folders || folders.size === 0) {
							return null;
						}
						const fileCount = [...folders.values()].reduce(
							(n, f) => n + f.length,
							0,
						);
						return (
							<div key={value} className="flex flex-col gap-1.5">
								<p className="font-medium text-sm">
									{GROUP_TITLES[value]}{" "}
									<span className="text-muted-foreground text-xs">
										{fileCount} files
										{value === "context"
											? findings.contextSyncConfigured
												? " · copied once"
												: " · synced from the repository"
											: ""}
									</span>
								</p>
								<ul className="flex flex-col gap-1.5">
									{[...folders.entries()]
										.sort(
											(a, b) => b[1].length - a[1].length,
										)
										.map(([folder, files]) => (
											<ReviewFolder
												key={folder}
												folder={folder}
												files={files}
												chosen={chosen}
												setDestination={setDestination}
												disabled={apply.isPending}
											/>
										))}
								</ul>
							</div>
						);
					})}

					<div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
						<p className="mr-auto text-muted-foreground text-xs">
							Backlog items arrive as proposals you approve in the
							inbox. Nothing in the repository changes.
						</p>
						<Button
							type="button"
							disabled={apply.isPending || busy}
							onClick={() => void submit()}
						>
							{apply.isPending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							Create in Fabric
						</Button>
					</div>
				</div>
			) : null}
		</section>
	);
}
