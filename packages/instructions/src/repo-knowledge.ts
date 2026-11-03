/**
 * What a repository's documents are, for Fabric (specs/2026-10-21-ai-artifacts-hub
 * §3.1, import): each text document is classified by its CONTENT into the
 * Fabric surface it belongs to. No folder name is assumed: a team keeps its
 * docs wherever it likes, so the path is only a weak hint next to the text.
 *
 *   document       a PRD, an architecture or a technical spec
 *   decision       an architecture decision record
 *   backlog        a list of work still to do
 *   release-notes  a changelog
 *   knowledge      dated notes: journals, retros, meeting notes
 *   context        everything else worth knowing about the product
 *   skip           too short, generated, legal, or an AI tool's file
 *
 * Pure and deterministic. A model may refine the result where one is
 * configured; this is what the import falls back on and what it starts from.
 */

import { planConsolidation } from "./consolidation";

export type RepoDocKind =
	| "document"
	| "decision"
	| "backlog"
	| "release-notes"
	| "knowledge"
	| "context"
	| "skip";

export type RepoDocumentType =
	| "PRD"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "DESIGN_SYSTEM";

export type RepoDocClassification = {
	path: string;
	kind: RepoDocKind;
	documentType?: RepoDocumentType;
	title: string;
	/** 0–1: how sure the content signals are. */
	confidence: number;
	reason: string;
};

const TEXT_DOC = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const MIN_CHARS = 200;
const GENERATED_OR_LEGAL =
	/(^|\/)(license|licence|copying|notice|code_of_conduct|security|third[-_]party[-_]notices?)(\.[a-z]+)?$/i;
const NEVER_SCANNED =
	/(^|\/)(node_modules|vendor|dist|build|out|\.git|coverage|bin|obj)\//i;

/** The repository paths worth reading: text documents outside dependencies and AI tool files. */
export function repositoryDocumentPaths(paths: readonly string[]): string[] {
	const aiFiles = new Set(
		planConsolidation(paths.map((path) => ({ path }))).items.map(
			(item) => item.from,
		),
	);
	return paths.filter(
		(path) =>
			TEXT_DOC.test(path) &&
			!NEVER_SCANNED.test(path) &&
			!GENERATED_OR_LEGAL.test(path) &&
			!aiFiles.has(path),
	);
}

function stripFrontmatter(raw: string): { head: string; body: string } {
	// A byte-order mark would hide the first heading and the front matter.
	const text = raw.replace(/^﻿/, "");
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	return match
		? { head: match[1] ?? "", body: text.slice(match[0].length) }
		: { head: "", body: text };
}

