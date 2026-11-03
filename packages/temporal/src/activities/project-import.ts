/**
 * Importing a project from its repository (specs/2026-10-23-repository-import):
 * the analysis that reads the whole repository and proposes what Fabric
 * should hold, and the apply that creates what the person kept. The
 * activities barrel re-exports this module, so EVERY export here is a
 * schedulable activity; the helpers stay unexported.
 *
 * The run's row (`ProjectImportRun`) is the only state: the analysis
 * records each checklist step as it goes and leaves its findings on the
 * row; the apply reads them back with the person's selection. Both are
 * idempotent: the analysis only rewrites the row, and the apply keys every
 * row it creates by repository path, so a retry finds what a first attempt
 * already made.
 *
 * Isolation (spec §2.7): everything is created through Fabric's existing
 * create paths. The one existing configuration it may touch, the project's
 * Living Memory repository sync, it only creates when the project has none.
 */
import { generateText, getAIModelWithMetadata } from "@repo/ai";
import { isManifestPath, parseTechStack } from "@repo/atlas";
import {
	listRepositoryTree,
	type RepositoryTreeEntry,
	readRepositoryFile,
} from "@repo/connectors";
import {
	addKnowledgeEntry,
	createArchitectureDecision,
	createContext,
	createPendingBacklogProposal,
	db,
	getContextRepositorySync,
	getInstructionRepositorySync,
	getProjectImportRun,
	getProjectRepoIntegration,
	type ProjectImportAppliedCounts,
	type ProjectImportDestination,
	type ProjectImportDocumentFinding,
	type ProjectImportFindings,
	type ProjectImportSelection,
	type ProjectImportStepKey,
	type ProjectImportStepStatus,
	recordAudit,
	updateProjectImportRun,
	updateProjectImportStep,
	upsertContextRepositorySync,
} from "@repo/database";
import {
	centralPackageNames,
	classifyRepositoryDocument,
	contextSyncPaths,
	detectRepositoryStack,
	dotnetRuntimes,
	extractBacklogItems,
	extractDecision,
	infrastructureResourceTypes,
	isInfrastructureFile,
	planConsolidation,
	type RepoDocClassification,
	repositoryDocumentPaths,
	repositoryProfile,
	type StackPackage,
	sectionText,
} from "@repo/instructions";
import { resolveFreshRepoToken } from "@repo/integrations";
import { logger } from "@repo/logs";
import { embedKnowledgeEntry } from "@repo/rag/lib/knowledge/embed";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { getTemporalClient } from "../client";
import { startContextEmbeddingWorkflow } from "../lib/context-embedding-start";
import { startKnowledgeTopicSummaryWorkflow } from "../lib/knowledge-summary-start";
import { createImportedDocument } from "./project-document-generation";

export type ProjectImportWorkflowInput = {
	runId: string;
	projectId: string;
	organizationId: string;
	userId: string;
};

const MAX_DOCUMENTS = 1500;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_MANIFESTS = 80;
const MAX_INFRASTRUCTURE_FILES = 40;
const READ_CONCURRENCY = 8;
const CONTEXT_SYNC_PATH_LIMIT = 200;
const CONTEXT_SYNC_EXCLUDED_LIMIT = 400;
const SUMMARY_INPUT_CHARS = 24_000;

const NEVER_READ =
	/(^|\/)(node_modules|vendor|dist|build|out|\.git|coverage|bin|obj|\.next|examples?|samples?)\//i;

type Repository = {
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	token: string;
	repositoryUrl: string;
	owner: string;
	repo: string;
	azureOrganization: string | null;
	branch: string;
};

async function openRepository(
	input: ProjectImportWorkflowInput,
	repositoryIntegrationId: string,
): Promise<Repository> {
	const integration = await getProjectRepoIntegration(
		repositoryIntegrationId,
		input.projectId,
	);
	if (!integration) {
		throw ApplicationFailure.nonRetryable(
			"The repository is no longer connected to the project.",
			"IMPORT_REPOSITORY_GONE",
		);
	}
	const resolved = await resolveFreshRepoToken({
		integrationId: integration.id,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!resolved.token) {
		throw ApplicationFailure.nonRetryable(
			"The repository's credential is missing or expired. Reconnect it in the project's integrations.",
			"IMPORT_AUTHENTICATION_FAILED",
		);
	}
	return {
		provider: integration.provider as Repository["provider"],
		token: resolved.token,
		repositoryUrl: integration.repositoryUrl,
		owner: integration.repositoryOwner,
		repo: integration.repositoryName,
		azureOrganization: integration.azureOrganization ?? null,
		branch: integration.defaultBranch,
	};
}

async function readText(
	repository: Repository,
	path: string,
): Promise<string | null> {
	const result = await readRepositoryFile({
		...repository,
		path,
		maxBytes: MAX_DOCUMENT_BYTES,
	});
	return result.ok && result.state === "found"
		? Buffer.from(result.bytes).toString("utf8").replace(/^﻿/, "")
		: null;
}

/** Reads many files a few at a time, heartbeating so a long read is not mistaken for a hung one. */
async function readMany(
	repository: Repository,
	paths: readonly string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let next = 0;
	const worker = async () => {
		while (next < paths.length) {
			const path = paths[next++];
			if (path === undefined) {
				return;
			}
			const text = await readText(repository, path);
			if (text !== null) {
				out.set(path, text);
			}
			Context.current().heartbeat({ read: out.size });
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(READ_CONCURRENCY, paths.length) },
			worker,
		),
	);
	return out;
}

