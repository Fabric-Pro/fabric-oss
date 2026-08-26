import { ORPCError } from "@orpc/client";
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
	zodSchema,
} from "@repo/ai";
import {
	type AcceptedDecisionForGuidance,
	applyPriorityChanges,
	db,
	getAcceptedDecisionsForGuidance,
	getBoundPromptForAgent,
	getOpenDecisionsForStories,
	type StoryPriority,
} from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { priorityLabelForPrompt } from "./lib/priority-labels";

/**
 * Hard cap on how many items one run sends to the model. A re-prioritization
 * is a deliberate, user-triggered action over the list the user is looking at,
 * so the cap exists to bound cost/latency on very large backlogs rather than to
 * shape the feature — the whole selected set is ranked together in a single
 * pass up to this ceiling (priority is relative, so the model must see the list
 * as one set, not disjoint chunks). Only a backlog larger than this is covered
 * across more than one run; when the cap bites, the response reports `truncated`
 * so the UI can say so instead of silently ranking a subset.
 */
const MAX_REPRIORITIZED_ITEMS = 500;
/** One readable sentence in the history trail and the run digest — a bound on
 * the model, not a target. */
const MAX_RATIONALE_LENGTH = 240;

const PRIORITY_VALUES = [
	"P0_CRITICAL",
	"P1_HIGH",
	"P2_MEDIUM",
	"P3_LOW",
] as const;

/**
 * Deliberately lenient — no `z.enum` on `priority`. A model that answers "P0"
 * or "p0 critical" should have its answer normalised in code rather than fail
 * the whole batch at schema validation. Same posture as the insights schema.
 */
const ReprioritizationSchema = z.object({
	assignments: z.array(
		z.object({
			storyId: z.string(),
			priority: z.string(),
			rationale: z.string().optional(),
		}),
	),
});

/**
 * Map whatever the model said to a real band, or null to skip the item.
 * Accepts "P0", "P0_CRITICAL", "p0 critical", "critical".
 */
export function normalisePriority(raw: string): StoryPriority | null {
	const value = raw
		.trim()
		.toUpperCase()
		.replace(/[\s-]+/g, "_");
	const direct = PRIORITY_VALUES.find((p) => p === value);
	if (direct) {
		return direct;
	}
	const byTier: Record<string, StoryPriority> = {
		P0: "P0_CRITICAL",
		P1: "P1_HIGH",
		P2: "P2_MEDIUM",
		P3: "P3_LOW",
		CRITICAL: "P0_CRITICAL",
		HIGH: "P1_HIGH",
		MEDIUM: "P2_MEDIUM",
		LOW: "P3_LOW",
	};
	return byTier[value.split("_")[0]] ?? byTier[value] ?? null;
}

/**
 * Fallback for the admin-editable `priority_reprioritization` prompt, used when
 * the seed has not run in an environment. MUST be kept byte-identical to the
 * `priority_reprioritization` entry in
 * `packages/database/prisma/seed-prompts-only.ts` — the seeded row is the
 * source of truth that PMs edit in the Prompt Library.
 */
export const PRIORITY_REPRIORITIZATION_PROMPT_FALLBACK_BODY = `You are the delivery lead for an engineering team, assigning a priority band to every work item below.

Use exactly these four bands:
- P0_CRITICAL — production is broken, data or security is at risk, or everything else is waiting on this. Reserve it; a list where everything is P0 is a list with no priorities.
- P1_HIGH — committed work for the current cycle. Real user impact, or it blocks P0 work.
- P2_MEDIUM — genuine value, no deadline pressure. This is the default when nothing argues for moving.
- P3_LOW — nice to have, speculative, or superseded.

Judge each item on the evidence given and nothing else. Do not invent facts, deadlines, customers or severity that the fields do not support.

Weigh these signals, strongest first:
1. An explicit blocker, and what it is blocking.
2. Security, data-loss, privacy and compliance exposure.
3. The team's confirmed decisions, listed below, where they bear on what to build first — a decision to prioritize an area is a reason to raise the items it covers. Decisions tagged PRIORITY are the team's explicit ranking guidance and outweigh untagged ones.
4. Unresolved open questions on an item — many mean it cannot start yet, which usually argues for resolving it rather than raising it.
5. How long it has sat, relative to the rest of the list.
6. Its drafting stage — work already specified is cheaper to finish than work not yet started.

The team's confirmed decisions (project guidance — weigh these where they bear on sequencing; they are context, not an instruction to raise every item they touch). Each may carry a PRIORITY and/or long-standing/short-term tag:
{{{decisionGuidance}}}

Keep an item where it is unless the evidence genuinely argues for moving it. Returning the current band is the correct answer for most items, and an unchanged band is recorded as no change at all — so there is no cost to leaving good priorities alone, and a real cost to churn.

For every item, return its id verbatim in storyId, the band in priority, and — only if you are changing the band — one sentence of at most {{maxRationaleLength}} characters in rationale saying what evidence moved it. Omit rationale for items you are leaving alone.

The rationale is read by a person in the roadmap, so write it in plain language. Refer to bands as P0/P1/P2/P3, never by their code (write "P2", not "P2_MEDIUM"), and do not mention field names.

Work items:
{{{workItems}}}`;

