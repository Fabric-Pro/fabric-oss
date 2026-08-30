/**
 * Planning & Analysis context collection (Publishing Suite Phase 2A-2,
 * Fizzy #1851).
 *
 * DV17 says the Topic Item Page must not display source context the viewer
 * cannot access. A stored analysis is read by anyone who can open the topic —
 * including project GUESTS, who reach project-scoped rows through
 * `getProjectCarveOut` (`tenant-db.ts:399-410`), which ORs allowed project ids
 * into the tenant filter. Anything quoted into the analysis is therefore
 * readable by all of them, and the write is where the decision is made: once a
 * sentence is copied into a project-scoped row it carries none of its source's
 * permissions.
 *
 * So the rule this module enforces is narrow and checkable: **read only what the
 * topic's own `provenance` names.** Those rows are why the topic exists, they
 * are all project-scoped, and anyone who can see the topic already sees the 1A
 * engine's summary of them. Nothing is widened to "the project's recent
 * activity", which is what would quietly pull in rows the topic has no
 * relationship to.
 *
 * Per-user sources — chats, Slack/Teams — are deliberately NOT here. `AiChat` is
 * a tenant table but is NOT project-scoped (`tenant-db.ts:62`, "Per-user
 * conversations, even within an org"), so copying a chat line into this
 * project-scoped row would hand it to every guest on the project. Including
 * them needs a per-source ACL that Phase 2A does not have.
 *
 * What provenance CANNOT address is stated rather than hidden:
 *   - `featureVersionIds` is always empty — the 1A prompt tells the model
 *     "not present in 1A collectors — leave empty/omit" (`prompt.ts:44`).
 *   - There is NO release field on `TopicProvenanceSchema` and no `Release`
 *     table, so a release-derived topic cannot be addressed. Its content reaches
 *     the model only through the topic's own title/pitch/angle/subject, which
 *     are the 1A engine's summary of the release it read. Reading releases by
 *     WINDOW instead was considered and declined: with no provenance link the
 *     model would be handed releases that may have nothing to do with this
 *     topic, which is an invitation to exactly the invention FR20 forbids. The
 *     real fix is a release identifier in `TopicProvenanceSchema` — a Phase 1A
 *     change, tracked separately.
 */

import { db, getProjectReposForCodeSearch } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type RepoIntegrationRow,
	resolveRepoAuth,
} from "../daily-brief/resolve-repo-auth";
import type { PlanningAnalysisContext } from "./build-planning-analysis-prompt";

const GITHUB_API_URL = "https://api.github.com";

/**
 * How many PR bodies will be fetched for one analysis.
 *
 * Bounds the external work a single button press can start. Every coordinate is
 * still passed to the model as a citable reference — only the number of BODIES
 * is capped — so the cap costs detail, never a citation.
 */
export const PR_BODY_FETCH_CAP = 20;

/**
 * Per-kind ceiling on how many provenance ids one analysis will read.
 *
 * Not a security bound — the reads are already project-scoped — but a
 * context-window one. See the comment at its use for why the overflow is
 * reported instead of being dropped quietly.
 */
export const SOURCE_ID_CAP = 25;

/** Per-PR body budget inside the prompt. */
export const PR_BODY_CHAR_CAP = 4000;

/**
 * What actually fed one analysis, and what did not.
 *
 * Persisted alongside the content so the claim in this file's header is
 * auditable after the fact rather than merely asserted, and so a thin analysis
 * can be EXPLAINED. "Built from two documents and nothing else, because the repo
 * credential had expired" is recoverable; "thin" on its own is not.
 */
export interface PlanningSourceRefs {
	stories: string[];
	documents: string[];
	transcripts: string[];
	repoPrs: { repoFullName: string; prNumber: number }[];
	prBodiesFetched: number;
	/**
	 * Repos the project has with usable credentials. `null` means GitHub was
	 * never consulted (provenance named no PRs); `0` means it was, and there were
	 * none — which is NOT the same as a fetch failure.
	 */
	activeRepoCount: number | null;
	/** Provenance ids that named a row which no longer resolves. */
	unresolved: {
		storyIds: string[];
		docIds: string[];
		transcriptIds: string[];
	};
	/** Source kind → why it is missing or incomplete. */
	failures: Record<string, string>;
}

export interface PlanningContextResult {
	context: PlanningAnalysisContext;
	sourceRefs: PlanningSourceRefs;
}

// ---------------------------------------------------------------------------
// Defensive provenance parsing
// ---------------------------------------------------------------------------

