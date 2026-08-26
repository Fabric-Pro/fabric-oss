import {
	generateObject,
	getAIModelWithMetadata,
	getCurrentDateContext,
	logModelUsageAsync,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module (uniform rule across the budget sites).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	type DeploymentItem,
	isCurrentOrgMember,
	NEWSLETTER_SCHEMA_VERSION,
	type NewsletterContent,
	type NewsletterDetailLevel,
	type NewsletterHighlight,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
// Deep import is load-bearing: the daily-brief barrel does NOT re-export this
// constant. This import lives ONLY in this ACTIVITY (never in the workflow-side
// helper) — collect-github-releases.ts pulls @repo/database at runtime.
import { RELEASE_NOTES_OMITTED_NOTICE } from "../daily-brief/collect-github-releases";
import { getDetailLevelClause } from "./detail-level";

export interface CurateNewsletterFromReleasesInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	projectName: string;
	releases: DeploymentItem[];
	detailLevel?: NewsletterDetailLevel;
}
export interface CurateNewsletterFromReleasesOutput {
	content: NewsletterContent;
	aiUsageTokens: number | null;
}

const LlmOutputSchema = z.object({
	headline: z
		.string()
		.describe("Short, friendly headline for the update email."),
	intro: z
		.string()
		.describe(
			"1-2 sentence plain-language intro for external stakeholders.",
		),
	hasMajorFeatures: z
		.boolean()
		.describe(
			"True ONLY if there is at least one major user-facing feature worth announcing.",
		),
	highlights: z
		.array(
			z.object({
				title: z.string().describe("Short feature name, no jargon."),
				description: z
					.string()
					.describe("1-2 sentences on the user-facing benefit."),
				prUrl: z
					.string()
					.optional()
					.describe("The release URL this highlight came from."),
			}),
		)
		.describe(
			"Major user-facing features ONLY. Empty if nothing qualifies.",
		),
});

const PROMPT_RELEASE_LIMIT = 50; // == collector MAX_DEPLOYMENT_ITEMS — enumerate ALL it returns
const PROMPT_BODY_CAP = 2000; // per-release body char cap
const PROMPT_TOTAL_BODY_BUDGET = 24_000; // aggregate body budget (fits SIMPLE-tier context)
const PER_REPO_MIN_BODY = 400; // guaranteed slice for each repo's newest release (fairness)

/** Exported for unit testing. Enumerates EVERY release (no silent drop); trims
 *  BODIES under a per-repo-FAIR budget; strips the collector's omitted-notice. */
export function buildReleaseNewsletterPrompt(
	projectName: string,
	releases: DeploymentItem[],
	detailLevel: NewsletterDetailLevel = "STANDARD",
): string {
	const cleaned = releases.slice(0, PROMPT_RELEASE_LIMIT).map((r) => ({
		tag: r.tagName,
		title: r.title,
		repo: r.repoFullName,
		url: r.url,
		// Compare BEFORE slice so an exact omitted-notice becomes title-only.
		fullBody:
			r.body && r.body !== RELEASE_NOTES_OMITTED_NOTICE
				? r.body.slice(0, PROMPT_BODY_CAP)
				: undefined,
	}));

	// Per-repo-FAIR body budgeting: pass 1 reserves a guaranteed min slice for each
	// repo's newest release; pass 2 upgrades by recency to the full cap. Releases
	// arrive newest-first, so "first seen repo" == that repo's newest.
	const bodyLen = new Array<number>(cleaned.length).fill(0);
	let used = 0;
	const seenRepo = new Set<string>();
	for (let i = 0; i < cleaned.length; i++) {
		const b = cleaned[i].fullBody;
		if (!b || seenRepo.has(cleaned[i].repo)) {
			continue;
		}
		seenRepo.add(cleaned[i].repo);
		const want = Math.min(b.length, PER_REPO_MIN_BODY);
		if (used + want <= PROMPT_TOTAL_BODY_BUDGET) {
			bodyLen[i] = want;
			used += want;
		}
	}
	for (let i = 0; i < cleaned.length; i++) {
		const b = cleaned[i].fullBody;
		if (!b) {
			continue;
		}
		const extra = b.length - bodyLen[i];
		if (extra > 0 && used + extra <= PROMPT_TOTAL_BODY_BUDGET) {
			bodyLen[i] = b.length;
			used += extra;
		}
	}

	const lines = cleaned.map((r, i) => {
		const head = `- [${r.tag}] ${r.title} (${r.repo}) <${r.url}>`;
		return bodyLen[i] > 0 && r.fullBody
			? `${head}\n${r.fullBody.slice(0, bodyLen[i])}`
			: head;
	});

	return [
		"You are writing an external-stakeholder release-notes newsletter for a software project.",
		"Each item below is a PUBLISHED PRODUCTION RELEASE: tag, title, repository, release URL (in <angle brackets>), and release notes.",
		...getDetailLevelClause(detailLevel),
		"For each highlight you emit, set prUrl to the release URL (the <...> link) of the release it came from.",
		"If NOTHING qualifies as a major user-facing change, set hasMajorFeatures=false and return an empty highlights array.",
		"",
		getCurrentDateContext(),
		`Project: "${projectName}"`,
		"",
		"Published production releases in this period:",
		...lines,
	].join("\n");
}