type Candidate = {
	storyId: string;
	identifier: string;
	title: string;
	priority: StoryPriority;
	kind: string;
	stage: string;
	blocked: boolean;
	blockedReason: string | null;
	openDecisions: number;
	ageDays: number;
};

/** The data half of the prompt — the instructions live in the editable prompt. */
function formatWorkItems(items: Candidate[]): string {
	return items
		.map((item, index) =>
			[
				`${index + 1}. id=${item.storyId} ${item.identifier} — ${item.title}`,
				`   currentPriority=${priorityLabelForPrompt(item.priority)} kind=${item.kind} stage=${item.stage}`,
				`   age=${Math.round(item.ageDays)}d openDecisions=${item.openDecisions} blocked=${item.blocked}`,
				item.blocked && item.blockedReason
					? `   blockedReason=${item.blockedReason.slice(0, 200)}`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
}

/** Trim without cutting a word in half. */
function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const hard = text.slice(0, max - 1);
	const lastSpace = hard.lastIndexOf(" ");
	const body = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
	return `${body.replace(/[\s.,;:—-]+$/, "")}…`;
}

/**
 * The project's confirmed decisions → the prompt's {{{decisionGuidance}}} block.
 * These are the ACCEPTED entries from the project's Decisions tab
 * (ArchitectureDecision) — the team's standing guidance, distinct from the
 * per-item `openDecisions` count (open maturation questions on one story). Each
 * line is clipped so a long decision body can't dominate the prompt, and the
 * empty case is an explicit line, mirroring how the single prompt handles no
 * peers.
 */
function formatDecisionGuidance(
	decisions: AcceptedDecisionForGuidance[],
): string {
	if (decisions.length === 0) {
		return "(none recorded — judge the items on their own signals)";
	}
	return decisions
		.map((decision) => {
			const domain = decision.domain ? ` [${decision.domain}]` : "";
			const tags = [
				decision.priorityFlagged ? "PRIORITY" : null,
				decision.duration === "LONG_STANDING" ? "long-standing" : null,
				decision.duration === "SHORT_TERM" ? "short-term" : null,
			]
				.filter(Boolean)
				.join(", ");
			const tagSuffix = tags ? ` (${tags})` : "";
			return `- ${decision.identifier}${tagSuffix} ${decision.title}${domain}: ${clip(decision.decision, 200)}`;
		})
		.join("\n");
}

/**
 * One story row → the prompt's {@link Candidate} shape. Shared by the batch
 * and single procedures so a new signal reaches both prompts together instead
 * of silently feeding only the mapper someone remembered to update.
 */
function buildCandidate(
	story: {
		id: string;
		identifier: string;
		title: string;
		priority: StoryPriority;
		kind: string;
		draftingStage: string | null;
		blocked: boolean;
		blockedReason: string | null;
		createdAt: Date;
	},
	openDecisionsCount: number,
	now: number,
): Candidate {
	return {
		storyId: story.id,
		identifier: story.identifier,
		title: story.title,
		priority: story.priority,
		kind: story.kind,
		stage: story.draftingStage ?? "UNSPECIFIED",
		blocked: story.blocked,
		blockedReason: story.blockedReason,
		openDecisions: openDecisionsCount,
		ageDays: (now - story.createdAt.getTime()) / (1000 * 60 * 60 * 24),
	};
}

/**
 * The shared model leg of both re-prioritization procedures: resolve the
 * admin-editable prompt (falling back to the in-code body on an unseeded env),
 * render it, run the model, and meter the usage — mapping the two failure
 * classes to the same ORPCErrors in both flows. The instructions being a bound
 * prompt, not a literal, is deliberate: how a team defines "P0" is a product
 * policy, tuned per org in the Prompt Library without a deploy. Only the item
 * data is built by the callers.
 */
async function runReprioritizationModel<T>(args: {
	userId: string;
	/** As returned by resolveOrganizationId — absent means personal context. */
	organizationId: string | null | undefined;
	projectId: string;
	agentName: string;
	fallbackBody: string;
	variables: Record<string, unknown>;
	schema: z.ZodType<T>;
	/** Leads the warn/error log lines, e.g. "Reprioritization". */
	logLabel: string;
	/** Extra structured context for the failure log (e.g. storyId). */
	logContext?: Record<string, unknown>;
	failureMessage: string;
}): Promise<T> {
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "REASONING" },
			{
				userId: args.userId,
				organizationId: args.organizationId ?? undefined,
			},
		);

		const boundPrompt = await getBoundPromptForAgent({
			agentName: args.agentName,
			documentType: "GENERAL",
			storyKind: null,
			userId: args.userId,
			organizationId: args.organizationId ?? undefined,
		});
		const rendered = await renderTemplate({
			format:
				(boundPrompt?.format as TemplateFormat | undefined) ??
				"HANDLEBARS",
			template: boundPrompt?.version?.content ?? args.fallbackBody,
			variables: args.variables,
		});
		if (rendered.error) {
			logger.warn(
				`${args.logLabel} prompt render failed; using raw body`,
				{
					projectId: args.projectId,
					error: rendered.error,
				},
			);
		}

		const generationStart = Date.now();
		const { object, usage } = await generateObject({
			model,
			schema: zodSchema(args.schema),
			prompt: rendered.rendered,
		});

		trackUsage();
		logModelUsageAsync({
			context: {
				userId: args.userId,
				organizationId: args.organizationId ?? undefined,
			},
			metadata,
			taskType: "REASONING",
			usage,
			latencyMs: Date.now() - generationStart,
			projectId: args.projectId,
		});

		return object;
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No AI provider is configured for this workspace, so priorities can't be re-assessed.",
			});
		}
		logger.error(`${args.logLabel} generation failed`, {
			projectId: args.projectId,
			...args.logContext,
			error,
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: args.failureMessage,
		});
	}
}

