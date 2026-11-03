/**
 * Project knowledge hub (specs/2026-10-21-ai-artifacts-hub §5.5–5.6).
 *
 * Knowledge produced by engineers' AI tools is stored as immutable,
 * append-only entries grouped by topic. Many authors can write to one topic
 * concurrently without conflicts: nothing is edited in place, a correction is
 * a new entry that supersedes an older one, and the topic's living document is
 * a generated summary (KnowledgeTopicSummary).
 *
 * Every table is USER_OWNED and project-scoped: writes copy the parent
 * project's tenancy (userId + organizationId) verbatim, reads always filter by
 * projectId. Callers resolve project access before calling in.
 */

import { createHash } from "node:crypto";
import {
	db,
	type KnowledgeArtifactType,
	type KnowledgeEntry,
	type KnowledgeSummaryBehavior,
	type KnowledgeTopic,
	type KnowledgeTopicSummary,
	type KnowledgeVisibility,
	type Prisma,
} from "../client";

/** Project tenancy, copied verbatim from the parent Project. */
export type KnowledgeTenancy = {
	userId: string;
	organizationId: string | null;
};

export type BuiltInKnowledgeType = {
	key: string;
	name: string;
	description: string;
	template: string;
	summaryBehavior: KnowledgeSummaryBehavior;
};

/**
 * Types every project starts with. Admins may edit them; their keys are
 * stable so the plugin skill and the summary can rely on them.
 */
export const BUILT_IN_KNOWLEDGE_TYPES: BuiltInKnowledgeType[] = [
	{
		key: "note",
		name: "Note",
		description:
			"A short piece of context worth keeping: a detail, a gotcha, a link, a fact the team should know.",
		template: "",
		summaryBehavior: "MERGE",
	},
	{
		key: "spec",
		name: "Spec",
		description:
			"A design or implementation spec for the topic: goal, approach, scope, open questions.",
		template:
			"## Goal\n\n## Approach\n\n## Scope\n\n## Out of scope\n\n## Open questions\n",
		summaryBehavior: "MERGE",
	},
	{
		key: "investigation",
		name: "Investigation",
		description:
			"What was looked into and what was found: symptoms, hypotheses, evidence, conclusion.",
		template:
			"## Question\n\n## What I checked\n\n## Findings\n\n## Conclusion\n",
		summaryBehavior: "MERGE",
	},
	{
		key: "decision",
		name: "Decision",
		description:
			"A decision taken while working, with the options considered and the reason.",
		template: "## Decision\n\n## Options considered\n\n## Why\n",
		summaryBehavior: "MERGE",
	},
	{
		key: "journal",
		name: "Journal",
		description:
			"A dated log of progress on the topic: what was done, what is next.",
		template: "## Done\n\n## Next\n",
		summaryBehavior: "MERGE",
	},
	{
		key: "handoff",
		name: "Handoff",
		description:
			"Where the work stands when someone stops or hands it over: state, next steps, risks. The newest handoff is what a person picking the work up reads first.",
		template:
			"## Current state\n\n## Next steps\n\n## Risks and open questions\n",
		summaryBehavior: "LATEST_WINS",
	},
	{
		key: "test-plan",
		name: "Test plan",
		description: "What to test for the topic and how; test results.",
		template: "## Scenarios\n\n## Data and setup\n\n## Results\n",
		summaryBehavior: "MERGE",
	},
	{
		key: "bug-analysis",
		name: "Bug analysis",
		description:
			"Analysis of a defect: reproduction, root cause, fix, regression risk.",
		template:
			"## Reproduction\n\n## Root cause\n\n## Fix\n\n## Regression risk\n",
		summaryBehavior: "MERGE",
	},
	{
		key: "meeting-notes",
		name: "Meeting notes",
		description:
			"Notes from a discussion about the topic: points, decisions, actions.",
		template: "## Points\n\n## Decisions\n\n## Actions\n",
		summaryBehavior: "MERGE",
	},
];

