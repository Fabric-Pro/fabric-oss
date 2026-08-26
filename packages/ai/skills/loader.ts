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
 * Scope filter follows Fabric's tenant XOR convention:
 *   (scope = SYSTEM) OR
 *   (scope = USER AND userId = ctx.userId) OR
 *   (scope = ORGANIZATION AND organizationId = ctx.organizationId)
 *
 * A 5-minute in-process LRU cache keyed on (scope, tenant, slug, version)
 * keeps hot SYSTEM skills out of the DB/S3 path on every chat turn.
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { downloadFile } from "@repo/storage";

export interface SkillContext {
	userId?: string | null;
	organizationId?: string | null;
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

function tenantKey(ctx: SkillContext): string {
	// Strict XOR: org and user must NEVER share a cache namespace. Otherwise
	// the first user's USER-scoped skills would be cached under `org:<id>`
	// and served to every other member of that org.
	if (ctx.organizationId) {
		return `org:${ctx.organizationId}`;
	}
	if (ctx.userId) {
		return `user:${ctx.userId}`;
	}
	return "anon";
}

// ---------------------------------------------------------------------------
// Scope filter
// ---------------------------------------------------------------------------

function scopeWhere(ctx: SkillContext) {
	// Strict XOR between ORG and USER scopes — org contexts must NOT see
	// personal skills, even when the caller has a userId. This matches
	// Fabric's tenant isolation contract: personal-and-org are separate
	// namespaces, not additive.
	const clauses: Array<Record<string, unknown>> = [
		{ scope: "SYSTEM" as const, userId: null, organizationId: null },
	];
	if (ctx.organizationId) {
		clauses.push({
			scope: "ORGANIZATION" as const,
			organizationId: ctx.organizationId,
			userId: null,
		});
	} else if (ctx.userId) {
		clauses.push({
			scope: "USER" as const,
			userId: ctx.userId,
			organizationId: null,
		});
	}
	return {
		isPublished: true,
		OR: clauses,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listAvailableSkills(
	ctx: SkillContext,
): Promise<SkillSummary[]> {
	const cacheKey = `summaries:${tenantKey(ctx)}`;
	const cached = summariesCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const skills = await db.skill.findMany({
		where: scopeWhere(ctx),
		include: {
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

	summariesCache.set(cacheKey, summaries);
	return summaries;
}

export async function loadSkillBundle(
	slug: string,
	ctx: SkillContext,
): Promise<SkillBundle> {
	const cacheKey = `bundle:${tenantKey(ctx)}:${slug}`;
	const cached = bundleCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const skill = await db.skill.findFirst({
		where: { ...scopeWhere(ctx), slug },
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

	bundleCache.set(cacheKey, bundle);
	return bundle;
}

export async function readSkillFile(
	slug: string,
	path: string,
	ctx: SkillContext,
): Promise<SkillFileContent> {
	const cacheKey = `file:${tenantKey(ctx)}:${slug}:${path}`;
	const cached = fileCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const file = await db.skillFile.findFirst({
		where: { path, skill: { ...scopeWhere(ctx), slug } },
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

	const bucket = config.storage.bucketNames.skills;
	const { data, contentType } = await downloadFile(file.storageKey, {
		bucket,
	});

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
