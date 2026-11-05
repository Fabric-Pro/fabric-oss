/**
 * Skill runtime loader.
 *
 * Exposes the Skill catalog (DB) + SkillFile assets (S3) to AI chat and
 * document generation surfaces. Follows the Anthropic Agent Skills
 * progressive-disclosure contract:
 *   - listAvailableSkills  → registry (system prompt block, list_skills tool)
 *   - loadSkillBundle      → full SKILL.md + manifest (load_skill tool)
 *   - readSkillFile        → file bytes (read_skill_file tool, eager inline)
 *
 * Published builtins and current-organization skills are readable after a live
 * membership check. Automatic discovery additionally requires agent availability.
 * Only immutable file bytes are cached; each cache hit repeats current source ACLs.
 */

import { createHash } from "node:crypto";
import { config } from "@repo/config";
import {
	db,
	hasPermission,
	Permissions,
	skillVisibilityWhere,
} from "@repo/database";
import { logger } from "@repo/logs";
import { resolveOrgPermissions } from "@repo/permissions";
import { downloadFile } from "@repo/storage";

export interface SkillContext {
	userId?: string | null;
	organizationId?: string | null;
}

export interface SkillReadOptions {
	/** Recheck publication and visibility rather than using a process-local cache. */
	fresh?: boolean;
	expectedVersion?: number;
}

export interface SkillFileManifestEntry {
	path: string;
	contentType: string;
	sizeBytes: number;
}

export interface SkillSummary {
	slug: string;
	name: string;
	description: string;
	version: number;
	category: string | null;
	tags: string[];
	files: SkillFileManifestEntry[];
}

export interface SkillBundle extends SkillSummary {
	/** SKILL.md body with YAML frontmatter stripped. */
	skillMd: string;
}

export interface SkillFileContent {
	path: string;
	contentType: string;
	encoding: "utf-8" | "base64";
	data: string;
	sizeBytes: number;
}

/** Max bytes returned in a single read_skill_file call. Larger files must be streamed out of band. */
export const MAX_SKILL_FILE_READ_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Frontmatter strip
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function stripFrontmatter(skillMd: string): string {
	return skillMd.replace(FRONTMATTER_RE, "");
}

// ---------------------------------------------------------------------------
// Cache (in-process, per Node instance)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

class TTLCache<T> {
	private store = new Map<string, CacheEntry<T>>();

	get(key: string): T | undefined {
		const entry = this.store.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt < Date.now()) {
			this.store.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: T): void {
		this.store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	}

	invalidate(prefix: string): void {
		for (const key of this.store.keys()) {
			if (key.startsWith(prefix)) {
				this.store.delete(key);
			}
		}
	}
}

const summariesCache = new TTLCache<SkillSummary[]>();
const bundleCache = new TTLCache<SkillBundle>();
const fileCache = new TTLCache<SkillFileContent>();

export function invalidateSkillCache(): void {
	summariesCache.invalidate("");
	bundleCache.invalidate("");
	fileCache.invalidate("");
}