async function step(
	input: ProjectImportWorkflowInput,
	key: ProjectImportStepKey,
	status: ProjectImportStepStatus,
	detail?: string,
): Promise<void> {
	await updateProjectImportStep(input.runId, input.projectId, key, {
		status,
		...(detail !== undefined ? { detail } : {}),
	});
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Proposed destinations: the best-scoring document per type stays a document, the rest become context. */
function proposeDestinations(
	classified: (RepoDocClassification & { bytes: number; text: string })[],
): ProjectImportDocumentFinding[] {
	const bestPerType = new Map<string, RepoDocClassification>();
	for (const doc of classified) {
		if (doc.kind !== "document" || !doc.documentType) {
			continue;
		}
		const current = bestPerType.get(doc.documentType);
		// A tool's working folder (".planning/", ".github/") holds drafts
		// about the repository, not the product's own documents.
		const hidden = (path: string) => /(^|\/)\./.test(path);
		const score = (d: RepoDocClassification) =>
			d.confidence - (hidden(d.path) ? 0.3 : 0);
		if (
			!current ||
			score(doc) > score(current) ||
			(score(doc) === score(current) &&
				doc.path.split("/").length < current.path.split("/").length)
		) {
			bestPerType.set(doc.documentType, doc);
		}
	}
	return classified.map((doc) => {
		let destination: ProjectImportDestination;
		let itemCount: number | undefined;
		switch (doc.kind) {
			case "document":
				destination =
					doc.documentType &&
					bestPerType.get(doc.documentType)?.path === doc.path
						? "document"
						: "context";
				break;
			case "decision":
				destination = extractDecision(doc) ? "decision" : "context";
				break;
			case "backlog":
				itemCount = extractBacklogItems(doc).length;
				destination = itemCount > 0 ? "backlog" : "context";
				break;
			case "knowledge":
				destination = "knowledge";
				break;
			case "skip":
				destination = "skip";
				break;
			default:
				destination = "context";
		}
		return {
			path: doc.path,
			title: doc.title,
			kind: doc.kind,
			...(doc.documentType ? { documentType: doc.documentType } : {}),
			confidence: doc.confidence,
			reason: doc.reason,
			bytes: doc.bytes,
			destination,
			...(itemCount !== undefined ? { itemCount } : {}),
		};
	});
}

/** The README's opening prose: the description when no model is available. */
function openingProse(text: string): string {
	const parts: string[] = [];
	for (const raw of text.split(/\r?\n\s*\r?\n/)) {
		const block = raw.trim();
		if (
			block === "" ||
			/^(#|```|\||\[!|<|!\[)/.test(block) ||
			block.length < 40
		) {
			if (parts.length > 0 && block.startsWith("#")) {
				break;
			}
			continue;
		}
		parts.push(
			block
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/[*_`]+/g, "")
				.replace(/\s+/g, " "),
		);
		if (parts.join(" ").length > 700) {
			break;
		}
	}
	return parts.join("\n\n");
}

function bulletList(section: string | null, limit: number): string[] {
	if (!section) {
		return [];
	}
	return [...section.matchAll(/^\s*[-*]\s+(.+)$/gm)]
		.map((m) =>
			(m[1] ?? "")
				.replace(/\*\*|__|`/g, "")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.trim(),
		)
		.filter((line) => line.length > 2 && line.length <= 160)
		.slice(0, limit);
}

const SUMMARY_PROMPT = `You summarise a software project for a delivery platform from its repository: the documents that describe it and the technologies it is built with.
Answer as JSON only: {"description": string, "goals": string, "features": string[]}.
description: 3-6 sentences of plain prose: what the product is and who it is for, its main capabilities, how it is built.
goals: 2-4 sentences on what the product sets out to achieve, or "" when the input does not say.
features: up to 12 short names of user-facing capabilities the documents describe.
Use only facts present in the input; never invent features, customers or numbers. No markdown.`;

async function summarise(input: {
	workflow: ProjectImportWorkflowInput;
	name: string;
	readme: string | null;
	sources: { path: string; text: string }[];
	stack: string[];
}): Promise<ProjectImportFindings["summary"]> {
	// Without a model: the README's opening, and when that is thin the
	// overview of the product's own documents (a specification, a mission).
	const readmeProse = input.readme ? openingProse(input.readme) : "";
	const overview =
		input.sources
			.map((s) =>
				openingProse(
					sectionText(
						s.text,
						"overview",
						"introduction",
						"summary",
						"about",
					) ?? s.text,
				),
			)
			.find((text) => text.length > 0) ?? "";
	const fallback: ProjectImportFindings["summary"] = {
		description:
			readmeProse.length >= 200 || !overview
				? readmeProse
				: [readmeProse, overview].filter(Boolean).join("\n\n"),
		goals:
			input.sources
				.map((s) =>
					sectionText(
						s.text,
						"goals",
						"vision",
						"mission",
						"principles",
					),
				)
				.find((text): text is string => !!text)
				?.replace(/^#{1,6}\s+/gm, "")
				.replace(/\*\*|__|`/g, "")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.split(/\n\s*\n/)
				.slice(0, 3)
				.join("\n\n")
				.trim()
				.slice(0, 900) ?? "",
		features: [
			...new Set(
				[
					input.readme ?? "",
					...input.sources.map((s) => s.text),
				].flatMap((text) =>
					bulletList(
						sectionText(text, "features", "capabilities"),
						12,
					),
				),
			),
		].slice(0, 12),
		generated: false,
	};
	const material = [
		input.readme ? `README:\n${input.readme}` : "",
		...input.sources.map((s) => `${s.path}:\n${s.text}`),
	]
		.join("\n\n")
		.slice(0, SUMMARY_INPUT_CHARS);
	if (material.trim() === "") {
		return fallback;
	}
	try {
		const { model, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE", complexity: "medium" },
			{
				userId: input.workflow.userId,
				organizationId: input.workflow.organizationId,
				projectId: input.workflow.projectId,
				jobType: "context-summarization",
			},
		);
		const result = await generateText({
			model,
			instructions: SUMMARY_PROMPT,
			prompt: `Project: ${input.name}\nTechnologies: ${input.stack.join(", ") || "unknown"}\n\n${material}`,
		});
		trackUsage();
		const json = /\{[\s\S]*\}/.exec(result.text)?.[0];
		const parsed = json
			? (JSON.parse(json) as {
					description?: unknown;
					goals?: unknown;
					features?: unknown;
				})
			: null;
		if (
			parsed &&
			typeof parsed.description === "string" &&
			parsed.description.trim()
		) {
			return {
				description: parsed.description.trim(),
				goals:
					typeof parsed.goals === "string" && parsed.goals.trim()
						? parsed.goals.trim()
						: fallback.goals,
				features: Array.isArray(parsed.features)
					? parsed.features
							.filter((f): f is string => typeof f === "string")
							.map((f) => f.trim())
							.filter(Boolean)
							.slice(0, 12)
					: fallback.features,
				generated: true,
			};
		}
	} catch (error) {
		logger.warn(
			"[project-import] summary generation failed; using the README",
			{
				error: error instanceof Error ? error.name : typeof error,
			},
		);
	}
	return fallback;
}

export async function recordProjectImportStepActivity(
	input: ProjectImportWorkflowInput & {
		key: ProjectImportStepKey;
		status: ProjectImportStepStatus;
		detail?: string;
	},
): Promise<void> {
	await step(input, input.key, input.status, input.detail);
}

export async function failProjectImportActivity(
	input: ProjectImportWorkflowInput & { message: string },
): Promise<void> {
	const run = await getProjectImportRun(input.runId, input.projectId);
	if (!run) {
		return;
	}
	for (const s of run.steps as unknown as {
		key: ProjectImportStepKey;
		status: string;
	}[]) {
		if (s.status === "RUNNING") {
			await step(input, s.key, "FAILED", input.message);
		}
	}
	await updateProjectImportRun(input.runId, input.projectId, {
		status: "FAILED",
		error: input.message,
	});
}

/**
 * Steps 2–13: read the structure, the stack, the documentation, classify it,
 * summarise the project and prepare what each Fabric surface would receive.
 * Leaves the findings on the run, in REVIEW.
 */
export async function analyzeProjectImportActivity(
	input: ProjectImportWorkflowInput,
): Promise<{ documents: number }> {
	const run = await getProjectImportRun(input.runId, input.projectId);
	if (!run) {
		throw ApplicationFailure.nonRetryable(
			"The import run no longer exists.",
			"IMPORT_RUN_GONE",
		);
	}
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { name: true, codeAnalysisStatus: true },
	});
	if (!project) {
		throw ApplicationFailure.nonRetryable(
			"The project no longer exists.",
			"IMPORT_PROJECT_GONE",
		);
	}
	const repository = await openRepository(input, run.repositoryIntegrationId);

	// 2. Structure.
	await step(input, "structure", "RUNNING");
	const tree = await listRepositoryTree(repository);
	if (!tree.ok) {
		throw tree.outcome === "unauthorized"
			? ApplicationFailure.nonRetryable(
					"The repository's credential cannot read it. Reconnect it in the project's integrations.",
					"IMPORT_AUTHENTICATION_FAILED",
				)
			: ApplicationFailure.retryable(
					"Couldn't read the repository's files. Trying again.",
					"IMPORT_REPOSITORY_UNREACHABLE",
				);
	}
	const files = tree.entries.filter(
		(entry): entry is RepositoryTreeEntry & { type: "file" } =>
			entry.type === "file",
	);
	const paths = files.map((f) => f.path);
	const sizeOf = new Map(files.map((f) => [f.path, f.size ?? 0]));
	const profile = repositoryProfile(paths);
	await step(
		input,
		"structure",
		"DONE",
		[
			plural(profile.fileCount, "file"),
			plural(profile.documentCount, "document"),
			profile.languages
				.slice(0, 3)
				.map((l) => l.name)
				.join(", "),
			{
				code: "code repository",
				docs: "documentation repository",
				mixed: "code and documentation",
				empty: "empty",
			}[profile.kind],
		]
			.filter(Boolean)
			.join(" · ") +
			(tree.truncated ? " (the listing was cut short)" : ""),
	);

	// 3. Stack and dependencies.
	await step(input, "stack", "RUNNING");
	const manifestPaths = paths
		.filter(
			(path) =>
				!NEVER_READ.test(path) &&
				(isManifestPath(path) ||
					/(^|\/)directory\.packages\.props$/i.test(path)),
		)
		.sort((a, b) => a.split("/").length - b.split("/").length)
		.slice(0, MAX_MANIFESTS);
	const infrastructurePaths = paths
		.filter((path) => !NEVER_READ.test(path) && isInfrastructureFile(path))
		.slice(0, MAX_INFRASTRUCTURE_FILES);
	const manifestTexts = await readMany(repository, [
		...manifestPaths,
		...infrastructurePaths,
	]);
	const packages: StackPackage[] = [];
	const runtimes: { name: string; source: string }[] = [];
	const resources: { type: string; source: string }[] = [];
	for (const path of manifestPaths) {
		const content = manifestTexts.get(path);
		if (!content) {
			continue;
		}
		if (/directory\.packages\.props$/i.test(path)) {
			for (const name of centralPackageNames(content)) {
				packages.push({
					ecosystem: "nuget",
					name,
					kind: "library",
					dev: false,
					source: path,
				});
			}
			continue;
		}
		for (const entry of parseTechStack([{ path, content }])) {
			packages.push({ ...entry, source: path });
		}
		if (path.toLowerCase().endsWith(".csproj")) {
			for (const name of dotnetRuntimes(content)) {
				runtimes.push({ name, source: path });
			}
		}
	}
	for (const path of infrastructurePaths) {
		const content = manifestTexts.get(path);
		for (const type of content
			? infrastructureResourceTypes(content)
			: []) {
			resources.push({ type, source: path });
		}
	}
	const stack = detectRepositoryStack({
		paths,
		packages,
		runtimes,
		resources,
	});
	await step(
		input,
		"stack",
		"DONE",
		stack.length === 0
			? "No dependency manifests or infrastructure files found."
			: `${plural(stack.length, "technology", "technologies")} from ${plural(manifestPaths.length + infrastructurePaths.length, "file")}: ${stack
					.filter((t) => t.category !== "language")
					.slice(0, 6)
					.map((t) => t.name)
					.join(", ")}${stack.length > 6 ? ", …" : ""}`,
	);

	// 4. Code: the existing code analysis runs on its own; this step reports it.
	await step(
		input,
		"code",
		profile.codeFileCount === 0 ? "SKIPPED" : "DONE",
		profile.codeFileCount === 0
			? "No code to analyse."
			: project.codeAnalysisStatus === "COMPLETED"
				? "The code analysis is in the project's context."
				: project.codeAnalysisStatus === "FAILED"
					? "The code analysis failed; it can be run again from the project."
					: "The code analysis runs alongside and lands in the project's context.",
	);

	// 5. Documentation, anywhere in the repository.
	await step(input, "docs", "RUNNING");
	const allDocuments = repositoryDocumentPaths(paths).filter(
		(path) => !NEVER_READ.test(path),
	);
	const toRead = allDocuments
		.filter((path) => (sizeOf.get(path) ?? 0) <= MAX_DOCUMENT_BYTES)
		.slice(0, MAX_DOCUMENTS);
	const texts = await readMany(repository, toRead);
	const folders = new Set(
		toRead.map((p) => p.split("/").slice(0, -1).join("/")),
	);
	await step(
		input,
		"docs",
		"DONE",
		`${plural(texts.size, "document")} in ${plural(folders.size, "folder")}${allDocuments.length > toRead.length ? `; ${plural(allDocuments.length - toRead.length, "more")} too large or over the limit` : ""}.`,
	);

	// 6. Classify by content.
	await step(input, "classify", "RUNNING");
	const classified = toRead
		.filter((path) => texts.has(path))
		.map((path) => {
			const text = texts.get(path) ?? "";
			return {
				...classifyRepositoryDocument({ path, text }),
				bytes: Buffer.byteLength(text),
				text,
			};
		});
	const documents = proposeDestinations(classified);
	const count = (d: ProjectImportDestination) =>
		documents.filter((doc) => doc.destination === d).length;
	await step(
		input,
		"classify",
		"DONE",
		[
			`${count("document")} documents`,
			`${count("context")} context`,
			`${count("decision")} decisions`,
			`${count("backlog")} backlog`,
			`${count("knowledge")} knowledge`,
			`${count("skip")} skipped`,
		].join(" · "),
	);

	// 7. Summarise.
	await step(input, "summary", "RUNNING");
	const readmePath =
		paths.find((p) => /^readme(\.md|\.markdown|\.txt|\.rst)?$/i.test(p)) ??
		null;
	// The product's own description first: the PRD, then the other documents.
	const rank = (d: ProjectImportDocumentFinding) =>
		d.destination === "document" ? (d.documentType === "PRD" ? 0 : 1) : 2;
	const sources = documents
		.filter(
			(d) =>
				d.destination === "document" ||
				/\b(overview|vision|product|brief|about|mission)\b/i.test(
					d.title,
				),
		)
		.sort((a, b) => rank(a) - rank(b))
		.slice(0, 6)
		.map((d) => ({ path: d.path, text: texts.get(d.path) ?? "" }));
	const summary = await summarise({
		workflow: input,
		name: project.name,
		readme: readmePath ? (texts.get(readmePath) ?? null) : null,
		sources,
		stack: stack.map((t) => t.name),
	});
	await step(
		input,
		"summary",
		summary.description ? "DONE" : "SKIPPED",
		summary.description
			? `${summary.generated ? "Written from the documents and the stack" : "Taken from the README"}${summary.features.length > 0 ? `; ${plural(summary.features.length, "feature")}` : ""}.`
			: "Nothing in the repository describes the product; the code analysis will.",
	);

	// 8–12. What each Fabric surface would receive.
	const docsByType = documents
		.filter((d) => d.destination === "document")
		.map((d) => d.documentType)
		.join(", ");
	await step(
		input,
		"documents",
		"DONE",
		count("document") > 0
			? `Proposed: ${docsByType}.`
			: "No product or engineering documents found.",
	);
	// One Living Memory sync per project: a sync from this repository (an
	// earlier import) is extended; one from another repository stays as it
	// is, and this repository's context is copied once instead.
	const existingSync = await getContextRepositorySync(
		input.projectId,
		input.organizationId,
	);
	const syncConfigured =
		existingSync !== null &&
		existingSync.repositoryIntegrationId !== run.repositoryIntegrationId;
	await step(
		input,
		"context",
		"DONE",
		`${plural(count("context"), "document")} proposed as context${count("context") > 0 ? (syncConfigured ? ", copied once (another repository's sync is already set up)" : ", synced from the repository") : ""}.`,
	);
	await step(
		input,
		"decisions",
		count("decision") > 0 ? "DONE" : "SKIPPED",
		count("decision") > 0
			? `${plural(count("decision"), "decision")} proposed.`
			: "No decision records found.",
	);
	const items = documents.reduce(
		(n, d) => n + (d.destination === "backlog" ? (d.itemCount ?? 0) : 0),
		0,
	);
	await step(
		input,
		"backlog",
		count("backlog") > 0 ? "DONE" : "SKIPPED",
		count("backlog") > 0
			? `${plural(items, "open item")} in ${plural(count("backlog"), "document")}, proposed for review.`
			: "No open work found.",
	);
	await step(
		input,
		"knowledge",
		count("knowledge") > 0 ? "DONE" : "SKIPPED",
		count("knowledge") > 0
			? `${plural(count("knowledge"), "dated note")} proposed as knowledge.`
			: "No journals or dated notes found.",
	);

	// 13. Coding instructions: counted here, moved from the offer.
	const aiFileCount = planConsolidation(
		files.map((f) => ({
			path: f.path,
			...(f.blobId ? { oid: f.blobId } : {}),
			...(f.mode ? { mode: f.mode } : {}),
		})),
	).items.filter((item) => item.defaultIncluded).length;
	// Instructions already synced from another repository (chosen on New
	// Project): that repository holds them, so nothing here is offered for
	// moving.
	const instructionSync = await getInstructionRepositorySync(
		input.projectId,
		input.organizationId,
	);
	const instructionsRepository =
		instructionSync !== null &&
		instructionSync.repositoryIntegrationId !== run.repositoryIntegrationId
			? `${instructionSync.repositoryIntegration.repositoryOwner}/${instructionSync.repositoryIntegration.repositoryName}`
			: null;
	await step(
		input,
		"instructions",
		aiFileCount > 0 && instructionsRepository === null ? "DONE" : "SKIPPED",
		instructionsRepository !== null
			? `Coding instructions come from ${instructionsRepository}; AI tool files here are not moved.`
			: aiFileCount > 0
				? `${plural(aiFileCount, "AI tool file")} to move to an instructions repository.`
				: "No AI tool files in the repository.",
	);

	const findings: ProjectImportFindings = {
		repository: {
			provider: repository.provider,
			url: repository.repositoryUrl,
			name: `${repository.owner}/${repository.repo}`,
			branch: repository.branch,
		},
		profile,
		stack,
		summary,
		documents,
		unreadDocumentCount: allDocuments.length - texts.size,
		aiFileCount,
		contextSyncConfigured: syncConfigured,
		instructionsRepository,
	};
	await step(input, "review", "RUNNING", "Waiting for your review.");
	await updateProjectImportRun(input.runId, input.projectId, {
		status: "REVIEW",
		findings: JSON.parse(JSON.stringify(findings)),
	});
	return { documents: documents.length };
}

function topicOf(path: string): { key: string; title: string } {
	const folder = path.split("/").slice(0, -1).pop() ?? "notes";
	return {
		key:
			folder
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "") || "notes",
		title: folder,
	};
}

/**
 * Step 14: create what the person kept. Each kind is created through its
 * existing path; a failure of one item is counted and logged, never fatal
 * to the rest.
 */
export async function applyProjectImportActivity(
	input: ProjectImportWorkflowInput & { selection: ProjectImportSelection },
): Promise<ProjectImportAppliedCounts> {
	const run = await getProjectImportRun(input.runId, input.projectId);
	const findings = run?.findings as ProjectImportFindings | null | undefined;
	if (!run || !findings) {
		throw ApplicationFailure.nonRetryable(
			"The import has nothing to apply.",
			"IMPORT_NOTHING_TO_APPLY",
		);
	}
	const repository = await openRepository(input, run.repositoryIntegrationId);
	const known = new Map(findings.documents.map((d) => [d.path, d]));
	const chosen = input.selection.documents.filter((d) => known.has(d.path));
	const pathsOf = (d: ProjectImportDestination) =>
		chosen.filter((c) => c.destination === d).map((c) => c.path);
	const counts: ProjectImportAppliedCounts = {
		projectFields: false,
		documents: 0,
		contextPaths: 0,
		contextSynced: false,
		contexts: 0,
		decisions: 0,
		backlogProposals: 0,
		backlogItems: 0,
		knowledge: 0,
		failed: 0,
	};
	const tenancy = {
		userId: input.userId,
		organizationId: input.organizationId,
	};
	const failed = (what: string, error: unknown) => {
		counts.failed += 1;
		logger.warn(`[project-import] ${what} failed`, {
			error: error instanceof Error ? error.name : typeof error,
		});
	};
	await updateProjectImportRun(input.runId, input.projectId, {
		status: "APPLYING",
	});
	await step(input, "review", "RUNNING", "Creating what you kept.");

	// Project fields: only what was kept, and never over something already written.
	const fields = input.selection.projectFields;
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: {
			description: true,
			goals: true,
			techStack: true,
			features: true,
		},
	});
	if (project) {
		const data: {
			description?: string;
			goals?: string;
			techStack?: string[];
			features?: string[];
		} = {};
		if (fields.description && findings.summary.description) {
			data.description = findings.summary.description;
		}
		if (fields.goals && findings.summary.goals && !project.goals?.trim()) {
			data.goals = findings.summary.goals;
		}
		if (fields.techStack && findings.stack.length > 0) {
			data.techStack = [
				...new Set([
					...project.techStack,
					...findings.stack.map((t) => t.name),
				]),
			];
		}
		if (fields.features && findings.summary.features.length > 0) {
			data.features = [
				...new Set([...project.features, ...findings.summary.features]),
			];
		}
		if (Object.keys(data).length > 0) {
			await db.project.update({ where: { id: input.projectId }, data });
			counts.projectFields = true;
		}
	}

	// Everything kept is read again, once: the findings hold no file bodies.
	const needed = chosen
		.filter(
			(c) =>
				c.destination !== "skip" &&
				!(
					c.destination === "context" &&
					!findings.contextSyncConfigured
				),
		)
		.map((c) => c.path);
	const texts = await readMany(repository, needed);
	const client = await getTemporalClient();

	// Documents (IMPORTED, linked to a source context the Context tab hides).
	// Keyed by repository and path, so importing again never copies a file
	// twice: what an earlier import created is now edited in Fabric.
	const existingImports = await db.projectContext.findMany({
		where: {
			projectId: input.projectId,
			AND: [
				{ metadata: { path: ["source"], equals: "repository-import" } },
				{
					metadata: {
						path: ["repository"],
						equals: findings.repository.name,
					},
				},
			],
		},
		select: { id: true, metadata: true },
	});
	const alreadyImported = new Set(
		existingImports.map(
			(c) => (c.metadata as { path?: string } | null)?.path ?? "",
		),
	);
	for (const path of pathsOf("document")) {
		const text = texts.get(path);
		const finding = known.get(path);
		if (!text || !finding || alreadyImported.has(path)) {
			continue;
		}
		try {
			const context = await createContext({
				projectId: input.projectId,
				type: "TEXT",
				content: text,
				metadata: {
					source: "repository-import",
					importRunId: input.runId,
					path,
					repository: findings.repository.name,
				},
				sourceTitle: finding.title,
				userId: input.userId,
				organizationId: input.organizationId,
			});
			const { documentId } = await createImportedDocument({
				projectId: input.projectId,
				contextId: context.id,
				documentType: finding.documentType ?? "GENERAL",
				title: finding.title,
				content: text,
				userId: input.userId,
				organizationId: input.organizationId,
			});
			await client.workflow.start("documentEmbeddingWorkflow", {
				taskQueue: "project-documents",
				workflowId: `document-embedding-${documentId}`,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "TERMINATE_EXISTING",
				args: [
					{
						documentId,
						userId: input.userId,
						organizationId: input.organizationId,
					},
				],
			});
			counts.documents += 1;
		} catch (error) {
			failed("document", error);
		}
	}

	// Context: synced from the repository, or copied once when a sync already exists.
	const contextPaths = pathsOf("context");
	if (contextPaths.length > 0) {
		if (!findings.contextSyncConfigured) {
			try {
				const proposed = contextSyncPaths({
					documents: findings.documents.map((d) => d.path),
					chosen: contextPaths,
					limit: CONTEXT_SYNC_PATH_LIMIT,
				});
				// A sync this repository already has (an earlier import, or
				// one set up by hand) keeps what it syncs; the import adds to it.
				const current = await getContextRepositorySync(
					input.projectId,
					input.organizationId,
				);
				const same =
					current?.repositoryIntegrationId ===
					run.repositoryIntegrationId
						? current
						: null;
				const paths = [
					...new Set([...(same?.paths ?? []), ...proposed.paths]),
				].slice(0, CONTEXT_SYNC_PATH_LIMIT);
				// A file chosen now is never left out, even if it was before.
				const chosenNow = new Set(contextPaths);
				const covered = (path: string) =>
					chosenNow.has(path) || paths.includes(path);
				const excludedPaths = [
					...new Set([
						...(same?.excludedPaths ?? []),
						...proposed.excludedPaths,
					]),
				].filter((path) => !covered(path));
				const written = await upsertContextRepositorySync({
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					repositoryIntegrationId: run.repositoryIntegrationId,
					ref: same?.ref ?? repository.branch,
					paths,
					excludedPaths: excludedPaths.slice(
						0,
						CONTEXT_SYNC_EXCLUDED_LIMIT,
					),
				});
				if (written.status === "configured") {
					counts.contextPaths = paths.length;
					recordAudit({
						action: "project.context.repository_sync_configured",
						actor: { type: "user", userId: input.userId },
						organizationId: input.organizationId,
						projectId: input.projectId,
						resource: {
							type: "repository",
							id: run.repositoryIntegrationId,
							name: findings.repository.name,
						},
						metadata: {
							provider: findings.repository.provider,
							pathCount: paths.length,
							origin: "repository-import",
							generation: written.sync.generation,
						},
					});
					try {
						await client.workflow.start(
							"projectContextRepositorySyncWorkflow",
							{
								taskQueue: "project-documents",
								workflowId: `context-repository-sync-${input.projectId}`,
								workflowIdConflictPolicy: "FAIL",
								args: [
									{
										projectId: input.projectId,
										organizationId: input.organizationId,
										trigger: "MANUAL",
										requesterUserId: input.userId,
									},
								],
							},
						);
						recordAudit({
							action: "project.context.repository_sync_started",
							actor: { type: "user", userId: input.userId },
							organizationId: input.organizationId,
							projectId: input.projectId,
							resource: {
								type: "repository",
								id: run.repositoryIntegrationId,
								name: findings.repository.name,
							},
							metadata: { origin: "repository-import" },
						});
					} catch (error) {
						if (
							!(
								error instanceof Error &&
								error.name ===
									"WorkflowExecutionAlreadyStartedError"
							)
						) {
							throw error;
						}
					}
					counts.contextSynced = true;
				} else {
					failed("context sync", new Error(written.status));
				}
			} catch (error) {
				failed("context sync", error);
			}
		} else {
			for (const path of contextPaths) {
				const text = texts.get(path);
				if (!text || alreadyImported.has(path)) {
					continue;
				}
				try {
					const context = await createContext({
						projectId: input.projectId,
						type: "TEXT",
						content: text,
						metadata: {
							source: "repository-import",
							importRunId: input.runId,
							path,
							repository: findings.repository.name,
						},
						sourceTitle: known.get(path)?.title ?? path,
						userId: input.userId,
						organizationId: input.organizationId,
					});
					await startContextEmbeddingWorkflow(client, {
						contextId: context.id,
						projectId: input.projectId,
						userId: input.userId,
						organizationId: input.organizationId,
						sourcePath: path,
						title: known.get(path)?.title ?? path,
						reembed: false,
					});
					counts.contexts += 1;
				} catch (error) {
					failed("context", error);
				}
			}
		}
	}

	// Decisions, once per path.
	const decisionPaths = pathsOf("decision");
	if (decisionPaths.length > 0) {
		const existing = await db.architectureDecision.findMany({
			where: {
				projectId: input.projectId,
				participantsText: { startsWith: "Imported from " },
			},
			select: { participantsText: true },
		});
		const done = new Set(existing.map((d) => d.participantsText ?? ""));
		const author = await db.user.findUnique({
			where: { id: input.userId },
			select: { name: true },
		});
		for (const path of decisionPaths) {
			const text = texts.get(path);
			const marker = `Imported from ${findings.repository.name}/${path}`;
			const decision = text ? extractDecision({ path, text }) : null;
			if (!decision || done.has(marker)) {
				continue;
			}
			try {
				await createArchitectureDecision({
					projectId: input.projectId,
					createdById: input.userId,
					title: decision.title,
					contextProblem: decision.contextProblem,
					decision: decision.decision,
					rationale: decision.rationale,
					consequences: decision.consequences ?? null,
					alternativesConsidered:
						decision.alternativesConsidered ?? null,
					status: decision.status,
					participantsText: marker,
					editedByName: author?.name || "Repository import",
					userId: input.userId,
					organizationId: input.organizationId,
				});
				counts.decisions += 1;
			} catch (error) {
				failed("decision", error);
			}
		}
	}

	// Backlog: one proposal per folder, for review in the inbox.
	const byFolder = new Map<string, string[]>();
	for (const path of pathsOf("backlog")) {
		const folder = path.split("/").slice(0, -1).join("/") || "(root)";
		byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
	}
	// Importing again proposes only what is new: an item an earlier import
	// proposed and the person already decided on (approved, rejected,
	// deferred) is not proposed again, and an earlier proposal still waiting
	// for review is replaced by this one.
	const earlier = await db.pendingBacklogProposal.findMany({
		where: {
			projectId: input.projectId,
			source: "SCOPE_DOCUMENT",
			sourceMetadata: {
				path: ["origin"],
				equals: "repository-import",
			},
		},
		select: {
			id: true,
			status: true,
			proposal: true,
			sourceMetadata: true,
		},
	});
	const decided = new Set(
		earlier
			.filter((p) => p.status !== "PENDING" && p.status !== "SUPERSEDED")
			.flatMap(
				(p) =>
					(p.proposal as { changes?: { sourceChangeKey?: string }[] })
						.changes ?? [],
			)
			.map((c) => c.sourceChangeKey)
			.filter((key): key is string => !!key),
	);
	const slug = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60);
	for (const [folder, folderPaths] of byFolder) {
		const changes = folderPaths
			.flatMap((path) => {
				const text = texts.get(path);
				return text
					? extractBacklogItems({ path, text }).map((item) => ({
							type: item.type,
							action: "create" as const,
							title: { to: item.title },
							description: { to: item.description },
							...(item.acceptanceCriteria
								? {
										acceptanceCriteria: {
											to: item.acceptanceCriteria,
										},
									}
								: {}),
							labels: ["imported"],
							sourceContext: "repository_import",
							sourceChangeKey: `import:${findings.repository.name}:${path}:${slug(item.title)}`,
						}))
					: [];
			})
			.filter(
				(change, i, all) =>
					!decided.has(change.sourceChangeKey) &&
					all.findIndex(
						(c) => c.sourceChangeKey === change.sourceChangeKey,
					) === i,
			);
		if (changes.length === 0) {
			continue;
		}
		try {
			const sameFolder = earlier.filter((p) => {
				const meta = p.sourceMetadata as {
					folder?: string;
					repository?: string;
				} | null;
				return (
					meta?.folder === folder &&
					(meta.repository === undefined ||
						meta.repository === findings.repository.name)
				);
			});
			// This run's own proposal for the folder: a retried apply.
			if (
				sameFolder.some(
					(p) =>
						(p.sourceMetadata as { importRunId?: string } | null)
							?.importRunId === input.runId,
				)
			) {
				continue;
			}
			const waiting = sameFolder
				.filter((p) => p.status === "PENDING")
				.map((p) => p.id);
			if (waiting.length > 0) {
				await db.pendingBacklogProposal.updateMany({
					where: { id: { in: waiting }, status: "PENDING" },
					data: { status: "SUPERSEDED" },
				});
			}
			await createPendingBacklogProposal({
				projectId: input.projectId,
				source: "SCOPE_DOCUMENT",
				proposal: JSON.parse(
					JSON.stringify({
						summary: `Open work from ${folder} in ${findings.repository.name}`,
						changes,
					}),
				),
				summary: `Open work from ${folder} in ${findings.repository.name}`,
				changeCount: changes.length,
				sourceMetadata: {
					origin: "repository-import",
					importRunId: input.runId,
					repository: findings.repository.name,
					folder,
					files: folderPaths.length,
				},
				userId: input.userId,
				organizationId: input.organizationId,
			});
			counts.backlogProposals += 1;
			counts.backlogItems += changes.length;
		} catch (error) {
			failed("backlog proposal", error);
		}
	}

	// Knowledge: one entry per file, on a topic per folder; the path keeps it
	// idempotent. Each new entry is embedded as one saved through Fabric is,
	// and each topic it touched gets its summary once at the end.
	const touchedTopics = new Set<string>();
	for (const path of pathsOf("knowledge")) {
		const text = texts.get(path);
		if (!text) {
			continue;
		}
		const topic = topicOf(path);
		const finding = known.get(path);
		try {
			const saved = await addKnowledgeEntry({
				projectId: input.projectId,
				tenancy,
				authorUserId: input.userId,
				topic: topic.key,
				topicTitle: topic.title,
				typeKey: /meeting/i.test(path)
					? "meeting-notes"
					: finding?.reason.startsWith("A plan")
						? "spec"
						: "journal",
				title: finding?.title ?? path,
				body: text,
				sourcePath: path,
			});
			counts.knowledge += 1;
			if (!saved.duplicate) {
				await embedKnowledgeEntry(
					saved.entry,
					saved.topic,
					saved.type.key,
					tenancy,
				);
				touchedTopics.add(saved.topic.id);
			}
		} catch (error) {
			failed("knowledge entry", error);
		}
		Context.current().heartbeat({ knowledge: counts.knowledge });
	}
	for (const topicId of touchedTopics) {
		try {
			await startKnowledgeTopicSummaryWorkflow(client, {
				projectId: input.projectId,
				topicId,
			});
		} catch (error) {
			logger.warn("[project-import] topic summary did not start", {
				error: error instanceof Error ? error.name : typeof error,
			});
		}
	}

	await step(
		input,
		"documents",
		"DONE",
		counts.documents > 0
			? `${plural(counts.documents, "document")} created.`
			: "None kept.",
	);
	await step(
		input,
		"context",
		"DONE",
		counts.contextSynced
			? `Synced from ${plural(counts.contextPaths, "repository path")}.`
			: counts.contexts > 0
				? `${plural(counts.contexts, "document")} copied to context.`
				: "None kept.",
	);
	await step(
		input,
		"decisions",
		counts.decisions > 0 ? "DONE" : "SKIPPED",
		counts.decisions > 0
			? `${plural(counts.decisions, "decision")} recorded.`
			: "None kept.",
	);
	await step(
		input,
		"backlog",
		counts.backlogItems > 0 ? "DONE" : "SKIPPED",
		counts.backlogItems > 0
			? `${plural(counts.backlogItems, "item")} waiting for review in ${plural(counts.backlogProposals, "proposal")}.`
			: "None kept.",
	);
	await step(
		input,
		"knowledge",
		counts.knowledge > 0 ? "DONE" : "SKIPPED",
		counts.knowledge > 0
			? `${plural(counts.knowledge, "entry", "entries")} saved.`
			: "None kept.",
	);
	await step(
		input,
		"review",
		"DONE",
		counts.failed > 0
			? `Created; ${plural(counts.failed, "item")} could not be created.`
			: "Created.",
	);
	await updateProjectImportRun(input.runId, input.projectId, {
		status: "COMPLETED",
		findings: JSON.parse(JSON.stringify({ ...findings, applied: counts })),
	});
	recordAudit({
		action: "project.import.applied",
		actor: { type: "user", userId: input.userId },
		organizationId: input.organizationId,
		projectId: input.projectId,
		resource: { type: "project", id: input.projectId, name: null },
		metadata: { ...counts },
	});
	return counts;
}