function titleOf(path: string, body: string, head: string): string {
	const own = /^title:\s*(.+)$/m.exec(head)?.[1];
	const heading = /^#\s+(.+)$/m.exec(body)?.[1];
	const base =
		path
			.split("/")
			.pop()
			?.replace(/\.[^.]+$/, "") ?? path;
	return (own ?? heading ?? base).replace(/^["']|["']$/g, "").trim();
}

function headings(body: string): string[] {
	return [...body.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) =>
		(m[1] ?? "").toLowerCase().trim(),
	);
}

function count(re: RegExp, text: string): number {
	return [...text.matchAll(re)].length;
}

function has(list: readonly string[], ...words: string[]): number {
	return words.filter((w) => list.some((h) => h.includes(w))).length;
}

export function classifyRepositoryDocument(input: {
	path: string;
	text: string;
}): RepoDocClassification {
	const { head, body } = stripFrontmatter(input.text);
	const title = titleOf(input.path, body, head);
	const lower = body.toLowerCase();
	const hs = headings(body);
	const result = (
		kind: RepoDocKind,
		confidence: number,
		reason: string,
		documentType?: RepoDocumentType,
	): RepoDocClassification => ({
		path: input.path,
		kind,
		title,
		confidence,
		reason,
		...(documentType ? { documentType } : {}),
	});

	// Not UTF-8 text (UTF-16 or binary reads as text full of NUL characters),
	// or a program's captured output (terminal colour codes): nothing to keep,
	// and a repository sync could not read it either.
	if (input.text.includes("\u0000")) {
		return result("skip", 0.95, "Not a UTF-8 text file.");
	}
	if (body.split("\u001b[").length > 5) {
		return result("skip", 0.9, "Captured program output.");
	}
	if (body.trim().length < MIN_CHARS) {
		return result("skip", 0.9, "Too short to be useful on its own.");
	}
	// An AI assistant's saved memory (front matter typed user / feedback /
	// project / reference): it belongs with the coding instructions.
	if (
		/^\s*(node_type:\s*memory|originSessionId:|type:\s*(user|feedback|project|reference)\s*$)/im.test(
			head,
		)
	) {
		return result(
			"skip",
			0.85,
			"An AI assistant's memory; it belongs with the coding instructions.",
		);
	}

	// A changelog: several version headings ("## [1.2.0]", "## v1.4 —
	// 2026-05-01"), not numbered sections ("## 2.1 Growth").
	const versionHeadings = count(
		/^#{1,3}\s*\[?v?\d+\.\d+(\.\d+)?\]?(?=\s*$|\s*[-–—(:]|\s+\d{4}-\d\d)/gim,
		body,
	);
	if (
		versionHeadings >= 2 ||
		(versionHeadings >= 1 && /changelog|release notes/i.test(title))
	) {
		return result(
			"release-notes",
			0.85,
			`${versionHeadings} version headings.`,
		);
	}

	// An ADR: status with context/decision/consequences sections.
	const adrSections = has(
		hs,
		"context",
		"decision",
		"consequences",
		"status",
		"options considered",
		"alternatives",
	);
	if (
		(adrSections >= 3 && has(hs, "decision") > 0) ||
		/^status:\s*(proposed|accepted|rejected|deprecated|superseded)/im.test(
			`${head}\n${body}`,
		)
	) {
		return result(
			"decision",
			0.8,
			"Status, context and decision sections.",
		);
	}

	// One work item per file: its title carries an item id (US-1.2,
	// BUG-2026-07-06-01, PROJ-42). Its checkboxes are its acceptance
	// criteria, not separate items.
	const finished = isFinished(head, body);
	const item = workItemOf(title);
	if (item) {
		if (item.kind === "test") {
			return result("context", 0.6, `Test case ${item.id}.`);
		}
		return finished
			? result("context", 0.65, `${item.id}, finished.`)
			: result("backlog", 0.75, `${item.id}, open.`);
	}

	// Work still to do: a list of open task items, or user stories. A
	// document with open steps among much prose is a plan, kept as knowledge.
	const openTasks = count(/^\s*[-*]\s+\[ \]\s+/gm, body);
	const doneTasks = count(/^\s*[-*]\s+\[x\]\s+/gim, body);
	const userStories = count(/\bas an? [^,\n]{2,60},? i want\b/gi, body);
	const plan = openTasks + doneTasks >= 3 && looksLikePlan(title, body);
	if (plan) {
		return result(
			"knowledge",
			0.6,
			openTasks > 0
				? `A plan with ${openTasks} open steps.`
				: "A plan, done.",
		);
	}
	if (
		openTasks >= 3 &&
		openTasks >= doneTasks &&
		namedDocumentType(title) === null
	) {
		return result("backlog", 0.75, `${openTasks} open task items.`);
	}
	if (userStories >= 2) {
		return result("backlog", 0.7, `${userStories} user stories.`);
	}
	const bugSections = has(
		hs,
		"steps to reproduce",
		"repro",
		"expected",
		"actual",
		"root cause",
		"severity",
	);
	if (bugSections >= 2) {
		return finished
			? result("context", 0.6, "A bug report that is closed.")
			: result("backlog", 0.7, "A bug report.");
	}
	if (
		userStories === 1 &&
		(has(hs, "acceptance criteria", "acceptance") > 0 || body.length < 4000)
	) {
		return finished
			? result("context", 0.6, "A user story that is done.")
			: result("backlog", 0.65, "A user story.");
	}

	// A product or engineering document by its sections.
	const prd = has(
		hs,
		"requirements",
		"goals",
		"non-goals",
		"user stories",
		"acceptance criteria",
		"success metrics",
		"personas",
		"problem",
		"scope",
		"features",
		"roles",
		"mvp",
		"principles",
	);
	const arch = has(
		hs,
		"architecture",
		"components",
		"data flow",
		"deployment",
		"infrastructure",
		"services",
		"diagram",
		"system overview",
	);
	const spec = has(
		hs,
		"api",
		"endpoints",
		"schema",
		"data model",
		"implementation",
		"interfaces",
		"sequence",
		"error handling",
	);
	const design = has(
		hs,
		"design tokens",
		"tokens",
		"typography",
		"colors",
		"colours",
		"spacing",
		"iconography",
	);
	// The title says what a document means to be; a guide or a runbook with
	// architecture-like sections is still reference material.
	const named = namedDocumentType(title);
	const guide =
		/\b(setup|install|deploy\w*|guide|runbook|how[- ]to|readme|onboarding|troubleshoot\w*)\b/i.test(
			title,
		);
	const best = Math.max(prd, arch, spec, design);
	if ((best >= 2 && !guide) || (named && best >= 1)) {
		const documentType: RepoDocumentType =
			named ??
			(best === prd
				? "PRD"
				: best === arch
					? "ARCHITECTURE"
					: best === spec
						? "TECHNICAL_SPEC"
						: "DESIGN_SYSTEM");
		return result(
			"document",
			Math.min(0.55 + Math.min(best, 5) * 0.06 + (named ? 0.2 : 0), 0.95),
			named
				? `Named a ${documentType.toLowerCase().replace("_", " ")}.`
				: `${best} ${documentType.toLowerCase().replace("_", " ")} sections.`,
			documentType,
		);
	}

	// Dated notes: several date headings.
	const datedHeadings = count(/^#{1,4}\s*.*\b20\d\d-\d\d-\d\d\b/gm, body);
	if (
		datedHeadings >= 2 ||
		/\b(retro|retrospective|journal|meeting notes|standup)\b/i.test(title)
	) {
		return result(
			"knowledge",
			0.6,
			datedHeadings >= 2
				? `${datedHeadings} dated entries.`
				: "A journal or retro.",
		);
	}

	return result(
		"context",
		lower.length > 1500 ? 0.6 : 0.45,
		"Prose about the product: kept as project context.",
	);
}

/** A work item that says it is finished: a status line or front matter of done, fixed, closed. */
const FINISHED_WORDS =
	"done|fixed|closed|resolved|shipped|completed?|implemented|released|delivered|merged|won'?t fix|wontfix|duplicate|obsolete|cancell?ed|закрит\\S*|виправлен\\S*|реалізован\\S*|готово|зроблено|закрыт\\S*|исправлен\\S*|реализован\\S*";

/**
 * A work item that says it is finished: a status line ("Status: Done",
 * "**Статус:** closed", front matter `status: fixed`) or an opening note
 * that it was closed, in the first lines of the file.
 */
function isFinished(head: string, body: string): boolean {
	const top = `${head}\n${body.slice(0, 1500)}`;
	const statusLine = new RegExp(
		`^[\\s>*_-]*(status|state|статус|стан)[^\\p{L}\\n]{0,12}(${FINISHED_WORDS})(?![\\p{L}])`,
		"imu",
	);
	const closedNote = new RegExp(
		`^\\s*>\\s*(\\*\\*)?(${FINISHED_WORDS})\\b`,
		"imu",
	);
	return statusLine.test(top) || closedNote.test(top);
}

/** The id a work item's title starts with, and what kind of item it names. */
function workItemOf(
	title: string,
): { id: string; kind: "bug" | "feature" | "test" } | null {
	const match = /^\s*\[?([A-Z][A-Z0-9]{1,9}-\d[\w.-]*)\]?(?=\s|:|$)/.exec(
		title,
	);
	if (!match?.[1]) {
		return null;
	}
	const id = match[1];
	const prefix = id.split("-")[0] ?? "";
	// A decision record or a release is not a work item.
	if (/^(ADR|RFC|DR|V|R)$/.test(prefix)) {
		return null;
	}
	return {
		id,
		kind: /^(BUG|DEFECT|ISSUE|INC|HOTFIX)$/.test(prefix)
			? "bug"
			: /^(TC|TEST|QA)$/.test(prefix)
				? "test"
				: "feature",
	};
}

/**
 * Whether a document with checkboxes is a plan for one piece of work rather
 * than a list of separate work items: it names itself a plan, walks through
 * numbered steps, phases or slices, or carries code.
 */
/** The document type a title names ("Product Specification", "Architecture"), if any. */
function namedDocumentType(title: string): RepoDocumentType | null {
	return /\b(prd|specification|requirements|srs)\b|product (spec|requirements)/i.test(
		title,
	)
		? "PRD"
		: /\barchitecture\b/i.test(title)
			? "ARCHITECTURE"
			: /\b(technical|tech) spec|\bdesign doc/i.test(title)
				? "TECHNICAL_SPEC"
				: /\bdesign system|\bstyle guide/i.test(title)
					? "DESIGN_SYSTEM"
					: null;
}

function looksLikePlan(title: string, body: string): boolean {
	// A document that names itself a specification keeps its checklist.
	if (namedDocumentType(title) !== null) {
		return false;
	}
	if (
		/\b(plan|implementation|runbook|checklist|migration)\b|план/iu.test(
			title,
		)
	) {
		return true;
	}
	const fences = count(/^\s*```/gm, body);
	const stepHeadings = count(
		/^#{2,4}\s*(task|step|phase|stage|slice|milestone|part|крок|етап|фаза)\s*\d+[.:)]?\s/gimu,
		body,
	);
	const phaseHeadings = count(
		/^#{2,4}\s*(task|step|phase|stage|slice|milestone|крок|етап|фаза)(?!\p{L})/gimu,
		body,
	);
	return fences >= 2 || stepHeadings >= 2 || phaseHeadings >= 2;
}

export type RepoBacklogItem = {
	type: "feature" | "bug";
	title: string;
	description: string;
	acceptanceCriteria?: string;
};

const MAX_ITEM_TITLE = 200;
const MAX_ITEM_DESCRIPTION = 4000;

/** The text under the first heading whose name contains one of the words, up to the next heading of the same or higher level. */
export function sectionText(body: string, ...words: string[]): string | null {
	const lines = body.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = /^(#{1,6})\s+(.+)$/.exec(lines[i] ?? "");
		if (!match) {
			continue;
		}
		const name = (match[2] ?? "").toLowerCase();
		// Whole words only: "vision" must not match "provisioning".
		if (
			!words.some((w) =>
				new RegExp(
					`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`,
					"u",
				).test(name),
			)
		) {
			continue;
		}
		const level = (match[1] ?? "").length;
		const out: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = /^(#{1,6})\s/.exec(lines[j] ?? "");
			if (next && (next[1] ?? "").length <= level) {
				break;
			}
			out.push(lines[j] ?? "");
		}
		const text = out.join("\n").trim();
		return text === "" ? null : text;
	}
	return null;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The open work a backlog document holds: each unchecked task item, or the
 * one story or bug the file describes. Items under a heading that names bugs
 * are bugs. Checked items are history, not backlog, and are left out.
 */
export function extractBacklogItems(input: {
	path: string;
	text: string;
}): RepoBacklogItem[] {
	const { head, body } = stripFrontmatter(input.text);
	const title = titleOf(input.path, body, head);
	const item = workItemOf(title);
	const openTasks = [...body.matchAll(/^\s*[-*]\s+\[ \]\s+(.+)$/gm)];
	if (!item && openTasks.length >= 3) {
		const items: RepoBacklogItem[] = [];
		let heading = "";
		for (const line of body.split(/\r?\n/)) {
			const h = /^#{1,6}\s+(.+)$/.exec(line);
			if (h) {
				heading = (h[1] ?? "").trim();
				continue;
			}
			const task = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
			if (!task) {
				continue;
			}
			const text = (task[1] ?? "")
				.replace(/\*\*|__|`/g, "")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.trim();
			if (text.length < 3) {
				continue;
			}
			const [first, ...rest] = text.split(/\s[—–-]\s|:\s/);
			items.push({
				type:
					/\bbugs?\b/i.test(heading) || /^(fix|bug)\b/i.test(text)
						? "bug"
						: "feature",
				title: clip((first ?? text).trim(), MAX_ITEM_TITLE),
				description: clip(
					[
						rest.length > 0 ? rest.join(" — ").trim() : "",
						heading
							? `From "${heading}" in ${input.path}.`
							: `From ${input.path}.`,
					]
						.filter(Boolean)
						.join("\n\n"),
					MAX_ITEM_DESCRIPTION,
				),
			});
		}
		return items;
	}
	if (isFinished(head, body)) {
		return [];
	}
	const isBug =
		item?.kind === "bug" ||
		has(
			headings(body),
			"steps to reproduce",
			"repro",
			"expected",
			"actual",
		) >= 2;
	const acceptance = sectionText(body, "acceptance criteria", "acceptance");
	const description = body.replace(/^#\s+.+$/m, "").trim();
	return [
		{
			type: isBug ? "bug" : "feature",
			title: clip(title, MAX_ITEM_TITLE),
			description: clip(
				`${description}\n\nFrom ${input.path}.`,
				MAX_ITEM_DESCRIPTION,
			),
			...(acceptance && !isBug
				? { acceptanceCriteria: clip(acceptance, MAX_ITEM_DESCRIPTION) }
				: {}),
		},
	];
}

export type RepoDecision = {
	title: string;
	contextProblem: string;
	decision: string;
	rationale: string;
	consequences?: string;
	alternativesConsidered?: string;
	status: "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "DEPRECATED" | "REJECTED";
};

/** An ADR's parts, or null when it has no decision to record. */
export function extractDecision(input: {
	path: string;
	text: string;
}): RepoDecision | null {
	const { head, body } = stripFrontmatter(input.text);
	const decision = sectionText(body, "decision outcome", "decision");
	if (!decision) {
		return null;
	}
	const context =
		sectionText(body, "context", "problem", "background") ??
		"Recorded in the repository before the project moved to Fabric.";
	const rationale =
		sectionText(body, "rationale", "justification", "why") ??
		sectionText(body, "consequences") ??
		"See the decision.";
	const statusWord = (
		/^\s*status\s*:\s*(\w+)/im.exec(`${head}\n${body}`)?.[1] ??
		sectionText(body, "status")?.split(/\s/)[0] ??
		""
	).toLowerCase();
	const status: RepoDecision["status"] = statusWord.startsWith("accept")
		? "ACCEPTED"
		: statusWord.startsWith("supersed")
			? "SUPERSEDED"
			: statusWord.startsWith("deprecat")
				? "DEPRECATED"
				: statusWord.startsWith("reject")
					? "REJECTED"
					: statusWord.startsWith("propos")
						? "PROPOSED"
						: "ACCEPTED";
	const consequences = sectionText(body, "consequences");
	const alternatives = sectionText(
		body,
		"options considered",
		"alternatives",
		"considered options",
	);
	return {
		title: clip(
			titleOf(input.path, body, head).replace(
				/^adr[-\s]?\d+[:.\s-]*/i,
				"",
			),
			MAX_ITEM_TITLE,
		),
		contextProblem: clip(context, MAX_ITEM_DESCRIPTION),
		decision: clip(decision, MAX_ITEM_DESCRIPTION),
		rationale: clip(rationale, MAX_ITEM_DESCRIPTION),
		...(consequences
			? { consequences: clip(consequences, MAX_ITEM_DESCRIPTION) }
			: {}),
		...(alternatives
			? {
					alternativesConsidered: clip(
						alternatives,
						MAX_ITEM_DESCRIPTION,
					),
				}
			: {}),
		status,
	};
}

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/**
 * The fewest repository paths that sync exactly the chosen documents: a
 * folder whose every text document was chosen is synced whole, and a folder
 * that is mostly chosen is synced with the rest left out. `limit` is the
 * sync's path cap; past it the result keeps the largest folders.
 */
export function contextSyncPaths(input: {
	/** Every text document the import read. */
	documents: readonly string[];
	/** The ones chosen for synced context. */
	chosen: readonly string[];
	limit: number;
}): { paths: string[]; excludedPaths: string[] } {
	const chosen = new Set(input.chosen);
	const under = (folder: string, path: string) =>
		folder === "" || path.startsWith(`${folder}/`);
	// Walk folders from the top down; a folder is taken when at least
	// three quarters of its documents are chosen and no folder above it
	// was taken already.
	const folders = new Set<string>();
	for (const path of chosen) {
		let folder = parentOf(path);
		while (folder !== "") {
			folders.add(folder);
			folder = parentOf(folder);
		}
	}
	const byDepthAsc = [...folders].sort(
		(a, b) =>
			a.split("/").length - b.split("/").length || a.localeCompare(b),
	);
	const covered = new Set<string>();
	const paths: string[] = [];
	const excludedPaths: string[] = [];
	for (const folder of byDepthAsc) {
		if (paths.some((p) => under(p, folder))) {
			continue;
		}
		const docs = input.documents.filter((d) => under(folder, d));
		const inFolder = docs.filter((d) => chosen.has(d));
		if (docs.length >= 2 && inFolder.length / docs.length >= 0.75) {
			paths.push(folder);
			for (const d of docs) {
				if (chosen.has(d)) {
					covered.add(d);
				} else {
					excludedPaths.push(d);
				}
			}
		}
	}
	for (const path of chosen) {
		if (!covered.has(path)) {
			paths.push(path);
		}
	}
	return {
		paths: paths.slice(0, input.limit),
		excludedPaths,
	};
}