/** Allowed shape of a type key or a free-topic slug. */
export const KNOWLEDGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** Turns free text into a topic slug ("US developer journey" → "us-developer-journey"). */
export function slugifyKnowledgeKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/-+$/, "")
		.slice(0, 80);
}

/** Normalises a mirrored file path: forward slashes, no leading "./" or "/". */
export function normalizeKnowledgeSourcePath(
	value: string | null | undefined,
): string | null {
	const path = value
		?.trim()
		.replace(/\\/g, "/")
		.replace(/^(\.\/|\/)+/, "")
		.replace(/\/{2,}/g, "/");
	if (!path) {
		return null;
	}
	if (path.length > 512 || path.split("/").some((part) => part === "..")) {
		throw new KnowledgeInputError(
			"EMPTY",
			"sourcePath must be a relative path of at most 512 characters without '..'.",
		);
	}
	return path;
}

export function knowledgeContentHash(title: string, body: string): string {
	return createHash("sha256").update(`${title}\n\n${body}`).digest("hex");
}

/** The project's tenancy, or null when the project does not exist (or is deleted). */
export async function getKnowledgeProjectTenancy(
	projectId: string,
): Promise<KnowledgeTenancy | null> {
	const project = await db.project.findFirst({
		where: { id: projectId, deletedAt: null },
		select: { userId: true, organizationId: true },
	});
	return project
		? { userId: project.userId, organizationId: project.organizationId }
		: null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Creates the built-in types a project does not have yet. Idempotent and safe
 * to race: an existing key is left as the admin last edited it.
 */
export async function ensureBuiltInKnowledgeTypes(
	projectId: string,
	tenancy: KnowledgeTenancy,
): Promise<void> {
	const existing = await db.knowledgeArtifactType.findMany({
		where: { projectId },
		select: { key: true },
	});
	const have = new Set(existing.map((row) => row.key));
	const missing = BUILT_IN_KNOWLEDGE_TYPES.filter((t) => !have.has(t.key));
	if (missing.length === 0) {
		return;
	}
	await db.knowledgeArtifactType.createMany({
		data: missing.map((t) => ({
			projectId,
			key: t.key,
			name: t.name,
			description: t.description,
			template: t.template || null,
			summaryBehavior: t.summaryBehavior,
			builtIn: true,
			userId: tenancy.userId,
			organizationId: tenancy.organizationId,
		})),
		skipDuplicates: true,
	});
}

export async function listKnowledgeTypes(
	projectId: string,
	tenancy: KnowledgeTenancy,
	options: { includeArchived?: boolean } = {},
): Promise<KnowledgeArtifactType[]> {
	await ensureBuiltInKnowledgeTypes(projectId, tenancy);
	return db.knowledgeArtifactType.findMany({
		where: {
			projectId,
			...(options.includeArchived ? {} : { archivedAt: null }),
		},
		orderBy: [{ builtIn: "desc" }, { name: "asc" }],
	});
}

export type KnowledgeTypeInput = {
	key: string;
	name: string;
	description: string;
	template?: string | null;
	fieldSchema?: Prisma.InputJsonValue | null;
	summaryBehavior?: KnowledgeSummaryBehavior;
	visibility?: KnowledgeVisibility;
	retentionDays?: number | null;
};

/** Creates a custom type or updates an existing one (built-in or custom) by key. */
export async function upsertKnowledgeType(
	projectId: string,
	tenancy: KnowledgeTenancy,
	input: KnowledgeTypeInput,
	editorUserId: string,
): Promise<KnowledgeArtifactType> {
	const data = {
		name: input.name,
		description: input.description,
		template: input.template ?? null,
		fieldSchema:
			input.fieldSchema === null || input.fieldSchema === undefined
				? undefined
				: input.fieldSchema,
		summaryBehavior: input.summaryBehavior ?? "MERGE",
		visibility: input.visibility ?? "MEMBERS",
		retentionDays: input.retentionDays ?? null,
		updatedByUserId: editorUserId,
		archivedAt: null,
	};
	return db.knowledgeArtifactType.upsert({
		where: { projectId_key: { projectId, key: input.key } },
		create: {
			projectId,
			key: input.key,
			...data,
			builtIn: false,
			userId: tenancy.userId,
			organizationId: tenancy.organizationId,
		},
		update: data,
	});
}

/** Hides a type from new entries; its existing entries stay readable. */
export async function archiveKnowledgeType(
	projectId: string,
	key: string,
	editorUserId: string,
): Promise<boolean> {
	const result = await db.knowledgeArtifactType.updateMany({
		where: { projectId, key, archivedAt: null },
		data: { archivedAt: new Date(), updatedByUserId: editorUserId },
	});
	return result.count > 0;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export type ResolvedTopicRef =
	| {
			kind: "WORK_ITEM";
			key: string;
			userStoryId: string;
			title: string;
			externalRef: string | null;
	  }
	| {
			kind: "WORK_ITEM";
			key: string;
			userStoryId: null;
			title: string;
			externalRef: string;
	  }
	| { kind: "FREE"; key: string; title: string };

/**
 * Resolves what a topic reference names, without writing anything:
 * - a story of this project, by Fabric id, identifier ("US-012") or external
 *   id (an ADO/Jira/Linear id such as "12345"), becomes `story:<id>`;
 * - something that looks like a work-item id but matches no story ("12345",
 *   "ADO-12345", "#12345") becomes `ext:<ref>`;
 * - anything else is a free topic keyed by its slug.
 */
export async function resolveKnowledgeTopicRef(
	projectId: string,
	reference: string,
	title?: string,
): Promise<ResolvedTopicRef> {
	const raw = reference.trim();
	const bare = raw.replace(/^#/, "");
	const story = await db.userStory.findFirst({
		where: {
			projectId,
			OR: [
				{ id: bare },
				{ identifier: { equals: bare, mode: "insensitive" } },
				{ externalId: bare },
			],
		},
		select: { id: true, identifier: true, title: true, externalId: true },
	});
	if (story) {
		return {
			kind: "WORK_ITEM",
			key: `story:${story.id}`,
			userStoryId: story.id,
			title: title?.trim() || `${story.identifier}: ${story.title}`,
			externalRef: story.externalId,
		};
	}
	if (/^([A-Za-z]{1,10}-)?\d{1,12}$/.test(bare)) {
		return {
			kind: "WORK_ITEM",
			key: `ext:${bare.toLowerCase()}`,
			userStoryId: null,
			title: title?.trim() || bare,
			externalRef: bare,
		};
	}
	const slug = slugifyKnowledgeKey(raw);
	if (!KNOWLEDGE_KEY_PATTERN.test(slug)) {
		throw new KnowledgeInputError(
			"TOPIC_INVALID",
			`"${reference}" is not a usable topic: give a work-item id or a short name.`,
		);
	}
	return { kind: "FREE", key: slug, title: title?.trim() || raw };
}

export async function findKnowledgeTopic(
	projectId: string,
	reference: string,
): Promise<KnowledgeTopic | null> {
	const byId = await db.knowledgeTopic.findFirst({
		where: { projectId, id: reference },
	});
	if (byId) {
		return byId;
	}
	const resolved = await resolveKnowledgeTopicRef(projectId, reference);
	return db.knowledgeTopic.findUnique({
		where: { projectId_key: { projectId, key: resolved.key } },
	});
}

async function getOrCreateTopic(
	projectId: string,
	tenancy: KnowledgeTenancy,
	reference: string,
	title: string | undefined,
	actorUserId: string,
): Promise<KnowledgeTopic> {
	const resolved = await resolveKnowledgeTopicRef(
		projectId,
		reference,
		title,
	);
	return db.knowledgeTopic.upsert({
		where: { projectId_key: { projectId, key: resolved.key } },
		create: {
			projectId,
			key: resolved.key,
			title: resolved.title,
			kind: resolved.kind,
			userStoryId:
				resolved.kind === "WORK_ITEM" ? resolved.userStoryId : null,
			externalRef:
				resolved.kind === "WORK_ITEM" ? resolved.externalRef : null,
			createdByUserId: actorUserId,
			userId: tenancy.userId,
			organizationId: tenancy.organizationId,
		},
		update: {},
	});
}

export async function listKnowledgeTopics(
	projectId: string,
	options: {
		query?: string;
		authorUserId?: string;
		limit?: number;
		cursor?: string;
	} = {},
): Promise<{ topics: KnowledgeTopic[]; nextCursor: string | null }> {
	const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
	const where: Prisma.KnowledgeTopicWhereInput = {
		projectId,
		...(options.query
			? {
					OR: [
						{
							title: {
								contains: options.query,
								mode: "insensitive",
							},
						},
						{ key: { contains: options.query.toLowerCase() } },
						{
							externalRef: {
								contains: options.query,
								mode: "insensitive",
							},
						},
					],
				}
			: {}),
		...(options.authorUserId
			? { entries: { some: { authorUserId: options.authorUserId } } }
			: {}),
	};
	const rows = await db.knowledgeTopic.findMany({
		where,
		orderBy: [
			{ lastEntryAt: { sort: "desc", nulls: "last" } },
			{ id: "asc" },
		],
		take: limit + 1,
		...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
	});
	const hasMore = rows.length > limit;
	const topics = hasMore ? rows.slice(0, limit) : rows;
	return {
		topics,
		nextCursor: hasMore ? (topics[topics.length - 1]?.id ?? null) : null,
	};
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export class KnowledgeInputError extends Error {
	constructor(
		readonly code:
			| "TOPIC_INVALID"
			| "TYPE_UNKNOWN"
			| "TYPE_ARCHIVED"
			| "FIELDS_INVALID"
			| "SUPERSEDES_INVALID"
			| "EMPTY",
		message: string,
	) {
		super(message);
		this.name = "KnowledgeInputError";
	}
}

export type AddKnowledgeEntryInput = {
	projectId: string;
	tenancy: KnowledgeTenancy;
	authorUserId: string;
	topic: string;
	topicTitle?: string;
	typeKey: string;
	title: string;
	body: string;
	fields?: Prisma.InputJsonValue | null;
	role?: string | null;
	agentClient?: string | null;
	supersedesId?: string | null;
	/**
	 * The file this entry mirrors (e.g. "specs/x/spec.md"). Saving the same
	 * path on the topic again records a new version that supersedes the
	 * newest earlier one; identical content is a no-op.
	 */
	sourcePath?: string | null;
};

export type AddKnowledgeEntryResult = {
	entry: KnowledgeEntry;
	topic: KnowledgeTopic;
	type: KnowledgeArtifactType;
	/** True when an identical entry by the same author already existed (a retry). */
	duplicate: boolean;
};

/**
 * Appends an entry, creating the topic on first use. A retry of the same
 * entry (same topic, type, author, title and body) returns the existing row
 * instead of a second copy.
 */
export async function addKnowledgeEntry(
	input: AddKnowledgeEntryInput,
	validateFields?: (
		schema: Prisma.JsonValue,
		fields: Prisma.InputJsonValue | null | undefined,
	) => string | null,
): Promise<AddKnowledgeEntryResult> {
	const title = input.title.trim();
	const body = input.body.trim();
	if (!title || !body) {
		throw new KnowledgeInputError(
			"EMPTY",
			"An entry needs a title and a body.",
		);
	}
	await ensureBuiltInKnowledgeTypes(input.projectId, input.tenancy);
	const type = await db.knowledgeArtifactType.findUnique({
		where: {
			projectId_key: { projectId: input.projectId, key: input.typeKey },
		},
	});
	if (!type) {
		throw new KnowledgeInputError(
			"TYPE_UNKNOWN",
			`Unknown knowledge type "${input.typeKey}". List the project's types first.`,
		);
	}
	if (type.archivedAt) {
		throw new KnowledgeInputError(
			"TYPE_ARCHIVED",
			`The knowledge type "${input.typeKey}" is archived.`,
		);
	}
	if (type.fieldSchema && validateFields) {
		const problem = validateFields(type.fieldSchema, input.fields);
		if (problem) {
			throw new KnowledgeInputError("FIELDS_INVALID", problem);
		}
	}

	const topic = await getOrCreateTopic(
		input.projectId,
		input.tenancy,
		input.topic,
		input.topicTitle,
		input.authorUserId,
	);

	const sourcePath = normalizeKnowledgeSourcePath(input.sourcePath);
	let supersedesId = input.supersedesId ?? null;
	if (sourcePath && !supersedesId) {
		const previous = await db.knowledgeEntry.findFirst({
			where: { topicId: topic.id, sourcePath, supersededBy: null },
			orderBy: { createdAt: "desc" },
		});
		if (previous) {
			if (previous.contentHash === knowledgeContentHash(title, body)) {
				return { entry: previous, topic, type, duplicate: true };
			}
			supersedesId = previous.id;
		}
	}

	if (supersedesId) {
		const target = await db.knowledgeEntry.findFirst({
			where: { id: supersedesId, projectId: input.projectId },
			select: { topicId: true, supersededBy: { select: { id: true } } },
		});
		if (!target || target.topicId !== topic.id) {
			throw new KnowledgeInputError(
				"SUPERSEDES_INVALID",
				"The entry to supersede must be an entry of the same topic.",
			);
		}
		if (target.supersededBy) {
			throw new KnowledgeInputError(
				"SUPERSEDES_INVALID",
				`That entry was already superseded by ${target.supersededBy.id}; supersede the newer one.`,
			);
		}
	}

	const contentHash = knowledgeContentHash(title, body);
	const existing = await db.knowledgeEntry.findFirst({
		where: {
			topicId: topic.id,
			typeId: type.id,
			authorUserId: input.authorUserId,
			contentHash,
		},
	});
	if (existing) {
		return { entry: existing, topic, type, duplicate: true };
	}

	const entry = await db.$transaction(async (tx) => {
		const created = await tx.knowledgeEntry.create({
			data: {
				projectId: input.projectId,
				topicId: topic.id,
				typeId: type.id,
				authorUserId: input.authorUserId,
				agentClient: input.agentClient ?? null,
				role: input.role?.trim() || null,
				title,
				body,
				fields:
					input.fields === null || input.fields === undefined
						? undefined
						: input.fields,
				contentHash,
				supersedesId,
				sourcePath,
				userId: input.tenancy.userId,
				organizationId: input.tenancy.organizationId,
			},
		});
		await tx.knowledgeTopic.update({
			where: { id: topic.id },
			data: {
				entryCount: { increment: 1 },
				lastEntryAt: created.createdAt,
			},
		});
		return created;
	});
	return { entry, topic, type, duplicate: false };
}

export type KnowledgeTimelineEntry = KnowledgeEntry & {
	type: Pick<KnowledgeArtifactType, "key" | "name" | "summaryBehavior">;
	supersededBy: { id: string } | null;
};

/** A topic's entries, oldest first (time order), paged. */
export async function getKnowledgeTimeline(
	projectId: string,
	topicId: string,
	options: { limit?: number; cursor?: string; newestFirst?: boolean } = {},
): Promise<{ entries: KnowledgeTimelineEntry[]; nextCursor: string | null }> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const rows = await db.knowledgeEntry.findMany({
		where: { projectId, topicId },
		include: {
			type: { select: { key: true, name: true, summaryBehavior: true } },
			supersededBy: { select: { id: true } },
		},
		orderBy: [
			{ createdAt: options.newestFirst ? "desc" : "asc" },
			{ id: "asc" },
		],
		take: limit + 1,
		...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
	});
	const hasMore = rows.length > limit;
	const entries = hasMore ? rows.slice(0, limit) : rows;
	return {
		entries,
		nextCursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
	};
}

export async function getKnowledgeEntry(
	projectId: string,
	entryId: string,
): Promise<KnowledgeTimelineEntry | null> {
	return db.knowledgeEntry.findFirst({
		where: { projectId, id: entryId },
		include: {
			type: { select: { key: true, name: true, summaryBehavior: true } },
			supersededBy: { select: { id: true } },
		},
	});
}

/** Entries the embedding step has not covered yet (oldest first). */
export async function listUnembeddedKnowledgeEntries(
	projectId: string,
	limit = 100,
): Promise<KnowledgeEntry[]> {
	return db.knowledgeEntry.findMany({
		where: { projectId, embeddedAt: null },
		orderBy: { createdAt: "asc" },
		take: limit,
	});
}

export async function markKnowledgeEntryEmbedded(
	entryId: string,
	qdrantId: string,
): Promise<void> {
	await db.knowledgeEntry.update({
		where: { id: entryId },
		data: { qdrantId, embeddedAt: new Date() },
	});
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export async function getLatestKnowledgeTopicSummary(
	projectId: string,
	topicId: string,
): Promise<KnowledgeTopicSummary | null> {
	return db.knowledgeTopicSummary.findFirst({
		where: { projectId, topicId, status: "COMPLETED" },
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Entries a summary is built from: superseded entries are left out, a
 * LATEST_WINS type keeps only its newest entry, EXCLUDED types are skipped,
 * and retention hides entries older than their type allows.
 */
export async function getKnowledgeEntriesForSummary(
	projectId: string,
	topicId: string,
	limit = 400,
): Promise<KnowledgeTimelineEntry[]> {
	const rows = await db.knowledgeEntry.findMany({
		where: {
			projectId,
			topicId,
			supersededBy: null,
			type: { summaryBehavior: { not: "EXCLUDED" } },
		},
		include: {
			type: {
				select: {
					key: true,
					name: true,
					summaryBehavior: true,
					retentionDays: true,
				},
			},
			supersededBy: { select: { id: true } },
		},
		orderBy: [{ createdAt: "desc" }, { id: "asc" }],
		take: limit,
	});
	const now = Date.now();
	const seenLatestWins = new Set<string>();
	const kept = rows.filter((row) => {
		const retention = row.type.retentionDays;
		if (
			retention &&
			now - row.createdAt.getTime() > retention * 86_400_000
		) {
			return false;
		}
		if (row.type.summaryBehavior === "LATEST_WINS") {
			if (seenLatestWins.has(row.typeId)) {
				return false;
			}
			seenLatestWins.add(row.typeId);
		}
		return true;
	});
	return kept.reverse();
}

export async function createKnowledgeTopicSummary(
	projectId: string,
	topicId: string,
	tenancy: KnowledgeTenancy,
): Promise<KnowledgeTopicSummary> {
	return db.knowledgeTopicSummary.create({
		data: {
			projectId,
			topicId,
			status: "RUNNING",
			userId: tenancy.userId,
			organizationId: tenancy.organizationId,
		},
	});
}

export async function completeKnowledgeTopicSummary(
	summaryId: string,
	result:
		| {
				ok: true;
				content: string;
				coveredThrough: Date | null;
				entryCount: number;
				references: Prisma.InputJsonValue;
				model: string | null;
		  }
		| { ok: false; error: string },
): Promise<KnowledgeTopicSummary> {
	return db.knowledgeTopicSummary.update({
		where: { id: summaryId },
		data: result.ok
			? {
					status: "COMPLETED",
					content: result.content,
					coveredThrough: result.coveredThrough,
					entryCount: result.entryCount,
					references: result.references,
					model: result.model,
					error: null,
				}
			: { status: "FAILED", error: result.error.slice(0, 4000) },
	});
}