/** Exported for testing. Attaches canonical release metadata to a curated highlight
 *  by matching its LLM-emitted prUrl back to a source release by NORMALIZED EXACT url
 *  equality (strips trailing slash/query/hash); returns {} when nothing matches so the
 *  email helper can fall back. */
export function mapHighlightReleaseMeta(
	highlight: NewsletterHighlight,
	releases: DeploymentItem[],
): { releaseTag?: string; repoFullName?: string } {
	const url = highlight.prUrl;
	if (!url) {
		return {};
	}
	const norm = (u: string) =>
		u.split("#")[0].split("?")[0].replace(/\/+$/, "");
	const target = norm(url);
	const match = releases.find((r) => norm(r.url) === target);
	return match
		? { releaseTag: match.tagName, repoFullName: match.repoFullName }
		: {};
}

export async function curateNewsletterFromReleasesActivity(
	input: CurateNewsletterFromReleasesInput,
): Promise<CurateNewsletterFromReleasesOutput> {
	const {
		projectId,
		organizationId,
		userId,
		projectName,
		releases,
		detailLevel,
	} = input;
	heartbeat("curateNewsletterFromReleases: starting");

	const emptyResult: CurateNewsletterFromReleasesOutput = {
		content: {
			schemaVersion: NEWSLETTER_SCHEMA_VERSION as 1,
			headline: "",
			intro: "",
			highlights: [],
			hasMajorFeatures: false,
		},
		aiUsageTokens: null,
	};
	if (releases.length === 0) {
		return emptyResult;
	}

	// Point-of-use actor re-validation (TOCTOU) — identical to legacy curate.
	if (organizationId && !(await isCurrentOrgMember(userId, organizationId))) {
		logger.warn(
			"[Newsletter] Skipping AI curation: configuring admin is no longer a valid member of the organization",
			{ projectId, organizationId, userId },
		);
		return emptyResult;
	}

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{ userId, organizationId: organizationId ?? undefined },
	);
	const prompt = buildReleaseNewsletterPrompt(
		projectName,
		releases,
		detailLevel,
	);
	const start = Date.now();
	logger.info("[Newsletter] curating release notes", {
		projectId,
		detailLevel: detailLevel ?? "STANDARD",
	});
	heartbeat("curateNewsletterFromReleases: waiting for LLM response");
	// 30s interval MUST stay below the proxy's heartbeatTimeout (60s) — do not raise.
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat("curateNewsletterFromReleases: waiting for LLM response");
		} catch {
			/* cancelled */
		}
	}, 30_000);

	// Bounded curated newsletter (highlights) — but that still exceeds the 4,096
	// Anthropic unrecognized-model fallback and can clip under Databricks' 8,192
	// default. Scaled mode with inputChars 0 requests the floor (16,384), clamped
	// to the provider cap and context window. `undefined` leaves other providers
	// on their SDK defaults.
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: 0,
		promptChars: prompt.length,
	});

	let llmResult: Awaited<
		ReturnType<typeof generateObject<typeof LlmOutputSchema>>
	>;
	try {
		llmResult = await generateObject({
			model,
			schema: LlmOutputSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});
	} finally {
		clearInterval(heartbeatInterval);
	}

	trackUsage();
	logModelUsageAsync({
		context: { userId, organizationId: organizationId ?? undefined },
		metadata,
		taskType: "SIMPLE",
		usage: llmResult.usage,
		latencyMs: Date.now() - start,
		projectId,
	});

	const o = llmResult.object;
	const content: NewsletterContent = {
		schemaVersion: NEWSLETTER_SCHEMA_VERSION as 1,
		headline: o.headline,
		intro: o.intro,
		hasMajorFeatures: o.hasMajorFeatures && o.highlights.length > 0,
		highlights: o.highlights.map((h) => ({
			title: h.title,
			description: h.description,
			...(h.prUrl ? { prUrl: h.prUrl } : {}),
			...mapHighlightReleaseMeta(h, releases),
		})),
	};
	const aiUsageTokens =
		(llmResult.usage?.totalTokens as number | undefined) ??
		(llmResult.usage?.inputTokens ?? 0) +
			(llmResult.usage?.outputTokens ?? 0);
	return { content, aiUsageTokens: aiUsageTokens || null };
}