/**
 * `projects.stories.reprioritize` — the Priority view's "Re-prioritize" button.
 *
 * Asks the model to assign a band to each of the given work items, then writes
 * back ONLY the ones whose band actually moved, recording one history entry per
 * move with the model's rationale. Items the model leaves alone — the majority,
 * by design — cost nothing and appear nowhere in the history.
 *
 * The caller sends story ids, never priorities: every signal the model sees is
 * read from the database here, so a stale or tampered client cannot influence
 * the ranking it gets back.
 *
 * This is an explicit user action that mutates data — so an AI failure is
 * surfaced as an error the UI can report rather than swallowed into an empty
 * result.
 */
export const reprioritizeStoriesProcedure = tenantProtectedProcedure
	// The org resolved from input feeds both the AI model/credit lookup and the
	// audit row, and `requireProjectPermission` never reads the org — so without
	// this a caller could bill a run against, and write an audit entry into,
	// someone else's organization (SOC 2 CC6.1/CC6.3).
	.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/reprioritize",
		tags: ["Projects", "Stories"],
		summary: "Re-assign priority bands with AI",
		description:
			"Runs an AI pass over the given work items and writes back only the priority bands that changed, recording a history entry with the rationale for each.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** The list the user is looking at, already narrowed by their filters. */
			storyIds: z.array(z.string()).min(1).max(2000),
		}),
	)
	.output(
		z.object({
			// The bands are OUR writes (what applyPriorityChanges recorded), not
			// model output — so unlike the lenient LLM schema above, the enum is
			// exact by construction and gives the client real types.
			changed: z.array(
				z.object({
					storyId: z.string(),
					fromPriority: z.enum(PRIORITY_VALUES),
					toPriority: z.enum(PRIORITY_VALUES),
					rationale: z.string().nullable(),
				}),
			),
			considered: z.number(),
			truncated: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const userId = context.user.id;

		// Load the real signals. Scoping to projectId is what makes an id from
		// another tenant's project match nothing rather than leak.
		const stories = await db.userStory.findMany({
			where: { id: { in: input.storyIds }, projectId: input.projectId },
			select: {
				id: true,
				identifier: true,
				title: true,
				priority: true,
				kind: true,
				draftingStage: true,
				blocked: true,
				blockedReason: true,
				createdAt: true,
			},
			// Deterministic order so the cap always bites the same way for the
			// same input, and so a repeat run is comparable to the last.
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		});

		if (stories.length === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "No work items found to re-prioritize",
			});
		}

		const truncated = stories.length > MAX_REPRIORITIZED_ITEMS;
		const selected = stories.slice(0, MAX_REPRIORITIZED_ITEMS);

		// openDecisions (per-item open-question counts) and the project's
		// confirmed decisions (Decisions tab, shared guidance) are independent —
		// fetch them together so this user-triggered path stays snappy.
		const [openDecisions, decisions] = await Promise.all([
			getOpenDecisionsForStories({
				tenantFilter: {
					organizationId: organizationId ?? null,
					userId,
				},
				projectId: input.projectId,
				userStoryIds: selected.map((s) => s.id),
				// Counts only — the model reasons about how many decisions are
				// open, never their text, so nothing extra is fetched or sent.
				maxPerStory: 0,
			}),
			getAcceptedDecisionsForGuidance({ projectId: input.projectId }),
		]);

		const now = Date.now();
		const candidates: Candidate[] = selected.map((story) =>
			buildCandidate(story, openDecisions.counts[story.id] ?? 0, now),
		);
		const byId = new Map(candidates.map((c) => [c.storyId, c]));

		const generated = await runReprioritizationModel({
			userId,
			organizationId,
			projectId: input.projectId,
			agentName: "priority_reprioritization",
			fallbackBody: PRIORITY_REPRIORITIZATION_PROMPT_FALLBACK_BODY,
			variables: {
				maxRationaleLength: MAX_RATIONALE_LENGTH,
				workItems: formatWorkItems(candidates),
				decisionGuidance: formatDecisionGuidance(decisions),
			},
			schema: ReprioritizationSchema,
			logLabel: "Reprioritization",
			failureMessage:
				"The AI couldn't re-prioritize these items. Please try again.",
		});
		const assignments = generated.assignments ?? [];

		// Normalise in code: drop hallucinated ids and unparseable bands,
		// collapse duplicates. `applyPriorityChanges` then drops the no-ops,
		// which is what keeps the history free of "AI looked at this" rows.
		const seen = new Set<string>();
		const requests = assignments.flatMap((assignment) => {
			const candidate = byId.get(assignment.storyId);
			if (!candidate || seen.has(assignment.storyId)) {
				return [];
			}
			const toPriority = normalisePriority(assignment.priority ?? "");
			if (!toPriority) {
				return [];
			}
			seen.add(assignment.storyId);
			const rationale = assignment.rationale?.trim();
			return [
				{
					storyId: assignment.storyId,
					toPriority,
					reason: rationale
						? clip(rationale, MAX_RATIONALE_LENGTH)
						: null,
				},
			];
		});

		const applied = await applyPriorityChanges(
			input.projectId,
			requests,
			"AI",
			// The run is AI-attributed, but the person who pressed the button is
			// recorded so the trail answers "who triggered this?".
			{ id: userId, name: context.user.name ?? null },
		);

		// Every run is recorded — including one that moved nothing. "Someone ran
		// AI triage over this project" is auditable in itself, and a no-op run
		// with no trace would make the ledger disagree with the billing row the
		// model call already produced. The resource is the PROJECT the run swept
		// (a run is a batch, not an edit of one story); the per-item band moves
		// live in each story's priority history.
		recordAuditFromRequest(context, {
			action: "story.reprioritized",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project",
				id: input.projectId,
				name: null,
			},
			metadata: {
				via: "priority-reprioritize",
				considered: candidates.length,
				changed: applied.length,
				truncated,
			},
		});

		const reasonById = new Map(
			requests.map((r) => [r.storyId, r.reason ?? null]),
		);

		return {
			changed: applied.map((change) => ({
				storyId: change.storyId,
				fromPriority: change.fromPriority,
				toPriority: change.toPriority,
				rationale: reasonById.get(change.storyId) ?? null,
			})),
			considered: candidates.length,
			truncated,
		};
	});