/**
 * `provenance` is a `Json` column, so nothing at the type level stops it holding
 * a string, a number, or arrays of the wrong shape. A throw here would fail a
 * run over a field the user never touched, so every accessor below is tolerant
 * and drops what it cannot understand — the same posture
 * `resolve-topic-contributors.ts` takes on the same column.
 */
function stringIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
}

function prCoordinates(
	value: unknown,
): { repoFullName: string; prNumber: number }[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: { repoFullName: string; prNumber: number }[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const pr = entry as { repoFullName?: unknown; prNumber?: unknown };
		if (
			typeof pr.repoFullName === "string" &&
			pr.repoFullName.length > 0 &&
			typeof pr.prNumber === "number" &&
			Number.isInteger(pr.prNumber)
		) {
			out.push({ repoFullName: pr.repoFullName, prNumber: pr.prNumber });
		}
	}
	return out;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * Fetch the body of each PR the topic's provenance names.
 *
 * By COORDINATE, never by window: provenance names these PRs specifically, so
 * this is a handful of point reads rather than a scan of everything the project
 * merged recently.
 *
 * Every failure path degrades. A rate limit, an expired credential, a missing
 * integration or a 404 leaves the coordinate in place without its body — the
 * generate button must not be able to fail because GitHub is unwell, which was
 * the whole reservation about putting it on this path at all.
 */
async function fetchPrBodies(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	coordinates: { repoFullName: string; prNumber: number }[];
	failures: Record<string, string>;
}): Promise<{
	bodies: Map<string, string>;
	activeRepoCount: number;
}> {
	const bodies = new Map<string, string>();

	const repos = (await getProjectReposForCodeSearch(
		input.projectId,
	)) as RepoIntegrationRow[];

	if (repos.length === 0) {
		// NOT the same as "the fetch failed", and not the same as "there are no
		// PRs". `getProjectReposForCodeSearch` also returns [] when a project's
		// credentials have EXPIRED (status != ACTIVE), which is indistinguishable
		// here — so it is recorded as a stated reason rather than as silence.
		input.failures.pullRequests =
			"No active repo integrations (a project with none, or credentials that need re-authorising).";
		return { bodies, activeRepoCount: 0 };
	}

	// Match each coordinate to the integration that owns it. A coordinate whose
	// repo is not connected is left as a bare reference rather than guessed at.
	const byFullName = new Map<string, RepoIntegrationRow>();
	for (const repo of repos) {
		const url = (repo as { repositoryUrl?: string }).repositoryUrl ?? "";
		const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
		if (match?.[1]) {
			byFullName.set(match[1].toLowerCase(), repo);
		}
	}

	const budget = input.coordinates.slice(0, PR_BODY_FETCH_CAP);
	for (const coordinate of budget) {
		const repo = byFullName.get(coordinate.repoFullName.toLowerCase());
		if (!repo) {
			continue;
		}
		try {
			const auth = await resolveRepoAuth(repo, {
				userId: input.userId,
				organizationId: input.organizationId,
			});
			if (auth.kind !== "github") {
				// GitLab and ADO carry their own request shapes. 2A-2 reads GitHub
				// only; the others keep their coordinates as references, which is
				// the same degraded state a rate limit produces.
				input.failures.pullRequests ??= `Unsupported provider for ${coordinate.repoFullName}`;
				continue;
			}
			const response = await fetch(
				`${GITHUB_API_URL}/repos/${coordinate.repoFullName}/pulls/${coordinate.prNumber}`,
				{
					headers: {
						Authorization: `Bearer ${auth.token}`,
						Accept: "application/vnd.github+json",
					},
				},
			);
			if (!response.ok) {
				input.failures.pullRequests ??= `GitHub returned ${response.status} for at least one pull request`;
				continue;
			}
			const pr = (await response.json()) as {
				title?: unknown;
				body?: unknown;
			};
			const body = typeof pr.body === "string" ? pr.body : "";
			const title = typeof pr.title === "string" ? pr.title : "";
			const combined = [title, body].filter(Boolean).join("\n\n");
			if (combined) {
				bodies.set(
					`${coordinate.repoFullName}#${coordinate.prNumber}`,
					combined.slice(0, PR_BODY_CHAR_CAP),
				);
			}
		} catch (error) {
			input.failures.pullRequests ??= errorMessage(error);
		}
	}

	return { bodies, activeRepoCount: repos.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function collectPlanningContext(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	topicId: string;
	provenance: unknown;
}): Promise<PlanningContextResult> {
	const provenance =
		typeof input.provenance === "object" && input.provenance !== null
			? (input.provenance as Record<string, unknown>)
			: {};

	const failures: Record<string, string> = {};

	// `provenance` is written from the 1A model's output, and
	// `LlmTopicProvenanceSchema` bounds neither the array length nor the strings
	// inside it. Every rendered item is truncated by the prompt builder, but the
	// COUNT was not: a model that emitted three hundred story ids would assemble
	// a prompt large enough to overflow the context window and fail the run over
	// a field no user ever touched.
	//
	// The cap is recorded rather than applied silently, because a quietly
	// shortened read is the shape of every collector bug in this repo worth
	// remembering — thin output, green run, nothing saying why.
	const cap = (ids: string[], kind: string): string[] => {
		if (ids.length <= SOURCE_ID_CAP) {
			return ids;
		}
		failures[kind] =
			`Provenance named ${ids.length} ${kind}; read the first ${SOURCE_ID_CAP}.`;
		return ids.slice(0, SOURCE_ID_CAP);
	};

	const storyIds = cap(stringIds(provenance.storyIds), "stories");
	const docIds = cap(stringIds(provenance.docIds), "documents");
	const transcriptIds = cap(
		stringIds(provenance.transcriptIds),
		"transcripts",
	);
	const coordinates = prCoordinates(provenance.repoPrs);

	// Every read is scoped by `projectId` as well as by id. The ids are
	// server-written, but re-scoping is what makes a corrupted or hand-edited
	// provenance blob unable to reach another tenant's rows — the same reason
	// every mutation in this feature re-scopes to `{ id, projectId }`.
	const scope = { projectId: input.projectId };

	const [stories, documents, transcripts] = await Promise.all([
		storyIds.length > 0
			? db.userStory
					.findMany({
						where: { ...scope, id: { in: storyIds } },
						select: {
							id: true,
							identifier: true,
							title: true,
							description: true,
						},
					})
					.catch((error) => {
						failures.stories = errorMessage(error);
						return [];
					})
			: Promise.resolve([]),
		docIds.length > 0
			? db.projectDocument
					.findMany({
						where: { ...scope, id: { in: docIds } },
						select: { id: true, title: true, content: true },
					})
					.catch((error) => {
						failures.documents = errorMessage(error);
						return [];
					})
			: Promise.resolve([]),
		transcriptIds.length > 0
			? db.projectMeetingTranscript
					.findMany({
						where: { ...scope, id: { in: transcriptIds } },
						select: { id: true, summary: true },
					})
					.catch((error) => {
						failures.transcripts = errorMessage(error);
						return [];
					})
			: Promise.resolve([]),
	]);

	let activeRepoCount: number | null = null;
	let bodies = new Map<string, string>();
	if (coordinates.length > 0) {
		const fetched = await fetchPrBodies({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			coordinates,
			failures,
		});
		bodies = fetched.bodies;
		activeRepoCount = fetched.activeRepoCount;
	}

	const resolvedStoryIds = stories.map((s) => s.id);
	const resolvedDocIds = documents.map((d) => d.id);
	const resolvedTranscriptIds = transcripts.map((t) => t.id);

	const context: PlanningAnalysisContext = {
		stories: stories.map((s) => ({
			id: s.id,
			identifier: s.identifier ?? s.id,
			title: s.title,
			description: s.description ?? null,
		})),
		documents: documents.map((d) => ({
			id: d.id,
			title: d.title,
			excerpt: d.content ?? null,
		})),
		transcripts: transcripts.map((t) => ({
			id: t.id,
			summary: t.summary ?? null,
		})),
		repoPrs: coordinates.map((c) => ({
			repoFullName: c.repoFullName,
			prNumber: c.prNumber,
			body: bodies.get(`${c.repoFullName}#${c.prNumber}`) ?? null,
		})),
	};

	if (Object.keys(failures).length > 0) {
		logger.warn("[publishing-planning] context collected with gaps", {
			topicId: input.topicId,
			projectId: input.projectId,
			failures,
		});
	}

	return {
		context,
		sourceRefs: {
			stories: resolvedStoryIds,
			documents: resolvedDocIds,
			transcripts: resolvedTranscriptIds,
			repoPrs: coordinates,
			prBodiesFetched: bodies.size,
			activeRepoCount,
			// A provenance id that no longer resolves means the analysis is thinner
			// than its own provenance implies — a story deleted after the topic was
			// suggested, say. Without this the difference is invisible.
			unresolved: {
				storyIds: storyIds.filter(
					(id) => !resolvedStoryIds.includes(id),
				),
				docIds: docIds.filter((id) => !resolvedDocIds.includes(id)),
				transcriptIds: transcriptIds.filter(
					(id) => !resolvedTranscriptIds.includes(id),
				),
			},
			failures,
		},
	};
}