function tenantKey(ctx: SkillContext) {
	return `org:${ctx.organizationId ?? ""}:actor:${ctx.userId ?? ""}`;
}
/** Permissions are deliberately never cached with skill bytes. */
async function assertCurrentSkillAccess(ctx: SkillContext) {
	if (!ctx.organizationId || !ctx.userId) {
		throw new Error(
			"A current organization and member are required to load skills.",
		);
	}
	const member = await db.member.findFirst({
		where: {
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			organization: { deletedAt: null },
		},
		select: { role: true },
	});
	if (
		!member ||
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.SKILL_READ,
		)
	) {
		throw new Error("Current skill access is unavailable.");
	}
}
function scopeWhere(ctx: SkillContext, discover = false) {
	if (!discover) {
		return skillVisibilityWhere({
			userId: ctx.userId ?? undefined,
			organizationId: ctx.organizationId,
		});
	}
	return {
		isPublished: true,
		archivedAt: null,
		OR: [
			{ scope: "SYSTEM" as const, userId: null, organizationId: null },
			{
				scope: "ORGANIZATION" as const,
				organizationId: ctx.organizationId ?? "",
				...(discover ? { isDiscoverable: true } : {}),
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listAvailableSkills(
	ctx: SkillContext,
): Promise<SkillSummary[]> {
	await assertCurrentSkillAccess(ctx);

	const skills = await db.skill.findMany({
		where: scopeWhere(ctx, true),
		select: {
			slug: true,
			name: true,
			description: true,
			version: true,
			category: true,
			tags: true,
			files: {
				select: { path: true, contentType: true, sizeBytes: true },
				orderBy: { path: "asc" },
			},
		},
		orderBy: { slug: "asc" },
	});

	const summaries: SkillSummary[] = skills.map((s) => ({
		slug: s.slug,
		name: s.name,
		description: s.description,
		version: s.version,
		category: s.category,
		tags: s.tags,
		files: s.files.map((f) => ({
			path: f.path,
			contentType: f.contentType,
			sizeBytes: f.sizeBytes,
		})),
	}));

	await assertCurrentSkillAccess(ctx);
	return summaries;
}

/** Slugs are aliases, not authority: reject a readable duplicate before any body read. */
async function resolveSkillAlias(slug: string, ctx: SkillContext) {
	const matches = await db.skill.findMany({
		where: { ...scopeWhere(ctx), slug },
		select: { id: true, version: true },
		take: 2,
	});
	if (matches.length > 1) {
		throw new Error(
			"This skill identifier is ambiguous. Use a unique skill identifier before loading it.",
		);
	}
	if (!matches[0]) {
		throw new Error("Skill not found or not accessible in this scope.");
	}
	return matches[0];
}
export async function loadSkillBundle(
	slug: string,
	ctx: SkillContext,
	options: SkillReadOptions = {},
): Promise<SkillBundle> {
	await assertCurrentSkillAccess(ctx);
	const selected = await resolveSkillAlias(slug, ctx);
	const skill = await db.skill.findFirst({
		where: {
			...scopeWhere(ctx),
			id: selected.id,
			...(options.expectedVersion === undefined
				? {}
				: { version: options.expectedVersion }),
		},
		include: {
			files: {
				select: { path: true, contentType: true, sizeBytes: true },
				orderBy: { path: "asc" },
			},
		},
	});

	if (!skill) {
		throw new Error(
			`Skill "${slug}" not found or not accessible in this scope`,
		);
	}

	const bundle: SkillBundle = {
		slug: skill.slug,
		name: skill.name,
		description: skill.description,
		version: skill.version,
		category: skill.category,
		tags: skill.tags,
		skillMd: stripFrontmatter(skill.content),
		files: skill.files.map((f) => ({
			path: f.path,
			contentType: f.contentType,
			sizeBytes: f.sizeBytes,
		})),
	};

	await assertCurrentSkillAccess(ctx);
	if (
		!(await db.skill.findFirst({
			where: { ...scopeWhere(ctx), id: skill.id, version: skill.version },
			select: { id: true },
		}))
	) {
		throw new Error("Skill access or its saved revision changed.");
	}
	if ((await resolveSkillAlias(slug, ctx)).id !== selected.id) {
		throw new Error("Skill identity changed during read.");
	}
	return bundle;
}

export async function readSkillFile(
	slug: string,
	path: string,
	ctx: SkillContext,
	options: SkillReadOptions = {},
): Promise<SkillFileContent> {
	await assertCurrentSkillAccess(ctx);
	const selected = await resolveSkillAlias(slug, ctx);
	const file = await db.skillFile.findFirst({
		where: {
			path,
			skill: {
				...scopeWhere(ctx),
				id: selected.id,
				...(options.expectedVersion === undefined
					? {}
					: { version: options.expectedVersion }),
			},
		},
		include: { skill: { select: { version: true } } },
	});
	if (!file) {
		throw new Error(
			`File "${path}" not found in skill "${slug}" or skill is not accessible in this scope`,
		);
	}

	if (file.sizeBytes > MAX_SKILL_FILE_READ_BYTES) {
		throw new Error(
			`File "${path}" in skill "${slug}" is ${file.sizeBytes} bytes; exceeds per-call limit of ${MAX_SKILL_FILE_READ_BYTES}. Use a download URL instead.`,
		);
	}

	const cacheKey = `file:${tenantKey(ctx)}:${file.id}:${file.version}:${file.sha256}:${file.skill.version}`;
	const revalidate = async () => {
		await assertCurrentSkillAccess(ctx);
		if ((await resolveSkillAlias(slug, ctx)).id !== selected.id) {
			throw new Error("Skill identity changed during read.");
		}
		if (
			!(await db.skillFile.findFirst({
				where: {
					id: file.id,
					version: file.version,
					sha256: file.sha256,
					skill: {
						...scopeWhere(ctx),
						id: selected.id,
						version: file.skill.version,
					},
				},
				select: { id: true },
			}))
		) {
			throw new Error("Skill access or its file revision changed.");
		}
	};
	const cached = fileCache.get(cacheKey);
	if (cached && !options.fresh) {
		await revalidate();
		return cached;
	}
	const bucket = config.storage.bucketNames.skills;
	const { data, contentType } = await downloadFile(file.storageKey, {
		bucket,
	});

	if (
		data.length !== file.sizeBytes ||
		createHash("sha256").update(data).digest("hex") !== file.sha256
	) {
		throw new Error(
			"Skill file content does not match its saved revision.",
		);
	}
	await revalidate();
	const isText = isTextContentType(file.contentType || contentType);
	const result: SkillFileContent = {
		path,
		contentType: file.contentType,
		encoding: isText ? "utf-8" : "base64",
		data: isText ? data.toString("utf-8") : data.toString("base64"),
		sizeBytes: file.sizeBytes,
	};

	fileCache.set(cacheKey, result);
	logger.debug(`[skills] Loaded file ${slug}:${path} (${file.sizeBytes}B)`);
	return result;
}

export function isTextContentType(contentType: string): boolean {
	return (
		contentType.startsWith("text/") ||
		contentType.includes("json") ||
		contentType.includes("xml") ||
		contentType.includes("javascript") ||
		contentType.includes("typescript") ||
		contentType.includes("yaml") ||
		contentType.includes("svg")
	);
}

/** Fresh, paginated published catalog for selectors; never loads instructions or file bytes. */
export async function listAvailableSkillPage(
	ctx: SkillContext,
	options: { offset: number; limit: number },
) {
	await assertCurrentSkillAccess(ctx);
	if (
		!Number.isInteger(options.offset) ||
		options.offset < 0 ||
		!Number.isInteger(options.limit) ||
		options.limit < 1 ||
		options.limit > 100
	) {
		throw new Error("Invalid skill page");
	}
	const skills = await db.skill.findMany({
		where: scopeWhere(ctx, true),
		select: {
			slug: true,
			name: true,
			version: true,
			files: {
				select: { path: true, contentType: true, sizeBytes: true },
				orderBy: { path: "asc" },
				take: 101,
			},
		},
		orderBy: { slug: "asc" },
		skip: options.offset,
		take: options.limit + 1,
	});
	await assertCurrentSkillAccess(ctx);
	return {
		skills: skills.slice(0, options.limit).map((skill) => ({
			...skill,
			files: skill.files.slice(0, 100),
			fileManifestComplete: skill.files.length <= 100,
		})),
		hasMore: skills.length > options.limit,
	};
}