/**
 * Lenient for the same reason as {@link ReprioritizationSchema}: the band is
 * normalised in code, and a missing rationale is a legitimate "leave it alone".
 */
const SingleReprioritizationSchema = z.object({
	priority: z.string(),
	rationale: z.string().optional(),
});

/** Stages whose items the roadmap treats as gone: hidden (CLOSED) or declined.
 * Neither is a candidate for re-prioritization — as a target or as context. */
const INACTIVE_STAGES = ["CLOSED", "DECLINED"] as const;

/**
 * Fallback for the admin-editable `priority_reprioritization_single` prompt.
 * MUST be kept byte-identical to the `priority_reprioritization_single` entry
 * in `packages/database/prisma/seed-prompts-only.ts` — the seeded row is the
 * source of truth that PMs edit in the Prompt Library.
 *
 * `contextItems` is always substituted — the isolated mode passes an explicit
 * "(none)" line rather than relying on template conditionals, so the same
 * prompt serves both modes and stays trivially renderable.
 */
export const PRIORITY_REPRIORITIZATION_SINGLE_PROMPT_FALLBACK_BODY = `You are the delivery lead for an engineering team, re-assessing the priority band of ONE work item.

Use exactly these four bands:
- P0_CRITICAL — production is broken, data or security is at risk, or everything else is waiting on this. Reserve it; a list where everything is P0 is a list with no priorities.
- P1_HIGH — committed work for the current cycle. Real user impact, or it blocks P0 work.
- P2_MEDIUM — genuine value, no deadline pressure. This is the default when nothing argues for moving.
- P3_LOW — nice to have, speculative, or superseded.

Judge the item on the evidence given and nothing else. Do not invent facts, deadlines, customers or severity that the fields do not support.

Weigh these signals, strongest first:
1. An explicit blocker, and what it is blocking.
2. Security, data-loss, privacy and compliance exposure.
3. The team's confirmed decisions, listed below, where they bear on what to build first — a decision to prioritize an area is a reason to raise the items it covers. Decisions tagged PRIORITY are the team's explicit ranking guidance and outweigh untagged ones.
4. Unresolved open questions on the item — many mean it cannot start yet, which usually argues for resolving it rather than raising it.
5. How long it has sat — relative to the peer items, when any are listed below.
6. Its drafting stage — work already specified is cheaper to finish than work not yet started.

The team's confirmed decisions (project guidance — weigh these where they bear on sequencing; they are context, not an instruction to raise every item they touch). Each may carry a PRIORITY and/or long-standing/short-term tag:
{{{decisionGuidance}}}

Keep the item where it is unless the evidence genuinely argues for moving it. Returning the current band is the correct answer when nothing has changed — an unchanged band is recorded as no change at all.

Return the band in priority, and — only if you are changing the band — one sentence of at most {{maxRationaleLength}} characters in rationale saying what evidence moved it. Omit rationale if you are leaving it alone.

The rationale is read by a person in the roadmap, so write it in plain language. Refer to bands as P0/P1/P2/P3, never by their code (write "P2", not "P2_MEDIUM"), and do not mention field names.

Work item to re-assess:
{{{targetItem}}}

Peer work items, for comparison only — never assign bands to these:
{{{contextItems}}}`;

/**
 * `projects.stories.reprioritizeStory` — the sparkle beside a single item's
 * priority controls: one AI pass over ONE work item, applied immediately.
 *
 * Two modes, chosen per click. Isolated (the default) sends only the target's
 * own signals. `withListContext` additionally sends up to
 * {@link MAX_REPRIORITIZED_ITEMS} − 1 active same-kind peers as read-only
 * context — priority is relative, so the model judges better with the list in
 * view — but the peers are never re-banded: only the target's assignment is
 * applied, by construction of the schema (one object, no ids to hallucinate).
 *
 * Unlike the batch run, completed (final-status) and hidden/declined items are
 * excluded — as context AND as target. Re-banding finished work is noise, and
 * the batch run only tolerates it for continuity with the list on screen.
 */
export const reprioritizeStoryProcedure = tenantProtectedProcedure
	// Same pairing as the batch run, for the same SOC 2 reason: the input org
	// feeds the AI credit lookup and the audit row.
	.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/reprioritize",
		tags: ["Projects", "Stories"],
		summary: "Re-assess one work item's priority band with AI",
		description:
			"Runs an AI pass over a single work item — optionally weighing it against the active list — and applies the band immediately, recording a history entry with the rationale when it moves.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string(),
			/** Send up to 99 active same-kind peers as read-only context. */
			withListContext: z.boolean().optional().default(false),
		}),
	)
	.output(
		z.object({
			changed: z.boolean(),
			// Null when the model kept the current band (changed: false).
			fromPriority: z.enum(PRIORITY_VALUES).nullable(),
			toPriority: z.enum(PRIORITY_VALUES).nullable(),
			rationale: z.string().nullable(),
			/** Target + however many peers were sent as context. */
			considered: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const userId = context.user.id;

		const target = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				id: true,
				identifier: true,
				title: true,
				priority: true,
				kind: true,
				draftingStage: true,
				statusId: true,
				blocked: true,
				blockedReason: true,
				createdAt: true,
			},
		});
		if (!target) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found",
			});
		}

		const finalStatusIds = (
			await db.projectStoryStatus.findMany({
				where: { projectId: input.projectId, isFinal: true },
				select: { id: true },
			})
		).map((status) => status.id);

		// The UI hides the sparkle on these; the check here is what makes that a
		// rule rather than a styling choice.
		if (
			(INACTIVE_STAGES as readonly string[]).includes(
				target.draftingStage,
			) ||
			finalStatusIds.includes(target.statusId)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Completed or hidden work items are not re-prioritized.",
			});
		}

		const peers = input.withListContext
			? await db.userStory.findMany({
					where: {
						projectId: input.projectId,
						kind: target.kind,
						id: { not: target.id },
						draftingStage: { notIn: [...INACTIVE_STAGES] },
						...(finalStatusIds.length > 0
							? { statusId: { notIn: finalStatusIds } }
							: {}),
					},
					select: {
						id: true,
						identifier: true,
						title: true,
						priority: true,
						kind: true,
						draftingStage: true,
						blocked: true,
						blockedReason: true,
						createdAt: true,
					},
					// Same deterministic order as the batch run, so repeat clicks
					// see the same context and the cap always bites the same way.
					orderBy: [{ createdAt: "asc" }, { id: "asc" }],
					take: MAX_REPRIORITIZED_ITEMS - 1,
				})
			: [];

		const [openDecisions, decisions] = await Promise.all([
			getOpenDecisionsForStories({
				tenantFilter: {
					organizationId: organizationId ?? null,
					userId,
				},
				projectId: input.projectId,
				userStoryIds: [target.id, ...peers.map((peer) => peer.id)],
				maxPerStory: 0,
			}),
			getAcceptedDecisionsForGuidance({ projectId: input.projectId }),
		]);

		const now = Date.now();

		const assignment = await runReprioritizationModel({
			userId,
			organizationId,
			projectId: input.projectId,
			agentName: "priority_reprioritization_single",
			fallbackBody: PRIORITY_REPRIORITIZATION_SINGLE_PROMPT_FALLBACK_BODY,
			variables: {
				maxRationaleLength: MAX_RATIONALE_LENGTH,
				targetItem: formatWorkItems([
					buildCandidate(
						target,
						openDecisions.counts[target.id] ?? 0,
						now,
					),
				]),
				contextItems:
					peers.length > 0
						? formatWorkItems(
								peers.map((peer) =>
									buildCandidate(
										peer,
										openDecisions.counts[peer.id] ?? 0,
										now,
									),
								),
							)
						: "(none — judge the item on its own signals)",
				decisionGuidance: formatDecisionGuidance(decisions),
			},
			schema: SingleReprioritizationSchema,
			logLabel: "Single reprioritization",
			logContext: { storyId: input.storyId },
			failureMessage:
				"The AI couldn't re-assess this item. Please try again.",
		});

		const toPriority = normalisePriority(assignment.priority ?? "");
		if (!toPriority) {
			// The user clicked an explicit action; an unparseable band is a
			// failed assessment, not a "no change" — surface it as retryable.
			logger.error("Single reprioritization returned no usable band", {
				projectId: input.projectId,
				storyId: input.storyId,
				raw: assignment.priority,
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"The AI couldn't re-assess this item. Please try again.",
			});
		}

		const rationale = assignment.rationale?.trim();
		const reason = rationale ? clip(rationale, MAX_RATIONALE_LENGTH) : null;

		const applied = await applyPriorityChanges(
			input.projectId,
			[{ storyId: target.id, toPriority, reason }],
			"AI",
			{ id: userId, name: context.user.name ?? null },
		);

		// Same closed action key and resource shape as the batch run — a single-
		// item pass is still an AI re-prioritization run over the project, just a
		// run of one; `via` + `storyId` in the metadata carry the distinction.
		recordAuditFromRequest(context, {
			action: "story.reprioritized",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: {
				via: "priority-reprioritize-single",
				storyId: target.id,
				withListContext: input.withListContext,
				considered: 1 + peers.length,
				changed: applied.length,
			},
		});

		const change = applied[0] ?? null;
		return {
			changed: change !== null,
			fromPriority: change?.fromPriority ?? null,
			toPriority: change?.toPriority ?? null,
			rationale: change ? reason : null,
			considered: 1 + peers.length,
		};
	});
