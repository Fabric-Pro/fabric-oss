import { db, Prisma } from "../client";
import type { PromptFormat, PromptScope, StoryKind } from "../generated/client";

/**
 * Normalize a tag for case-insensitive comparison
 * Converts to lowercase and replaces hyphens/spaces with underscores
 * e.g., "API_SPEC", "api-spec", "API SPEC" all become "api_spec"
 */
export function normalizeTag(tag: string): string {
	return tag
		.toLowerCase()
		.trim()
		.replace(/[-\s]+/g, "_");
}

export async function listSystemPrompts() {
	return db.prompt.findMany({
		where: { scope: "SYSTEM" as any },
		orderBy: { key: "asc" },
		include: {
			versions: {
				orderBy: { version: "desc" },
				take: 1,
			},
		},
	});
}

/**
 * List prompts for a tenant with XOR isolation.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only ORG prompts
 * - PERSONAL CONTEXT (userId only, no organizationId): Only USER prompts
 *
 * Personal prompts are NEVER accessible in org context and vice versa.
 */
export async function listPromptsForTenant({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	// XOR PATTERN: Check context-specific prompts ONLY
	if (organizationId) {
		// ORGANIZATION CONTEXT: Only ORG prompts
		return db.prompt.findMany({
			where: {
				scope: "ORG" as any,
				organizationId,
			},
			orderBy: { updatedAt: "desc" },
			include: {
				versions: {
					orderBy: { version: "desc" },
					take: 1,
				},
			},
		});
	}

	if (userId) {
		// PERSONAL CONTEXT: Only USER prompts
		return db.prompt.findMany({
			where: {
				scope: "USER" as any,
				userId,
			},
			orderBy: { updatedAt: "desc" },
			include: {
				versions: {
					orderBy: { version: "desc" },
					take: 1,
				},
			},
		});
	}

	// No context provided - return empty array
	return [];
}

/**
 * List prompts with advanced filtering
 */
export async function listPrompts({
	userId,
	organizationId,
	scope,
	category,
	tags,
	search,
	format,
	boundToDocumentType,
	unused,
	limit = 50,
	offset = 0,
	sortBy = "updatedAt",
	sortOrder = "desc",
}: {
	userId?: string;
	organizationId?: string;
	scope?: PromptScope;
	category?: string;
	tags?: string[];
	search?: string;
	format?: PromptFormat;
	/** Filter to prompts that have at least one binding for this document type */
	boundToDocumentType?: string;
	/** Fizzy #2068 (F13): only prompts bound to no action at all. */
	unused?: boolean;
	limit?: number;
	offset?: number;
	sortBy?: "name" | "createdAt" | "updatedAt" | "usageCount" | "lastUsedAt";
	sortOrder?: "asc" | "desc";
}) {
	const where: any = {};

	// Scope filtering with proper isolation
	if (scope) {
		where.scope = scope;
		if (scope === "USER") {
			// USER scope REQUIRES userId to prevent returning all user prompts
			if (!userId) {
				// Return empty result if USER scope requested without userId
				return { prompts: [], total: 0 };
			}
			where.userId = userId;
		} else if (scope === "ORG") {
			// ORG scope REQUIRES organizationId to prevent returning all org prompts
			if (!organizationId) {
				// Return empty result if ORG scope requested without organizationId
				return { prompts: [], total: 0 };
			}
			where.organizationId = organizationId;
		}
		// SYSTEM scope doesn't need additional filtering
	} else {
		// If no scope specified, show accessible prompts based on context
		const conditions: any[] = [{ scope: "SYSTEM" }];

		if (organizationId) {
			// In org context: show SYSTEM + ORG prompts only (not personal USER prompts)
			conditions.push({ scope: "ORG", organizationId });
		} else if (userId) {
			// In personal context: show SYSTEM + USER prompts only
			conditions.push({ scope: "USER", userId });
		}

		where.OR = conditions;
	}

	// Category filter
	if (category) {
		where.category = category;
	}

	// Tags filter (prompts that have ALL specified tags)
	if (tags && tags.length > 0) {
		where.tags = {
			hasEvery: tags,
		};
	}

	// Format filter
	if (format) {
		where.format = format;
	}

	// Document type filter: only show prompts that have at least one
	// *visible* binding for this document type (tenant-scoped).
	if (boundToDocumentType) {
		// The same set the runtime resolver consults. A personal binding is
		// visible inside an organization because it is what actually runs there
		// for this caller (FR3) — always scoped to `userId`, so one person's
		// override never surfaces a prompt for another.
		const bindingScopeConditions: any[] = [{ scope: "SYSTEM" }];
		if (organizationId) {
			bindingScopeConditions.push({ scope: "ORG", organizationId });
		}
		if (userId) {
			bindingScopeConditions.push({ scope: "USER", userId });
		}

		where.versions = {
			some: {
				bindings: {
					some: {
						documentType: boundToDocumentType,
						targetType: "AGENT",
						OR: bindingScopeConditions,
					},
				},
			},
		};
	}

	// Fizzy #2068 (F13): "unused" = bound to no action. When a document type
	// tab is active, it narrows to that tab's meaning — not bound to THIS
	// action — by flipping the some-clause above into a none-clause over the
	// same tenant-scoped conditions. Absolute unused (no bindings anywhere)
	// applies as a none-clause of its own otherwise.
	if (unused) {
		if (where.versions?.some?.bindings) {
			where.versions = {
				none: { bindings: where.versions.some.bindings },
			};
		} else {
			const unusedClause = {
				versions: { none: { bindings: { some: {} } } },
			};
			if (where.AND) {
				where.AND.push(unusedClause);
			} else {
				where.AND = [unusedClause];
			}
		}
	}

	// Search filter (name or description)
	// IMPORTANT: Must NOT overwrite existing where.OR (scope conditions)
	if (search) {
		const searchConditions = [
			{ name: { contains: search, mode: "insensitive" } },
			{ description: { contains: search, mode: "insensitive" } },
		];

		if (where.OR) {
			// Combine scope filtering with search filtering using AND
			// Result: (scope conditions) AND (name matches OR description matches)
			where.AND = [
				{ OR: where.OR }, // Keep existing scope conditions
				{ OR: searchConditions }, // Add search conditions
			];
			delete where.OR; // Remove standalone OR since it's now in AND
		} else {
			// No scope conditions in where.OR (specific scope was provided via where.scope)
			// Just apply search filter
			where.OR = searchConditions;
		}
	}

	const [prompts, total] = await Promise.all([
		db.prompt.findMany({
			where,
			orderBy: { [sortBy]: sortOrder },
			take: limit,
			skip: offset,
			include: {
				versions: {
					orderBy: { version: "desc" },
					take: 1,
				},
				_count: {
					select: { versions: true },
				},
				forkedFrom: {
					select: {
						id: true,
						key: true,
						name: true,
						scope: true,
					},
				},
			},
		}),
		db.prompt.count({ where }),
	]);

	return { prompts, total };
}

/**
 * Get prompt by ID with tenant filtering
 *
 * SECURITY: When tenant context is provided, enforces proper isolation.
 * Scope-based access: SYSTEM prompts are always accessible, USER/ORG require matching context.
 *
 * @param id - Prompt ID
 * @param opts - Tenant context (userId and/or organizationId)
 *              - If provided: Returns SYSTEM prompts + tenant-specific prompts
 *              - If omitted: Returns ANY prompt (for internal use with manual auth checks)
 */
export async function getPromptById(
	id: string,
	opts?: { userId?: string; organizationId?: string },
) {
	// If no tenant context provided, return any prompt (for internal procedures that do manual auth)
	if (!opts?.userId && !opts?.organizationId) {
		return db.prompt.findFirst({
			where: { id },
			include: {
				versions: { orderBy: { version: "desc" } },
				user: {
					select: {
						id: true,
						name: true,
						email: true,
					},
				},
				organization: {
					select: {
						id: true,
						name: true,
						slug: true,
					},
				},
				forkedFrom: {
					select: {
						id: true,
						key: true,
						name: true,
						scope: true,
					},
				},
			},
		});
	}

	// Build OR conditions: SYSTEM prompts are ALWAYS accessible
	const conditions: any[] = [{ scope: "SYSTEM" as any }];

	if (opts.organizationId) {
		conditions.push({
			scope: "ORG" as any,
			organizationId: opts.organizationId,
		});
	}

	if (opts.userId && !opts.organizationId) {
		conditions.push({
			scope: "USER" as any,
			userId: opts.userId,
		});
	}

	return db.prompt.findFirst({
		where: {
			id,
			OR: conditions,
		},
		include: {
			versions: { orderBy: { version: "desc" } },
			user: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			organization: {
				select: {
					id: true,
					name: true,
					slug: true,
				},
			},
			forkedFrom: {
				select: {
					id: true,
					key: true,
					name: true,
					scope: true,
				},
			},
		},
	});
}

/**
 * Get a prompt by key with XOR tenant isolation.
 * Used by workflows to fetch prompts from the Prompt Library.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): ORG prompts > SYSTEM prompts
 *   (User's personal prompts are NOT accessible in org context)
 * - PERSONAL CONTEXT (userId only, no organizationId): USER prompts > SYSTEM prompts
 *   (Org prompts are NOT accessible in personal context)
 */
export async function getPromptByKey({
	key,
	userId,
	organizationId,
}: {
	key: string;
	userId?: string;
	organizationId?: string;
}) {
	// XOR PATTERN: Check context-specific prompts ONLY
	// Personal prompts NEVER leak into org context and vice versa
	if (organizationId) {
		// ORGANIZATION CONTEXT: Only check ORG prompts, then SYSTEM
		const orgPrompt = await db.prompt.findFirst({
			where: { key, scope: "ORG", organizationId },
			include: {
				versions: { orderBy: { version: "desc" }, take: 1 },
			},
		});
		if (orgPrompt) {
			return orgPrompt;
		}
	} else if (userId) {
		// PERSONAL CONTEXT: Only check USER prompts, then SYSTEM
		const userPrompt = await db.prompt.findFirst({
			where: { key, scope: "USER", userId },
			include: {
				versions: { orderBy: { version: "desc" }, take: 1 },
			},
		});
		if (userPrompt) {
			return userPrompt;
		}
	}

	// Both contexts fall back to SYSTEM prompts
	const systemPrompt = await db.prompt.findFirst({
		where: { key, scope: "SYSTEM" },
		include: {
			versions: { orderBy: { version: "desc" }, take: 1 },
		},
	});

	return systemPrompt;
}

/**
 * Create a new prompt
 */
export async function createPrompt({
	key,
	name,
	description,
	scope,
	userId,
	organizationId,
	format = "PLAIN_TEXT",
	category,
	tags = [],
	isPublic = false,
	createdBy,
	initialContent,
	initialVariables,
}: {
	key: string;
	name: string;
	description?: string;
	scope: PromptScope;
	userId?: string;
	organizationId?: string;
	format?: PromptFormat;
	category?: string;
	tags?: string[];
	isPublic?: boolean;
	createdBy: string;
	initialContent?: string;
	initialVariables?: any;
}) {
	const prompt = await db.prompt.create({
		data: {
			key,
			name,
			description,
			scope,
			userId: scope === "USER" ? userId : null,
			organizationId: scope === "ORG" ? organizationId : null,
			format,
			category,
			tags,
			isPublic,
			createdBy,
		},
	});

	// Create initial version if content provided.
	// TENANT ISOLATION: version row must mirror parent Prompt's tenancy exactly
	// (XOR pattern) so version-level access checks and RLS stay consistent.
	if (initialContent) {
		await db.promptVersion.create({
			data: {
				promptId: prompt.id,
				version: 1,
				content: initialContent,
				variables: initialVariables ?? {},
				createdBy,
				scope,
				userId: scope === "USER" ? (userId ?? null) : null,
				organizationId:
					scope === "ORG" ? (organizationId ?? null) : null,
			},
		});
	}

	return prompt;
}

/**
 * Update a prompt
 */
export async function updatePrompt({
	id,
	name,
	description,
	format,
	category,
	tags,
	isPublic,
	updatedBy,
}: {
	id: string;
	name?: string;
	description?: string;
	format?: PromptFormat;
	category?: string;
	tags?: string[];
	isPublic?: boolean;
	updatedBy: string;
}) {
	return db.prompt.update({
		where: { id },
		data: {
			name,
			description,
			format,
			category,
			tags,
			isPublic,
			updatedBy,
		},
	});
}

/**
 * Delete a prompt
 *
 * Authorization is enforced by the delete procedure before calling this.
 */
export async function deletePrompt(id: string) {
	return db.prompt.delete({ where: { id } });
}

/**
 * Increment usage count for a prompt
 */
export async function incrementPromptUsage(id: string) {
	return db.prompt.update({
		where: { id },
		data: {
			usageCount: { increment: 1 },
			lastUsedAt: new Date(),
		},
	});
}

/**
 * Get all categories used in prompts
 */
export async function getPromptCategories({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	const where: any = {};

	// Context-aware filtering: org context shows SYSTEM + ORG, personal shows SYSTEM + USER
	const conditions: any[] = [{ scope: "SYSTEM" }];
	if (organizationId) {
		conditions.push({ scope: "ORG", organizationId });
	} else if (userId) {
		conditions.push({ scope: "USER", userId });
	}
	where.OR = conditions;

	const prompts = await db.prompt.findMany({
		where,
		select: { category: true },
		distinct: ["category"],
	});

	return prompts
		.map((p) => p.category)
		.filter((c): c is string => c !== null)
		.sort();
}

/**
 * Get all tags used in prompts
 */
export async function getPromptTags({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	const where: any = {};

	// Context-aware filtering: org context shows SYSTEM + ORG, personal shows SYSTEM + USER
	const conditions: any[] = [{ scope: "SYSTEM" }];
	if (organizationId) {
		conditions.push({ scope: "ORG", organizationId });
	} else if (userId) {
		conditions.push({ scope: "USER", userId });
	}
	where.OR = conditions;

	const prompts = await db.prompt.findMany({
		where,
		select: { tags: true },
	});

	const allTags = new Set<string>();
	for (const prompt of prompts) {
		for (const tag of prompt.tags) {
			allTags.add(tag);
		}
	}

	return Array.from(allTags).sort();
}

export async function forkPrompt({
	sourcePromptId,
	targetScope,
	userId,
	organizationId,
}: {
	sourcePromptId: string;
	targetScope: "USER" | "ORG";
	userId?: string;
	organizationId?: string;
}) {
	const source = await db.prompt.findUnique({
		where: { id: sourcePromptId },
		include: { versions: { orderBy: { version: "desc" }, take: 1 } },
	});

	if (!source) {
		throw new Error("Source prompt not found");
	}

	const latest = source.versions[0];
	const prompt = await db.prompt.create({
		data: {
			key: `${source.key}-fork-${Date.now()}`,
			name: `${source.name} (Copy)`,
			description: source.description,
			scope: targetScope as any,
			userId: targetScope === "USER" ? (userId ?? null) : null,
			organizationId:
				targetScope === "ORG" ? (organizationId ?? null) : null,
			format: source.format,
			category: source.category,
			tags: source.tags,
			forkedFromId: sourcePromptId, // Track the parent prompt
			isPublic: false, // Forked prompts are private by default
			createdBy: userId ?? "system",
		},
	});

	// TENANT ISOLATION: version row mirrors parent Prompt's tenancy (XOR).
	// For an ORG fork that means userId=null even though the caller is a user.
	if (latest) {
		if (!userId) {
			throw new Error("userId is required to create a prompt version");
		}
		await db.promptVersion.create({
			data: {
				promptId: prompt.id,
				version: 1,
				content: latest.content,
				variables: (latest.variables ?? undefined) as any,
				createdBy: userId,
				scope: targetScope,
				userId: targetScope === "USER" ? userId : null,
				organizationId:
					targetScope === "ORG" ? (organizationId ?? null) : null,
			},
		});
	}

	return prompt;
}

/**
 * Create a new prompt version.
 *
 * TENANT ISOLATION: scope, userId, and organizationId on the version row are
 * derived from the parent Prompt — never from the caller — so the version
 * always matches the parent's XOR tenancy.
 *
 * CONCURRENCY: Under Postgres READ COMMITTED two concurrent calls can read the
 * same latest version and both try to insert the same next number, which the
 * @@unique([promptId, version]) constraint rejects with P2002. We retry a few
 * times so spammed "Save" clicks don't surface as 500s.
 */
export async function createPromptVersion({
	promptId,
	content,
	variables,
	changeNote,
	createdBy,
}: {
	promptId: string;
	content: string;
	variables?: any;
	changeNote?: string;
	createdBy: string;
}) {
	const parent = await db.prompt.findUnique({
		where: { id: promptId },
		select: { id: true, scope: true, userId: true, organizationId: true },
	});
	if (!parent) {
		throw new Error("Prompt not found");
	}

	const MAX_ATTEMPTS = 5;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			// Wrap latest-read + create + cascade in a transaction so a
			// concurrent writer cannot insert a newer version between our
			// create and our binding cascade — which would otherwise leave
			// bindings pinned at a stale version.
			return await db.$transaction(async (tx) => {
				const latest = await tx.promptVersion.findFirst({
					where: { promptId },
					orderBy: { version: "desc" },
					select: { id: true, version: true },
				});
				const next = (latest?.version ?? 0) + 1;

				const newVersion = await tx.promptVersion.create({
					data: {
						promptId,
						version: next,
						content,
						variables: variables ?? {},
						changeNote,
						createdBy,
						scope: parent.scope,
						userId: parent.userId,
						organizationId: parent.organizationId,
					},
				});

				// Advance same-scope bindings that were pinned to the prior
				// latest version so admins editing a prompt in place don't
				// leave stale bindings pointing at the old content. Forks
				// (other scopes) have their own version chains and remain
				// untouched.
				if (latest) {
					await tx.promptBinding.updateMany({
						where: {
							promptVersionId: latest.id,
							scope: parent.scope,
						},
						data: { promptVersionId: newVersion.id },
					});
				}

				return newVersion;
			});
		} catch (error) {
			const isVersionCollision =
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2002";
			if (isVersionCollision && attempt < MAX_ATTEMPTS - 1) {
				continue;
			}
			throw error;
		}
	}

	throw new Error("Failed to create prompt version after concurrent retries");
}

/**
 * The ordinary client or a transaction client — structurally, anything that can
 * reach `promptBinding`. Typed by what is used rather than by which client it
 * is, so a caller inside `$transaction` needs no cast.
 */
type PromptBindingClient = Pick<typeof db, "promptBinding">;

export async function bindPromptVersion({
	targetType,
	targetKey,
	documentType,
	storyKind,
	scope,
	userId,
	organizationId,
	projectId,
	promptVersionId,
	isDefault = false,
	callerUserId,
	client,
}: {
	targetType: "AGENT" | "FEATURE";
	targetKey: string;
	documentType: string; // Required: Each binding must specify a document type
	// Exact-match scope. Null = "any kind" (non-stage bindings).
	storyKind?: StoryKind | null;
	scope: "SYSTEM" | "ORG" | "USER";
	userId?: string;
	organizationId?: string;
	/** Narrows an ORG binding to one project (the PROJECT tier). Must be null
	 *  for SYSTEM/USER scopes — enforced by the API gate, asserted here by the
	 *  unique-key shape below. */
	projectId?: string | null;
	promptVersionId: string;
	isDefault?: boolean;
	/** The ID of the user performing the action. Used to clear their personal
	 *  override when setting a SYSTEM or ORG default. */
	callerUserId?: string;
	/**
	 * Transaction client, when this call is one of several that must land
	 * together — binding a prompt to more than one action, say. Defaults to the
	 * ordinary client, so a single bind is unchanged.
	 */
	client?: PromptBindingClient;
}) {
	const storyKindFilter = storyKind ?? null;
	const tx = client ?? db;

	// If setting as default, unset any existing default for this combination
	if (isDefault) {
		await tx.promptBinding.updateMany({
			where: {
				targetType: targetType as any,
				targetKey,
				documentType,
				storyKind: storyKindFilter,
				scope: scope as any,
				userId: userId ?? null,
				organizationId: organizationId ?? null,
				projectId: projectId ?? null,
				isDefault: true,
			},
			data: {
				isDefault: false,
			},
		});

		// When setting a SYSTEM default, stand the caller's USER override down
		// so the system default takes effect through natural precedence. The
		// row is kept with its default flag dropped — the same state a bind
		// saved without "set as default" produces — so the person can put
		// their preference back from the catalog later.
		if (scope === "SYSTEM" && callerUserId) {
			await tx.promptBinding.updateMany({
				where: {
					targetType: targetType as any,
					targetKey,
					documentType,
					storyKind: storyKindFilter,
					scope: "USER" as any,
					userId: callerUserId,
					isDefault: true,
				},
				data: { isDefault: false },
			});
		}

		// When setting an ORG default, do the same within that org context.
		// CRITICAL: Constrain by organizationId so personal USER bindings (organizationId: null)
		// are NOT touched when setting an ORG default
		if (scope === "ORG" && callerUserId && organizationId) {
			await tx.promptBinding.updateMany({
				where: {
					targetType: targetType as any,
					targetKey,
					documentType,
					storyKind: storyKindFilter,
					scope: "USER" as any,
					userId: callerUserId,
					organizationId,
					isDefault: true,
				},
				data: { isDefault: false },
			});
		}
	}

	// Upsert binding by unique composite (including documentType + storyKind)
	const existing = await tx.promptBinding.findFirst({
		where: {
			targetType: targetType as any,
			targetKey,
			documentType,
			storyKind: storyKindFilter,
			scope: scope as any,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
			projectId: projectId ?? null,
		},
	});

	if (existing) {
		return tx.promptBinding.update({
			where: { id: existing.id },
			data: { promptVersionId, isDefault },
		});
	}

	return tx.promptBinding.create({
		data: {
			targetType: targetType as any,
			targetKey,
			documentType,
			storyKind: storyKindFilter,
			scope: scope as any,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
			projectId: projectId ?? null,
			promptVersionId,
			isDefault,
		},
	});
}

export type PromptCatalogBinding = {
	promptId: string;
	promptName: string;
	promptVersionId: string;
	version: number;
	scope: "SYSTEM" | "ORG" | "USER";
	/** Set when this ORG binding is narrowed to one project (PROJECT tier). */
	projectId: string | null;
	isDefault: boolean;
	/** This is the binding that actually runs for this caller. */
	isEffective: boolean;
};

export type PromptCatalogEntry = {
	targetKey: string;
	documentType: string;
	storyKind: StoryKind | null;
	/** Tier currently in force, or null when the action has no binding at all.
	 *  "PROJECT" marks an ORG binding narrowed to one project. */
	effectiveScope: "SYSTEM" | "ORG" | "PROJECT" | "USER" | null;
	prompts: PromptCatalogBinding[];
};

/**
 * Group a flat binding list into one entry per action, marking which binding
 * actually runs.
 *
 * The winner is the highest-precedence tier that is BOTH present and marked
 * default — the same two conditions `getBoundPromptVersion` applies, expressed
 * once here so the catalog cannot drift from what the runtime does. A tier
 * whose binding is not default is listed but does not win, which is exactly
 * what a cleared override looks like.
 *
 * Pure, so the precedence rule is testable without a database.
 */
export function groupPromptCatalogBindings(
	rows: ReadonlyArray<{
		targetKey: string;
		documentType: string;
		storyKind: StoryKind | null;
		scope: string;
		projectId?: string | null;
		isDefault: boolean;
		promptVersionId: string;
		version: number;
		promptId: string;
		promptName: string;
	}>,
): PromptCatalogEntry[] {
	const entries = new Map<string, PromptCatalogEntry>();

	for (const row of rows) {
		// Serialised rather than joined by a separator: no delimiter can then
		// collide with a value, and the key stays plain text. An earlier version
		// used a NUL between the parts, which worked but made the whole file
		// register as binary to grep and every other text tool.
		const key = JSON.stringify([
			row.targetKey,
			row.documentType,
			row.storyKind ?? null,
		]);
		const entry = entries.get(key) ?? {
			targetKey: row.targetKey,
			documentType: row.documentType,
			storyKind: row.storyKind,
			effectiveScope: null,
			prompts: [],
		};

		entry.prompts.push({
			promptId: row.promptId,
			promptName: row.promptName,
			promptVersionId: row.promptVersionId,
			version: row.version,
			scope: row.scope as "SYSTEM" | "ORG" | "USER",
			projectId: row.projectId ?? null,
			isDefault: row.isDefault,
			isEffective: false,
		});

		entries.set(key, entry);
	}

	for (const entry of entries.values()) {
		const winner = entry.prompts
			.filter((p) => p.isDefault)
			.sort(
				(a, b) =>
					(SCOPE_RANK[effectiveTier(a)] ?? 99) -
					(SCOPE_RANK[effectiveTier(b)] ?? 99),
			)[0];

		if (winner) {
			winner.isEffective = true;
			entry.effectiveScope = effectiveTier(winner) as
				| "SYSTEM"
				| "ORG"
				| "PROJECT"
				| "USER";
		}

		// Strongest tier first, so the list reads the way precedence works.
		entry.prompts.sort(
			(a, b) =>
				(SCOPE_RANK[effectiveTier(a)] ?? 99) -
					(SCOPE_RANK[effectiveTier(b)] ?? 99) ||
				Number(b.isDefault) - Number(a.isDefault),
		);
	}

	return [...entries.values()];
}

/**
 * Every binding visible to the caller, grouped by action.
 *
 * TENANT ISOLATION: SYSTEM plus the caller's own tier — ORG in organization
 * context, USER in personal context, never both, matching every other read
 * here.
 */
export async function listPromptCatalog({
	userId,
	organizationId,
	projectId,
}: {
	userId?: string;
	organizationId?: string;
	/** When set, PROJECT-tier bindings for this project join the catalog and
	 *  can be the tier in force. */
	projectId?: string | null;
}): Promise<PromptCatalogEntry[]> {
	// Same set the runtime resolver consults, so the catalog's "in force"
	// marker cannot disagree with what actually runs. A personal default wins
	// inside an organization (FR3), so it is listed here too — scoped to this
	// caller, never to anyone else.
	const scopeConditions: any[] = [{ scope: "SYSTEM" }];
	if (organizationId) {
		scopeConditions.push(
			projectId
				? {
						scope: "ORG",
						organizationId,
						OR: [{ projectId }, { projectId: null }],
					}
				: { scope: "ORG", organizationId },
		);
	}
	if (userId) {
		scopeConditions.push({ scope: "USER", userId });
	}

	const bindings = await db.promptBinding.findMany({
		where: { targetType: "AGENT" as any, OR: scopeConditions },
		include: {
			promptVersion: {
				select: {
					id: true,
					version: true,
					prompt: { select: { id: true, name: true } },
				},
			},
		},
	});

	return groupPromptCatalogBindings(
		bindings.map((b) => ({
			targetKey: b.targetKey,
			documentType: b.documentType,
			storyKind: b.storyKind,
			scope: b.scope,
			projectId: b.projectId,
			isDefault: b.isDefault,
			promptVersionId: b.promptVersion.id,
			version: b.promptVersion.version,
			promptId: b.promptVersion.prompt.id,
			promptName: b.promptVersion.prompt.name,
		})),
	);
}

/**
 * Bind one prompt version to several actions at once, all or nothing.
 *
 * Binding to a set of actions is a single intent — "this prompt is the one for
 * these things" — so a partial application is a state nobody asked for and
 * nobody can see: some actions moved, some did not, and the UI reports success.
 * One transaction avoids inventing a reconciliation problem.
 *
 * Each target still goes through `bindPromptVersion`, so the precedence-clearing
 * and default-unsetting rules apply per action exactly as for a single bind.
 */
export async function bindPromptVersionToTargets({
	targets,
	scope,
	userId,
	organizationId,
	projectId,
	promptVersionId,
	isDefault = false,
	callerUserId,
}: {
	targets: ReadonlyArray<{
		targetType: "AGENT" | "FEATURE";
		targetKey: string;
		documentType: string;
		storyKind?: StoryKind | null;
	}>;
	scope: "SYSTEM" | "ORG" | "USER";
	userId?: string;
	organizationId?: string;
	/** Narrows an ORG binding to one project (the PROJECT tier). */
	projectId?: string | null;
	promptVersionId: string;
	isDefault?: boolean;
	callerUserId?: string;
}) {
	if (targets.length === 0) {
		return { bound: 0 };
	}

	await db.$transaction(async (tx) => {
		for (const target of targets) {
			await bindPromptVersion({
				targetType: target.targetType,
				targetKey: target.targetKey,
				documentType: target.documentType,
				storyKind: target.storyKind ?? null,
				scope,
				userId,
				organizationId,
				projectId,
				promptVersionId,
				isDefault,
				callerUserId,
				client: tx,
			});
		}
	});

	return { bound: targets.length };
}

export type PromptBoundAction = {
	targetKey: string;
	documentType: string;
	storyKind: StoryKind | null;
	scope: "SYSTEM" | "ORG" | "USER";
	isDefault: boolean;
};

/**
 * The actions one prompt is currently bound to, for this caller.
 *
 * Editing a prompt edits the shared content, so every action bound to it takes
 * the change at once. This is what makes that reach visible before a save
 * rather than after.
 *
 * Bindings point at a version, and `createPromptVersion` advances a scope's
 * bindings to the newest version, so the question is asked of the prompt rather
 * than of any one version — otherwise the answer would silently narrow to
 * whichever version happened to be bound.
 *
 * TENANT ISOLATION: SYSTEM plus the caller's own tier, matching every other read.
 */
export async function listActionsForPrompt({
	promptId,
	userId,
	organizationId,
}: {
	promptId: string;
	userId?: string;
	organizationId?: string;
}): Promise<PromptBoundAction[]> {
	const scopeConditions: any[] = [{ scope: "SYSTEM" }];
	if (organizationId) {
		scopeConditions.push({ scope: "ORG", organizationId });
	} else if (userId) {
		scopeConditions.push({ scope: "USER", userId });
	}

	const bindings = await db.promptBinding.findMany({
		where: {
			targetType: "AGENT" as any,
			OR: scopeConditions,
			promptVersion: { promptId },
		},
		select: {
			targetKey: true,
			documentType: true,
			storyKind: true,
			scope: true,
			isDefault: true,
		},
	});

	return bindings.map((b) => ({
		targetKey: b.targetKey,
		documentType: b.documentType,
		storyKind: b.storyKind,
		scope: b.scope as "SYSTEM" | "ORG" | "USER",
		isDefault: b.isDefault,
	}));
}

/**
 * Clear a tier's override for one target, so the effective default falls
 * through to the tier below.
 *
 * The binding ROW survives with `isDefault` dropped: the same state a bind
 * saved with "set as default" unchecked produces, which is why every reader
 * already knows what to do with it. The resolver filters `isDefault: true`
 * at each tier, so the tier falls through; the catalog keeps listing the
 * variant, now as an offer rather than the thing in force; and the binding
 * status reports bound-but-not-default. Clearing is therefore reversible
 * from where it happened — the catalog's existing switch puts the same row
 * back, no trip to the library and nothing re-authored (FR12 of Fizzy #2068).
 * The composite unique key guarantees at most one row per target+scope+owner,
 * so a cleared row cannot accumulate into clutter.
 *
 * Identified by the same composite the unique constraint uses, never by row id:
 * a caller cannot reach another tenant's binding by guessing an identifier.
 */

/**
 * Every personal default the caller currently holds, across all actions
 * ("My Overrides", Fizzy #2068 F8).
 *
 * In-force USER bindings only: a soft-cleared variant (isDefault: false) is
 * an available offer in the catalog, not an override, and listing it here
 * would read as though it were running. Scoped to the caller's own rows by
 * the WHERE — the userId is a parameter of the query, so the API procedure
 * above it is the only place a caller's identity enters.
 */
export async function listMyPromptOverrides({ userId }: { userId: string }) {
	return db.promptBinding.findMany({
		where: {
			targetType: "AGENT" as any,
			scope: "USER" as any,
			userId,
			isDefault: true,
		},
		orderBy: { updatedAt: "desc" },
		select: {
			targetKey: true,
			documentType: true,
			storyKind: true,
			promptVersionId: true,
			updatedAt: true,
			promptVersion: {
				select: { prompt: { select: { id: true, name: true } } },
			},
		},
	});
}

export async function clearPromptBinding({
	targetType,
	targetKey,
	documentType,
	storyKind,
	scope,
	userId,
	organizationId,
	projectId,
}: {
	targetType: "AGENT" | "FEATURE";
	targetKey: string;
	documentType: string;
	storyKind?: StoryKind | null;
	scope: PromptScope;
	userId?: string;
	organizationId?: string;
	/** Clearing a PROJECT binding targets exactly that row, never the org-wide
	 *  one beside it. */
	projectId?: string | null;
}): Promise<{ cleared: boolean }> {
	const { count } = await db.promptBinding.updateMany({
		where: {
			targetType: targetType as any,
			targetKey,
			documentType,
			storyKind: storyKind ?? null,
			scope: scope as any,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
			projectId: projectId ?? null,
			// Only a row that is actually in force counts as cleared; asking to
			// clear an already-cleared tier reports nothing to clear rather
			// than claiming success twice.
			isDefault: true,
		},
		data: {
			isDefault: false,
		},
	});

	return { cleared: count > 0 };
}

export async function getBoundPromptVersion({
	targetType,
	targetKey,
	documentType,
	storyKind,
	userId,
	organizationId,
	projectId,
}: {
	targetType: "AGENT" | "FEATURE";
	targetKey: string;
	documentType: string; // Required: Must specify document type to get the correct binding
	// Exact-match filter. Pass "BUG" / "FEATURE" for stage prompts, or null/omit
	// for non-stage bindings (matches rows with storyKind IS NULL).
	// No cross-bucket fallback — a missing BUG binding will NOT resolve to FEATURE.
	storyKind?: StoryKind | null;
	userId?: string;
	organizationId?: string;
	/** Narrows the ORG tier to one project: a PROJECT default outranks the
	 *  org-wide one. Only meaningful with organizationId. */
	projectId?: string | null;
}) {
	const storyKindFilter = storyKind ?? null;

	// TENANT ISOLATION: Strict context separation
	// - Organization context (organizationId provided): Only check ORG -> SYSTEM bindings
	// - Personal context (userId only, no organizationId): Only check USER -> SYSTEM bindings
	// USER bindings from personal context should NEVER be used in organization context

	if (organizationId) {
		// ORGANIZATION CONTEXT: USER -> PROJECT -> ORG -> SYSTEM.
		//
		// The caller's own personal default is consulted FIRST, which is FR3 of
		// Fizzy #2068: "overriding Org and Universal defaults for themselves".
		//
		// This is a deliberate, documented exception to the repo's XOR tenancy
		// rule, and it is narrower than it looks. XOR exists to stop one
		// tenant's DATA reaching another; a prompt binding is not tenant data,
		// it is one person's preference about their own work, and honouring it
		// exposes nobody else's anything. The isolation that matters here is
		// between two USERS, and that stays absolute — the lookup below is
		// scoped to `userId`, so no one ever resolves someone else's override.
		//
		// The trade-off, accepted knowingly: an organization's default is a
		// strong recommendation, not an enforcement mechanism. A prompt an
		// organization must be able to mandate needs an explicit policy, not a
		// preference the resolver quietly ignores.
		if (userId) {
			const personalBinding = await db.promptBinding.findFirst({
				where: {
					targetType: targetType as any,
					targetKey,
					documentType,
					storyKind: storyKindFilter,
					scope: "USER" as any,
					userId,
					isDefault: true,
				},
				include: { promptVersion: true },
			});
			if (personalBinding) {
				return personalBinding.promptVersion;
			}
		}

		// PROJECT tier: an org-admin's default for THIS project outranks the
		// org-wide one. A project binding is still ORG scope — same writers,
		// same authority — just narrowed in reach.
		if (projectId) {
			const projectBinding = await db.promptBinding.findFirst({
				where: {
					targetType: targetType as any,
					targetKey,
					documentType,
					storyKind: storyKindFilter,
					scope: "ORG" as any,
					organizationId,
					projectId,
					// A row saved with "set as default" unchecked is available,
					// not in force — same rule as the org-wide tier below.
					isDefault: true,
				},
				include: { promptVersion: true },
			});
			if (projectBinding) {
				return projectBinding.promptVersion;
			}
		}

		const orgBinding = await db.promptBinding.findFirst({
			where: {
				targetType: targetType as any,
				targetKey,
				documentType,
				storyKind: storyKindFilter,
				scope: "ORG" as any,
				organizationId,
				// Only the org-WIDE row backs this tier; project-narrowed rows
				// were consulted above and must not double-count here.
				projectId: null,
				// A row saved with "set as default" unchecked is available, not
				// in force. Without this the tier could not be stood down at
				// all short of deleting its row.
				isDefault: true,
			},
			include: { promptVersion: true },
		});
		if (orgBinding) {
			return orgBinding.promptVersion;
		}
	} else if (userId) {
		// PERSONAL CONTEXT: Check USER -> SYSTEM only
		// Never look at ORG bindings - they belong to organization context
		const userBinding = await db.promptBinding.findFirst({
			where: {
				targetType: targetType as any,
				targetKey,
				documentType,
				storyKind: storyKindFilter,
				scope: "USER" as any,
				userId,
				isDefault: true,
			},
			include: { promptVersion: true },
		});
		if (userBinding) {
			return userBinding.promptVersion;
		}
	}

	// Fall back to SYSTEM binding (accessible in all contexts)
	const sysBinding = await db.promptBinding.findFirst({
		where: {
			targetType: targetType as any,
			targetKey,
			documentType,
			storyKind: storyKindFilter,
			scope: "SYSTEM" as any,
			isDefault: true,
		},
		include: { promptVersion: true },
	});
	return sysBinding?.promptVersion ?? null;
}

/**
 * Get bound prompt for an agent with full prompt details
 * Returns the prompt with its bound version based on user/org/system precedence
 * REQUIRES documentType to ensure the correct prompt is used for each document type
 */
export async function getBoundPromptForAgent({
	agentName,
	userId,
	organizationId,
	projectId,
	documentType,
	storyKind,
}: {
	agentName: string;
	userId?: string;
	organizationId?: string;
	/** Narrows the ORG tier to this project (USER > PROJECT > ORG > SYSTEM). */
	projectId?: string | null;
	documentType: string; // Required: Must specify document type
	storyKind?: StoryKind | null; // Exact-match; see getBoundPromptVersion for semantics
}) {
	// Get the bound prompt version for this specific document type
	const promptVersion = await getBoundPromptVersion({
		targetType: "AGENT",
		targetKey: agentName,
		documentType, // Filter by document type
		storyKind,
		userId,
		organizationId,
		projectId,
	});

	if (!promptVersion) {
		return null;
	}

	// Fetch the full prompt details
	const prompt = await db.prompt.findUnique({
		where: { id: promptVersion.promptId },
		include: {
			versions: {
				where: { id: promptVersion.id },
				take: 1,
			},
		},
	});

	if (!prompt || prompt.versions.length === 0) {
		return null;
	}

	return {
		id: prompt.id,
		key: prompt.key,
		name: prompt.name,
		description: prompt.description,
		scope: prompt.scope,
		format: prompt.format,
		category: prompt.category,
		tags: prompt.tags,
		version: {
			id: promptVersion.id,
			version: promptVersion.version,
			content: promptVersion.content,
			variables: promptVersion.variables,
		},
	};
}

/**
 * List available prompts for an agent based on BINDING RELATIONSHIP ONLY.
 * This is the new binding-first architecture where:
 * - Tags are for search/organization only, NOT for filtering
 * - Category is for organization only, NOT for filtering
 * - Only prompts that are explicitly bound to the document type are returned
 * - If no documentType is provided, returns all prompts (for backward compatibility)
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT: SYSTEM + ORG bindings/prompts only
 * - PERSONAL CONTEXT: SYSTEM + USER bindings/prompts only
 * Personal bindings/prompts are NEVER accessible in org context and vice versa.
 */
/** Precedence rank for the effective default. Lower wins: Personal > Project
 *  (an ORG binding narrowed to one project) > Org-wide > Universal. */
const SCOPE_RANK: Record<string, number> = {
	USER: 0,
	PROJECT: 1,
	ORG: 2,
	SYSTEM: 3,
};

/**
 * The tier a binding competes at. An ORG row narrowed to a project IS the
 * PROJECT tier — same scope column, finer reach — so every ranking that must
 * agree with the runtime goes through this, never through raw scope.
 */
function effectiveTier(b: { scope: string; projectId?: string | null }) {
	return b.scope === "ORG" && b.projectId ? "PROJECT" : b.scope;
}

export type PromptBindingStatus = {
	/** This prompt is the effective default for at least one target. */
	isDefault: boolean;
	/** This prompt is bound to the target, default or not. */
	isBound: boolean;
	/**
	 * The tier the effective default came from, so the UI can say *which* level
	 * is in force rather than only that something is. Null when this prompt is
	 * bound but not the winner.
	 */
	defaultScope: "SYSTEM" | "ORG" | "PROJECT" | "USER" | null;
};

/**
 * Resolve, per prompt, whether it is the default a user actually gets.
 *
 * Precedence is resolved **per target** (`targetKey`), not across the whole
 * list. Two different agents legitimately have different defaults for the same
 * document type, so collapsing to a single winner overall would hide one of
 * them. Within one target, only the highest-precedence tier wins: a personal
 * override shadows the org and system defaults, and those must stop claiming to
 * be the default or the library shows two prompts both badged "Default" and
 * says nothing about which one is actually in force.
 *
 * Pure, so the precedence rule is testable without a database.
 */
export function resolvePromptBindingStatus(
	bindings: ReadonlyArray<{
		promptId: string;
		targetKey: string;
		/** Part of the action's identity; omit only when the caller has already
		 *  narrowed to a single document type. */
		documentType?: string;
		/** Exact-match, like the runtime resolver: a BUG binding never resolves
		 *  for FEATURE, and null is the non-stage slot rather than a wildcard. */
		storyKind?: string | null;
		scope: string;
		/** Set on an ORG row, this binding competes at the PROJECT tier. */
		projectId?: string | null;
		isDefault: boolean;
	}>,
): Map<string, PromptBindingStatus> {
	// A binding competes only with others for the SAME action, and an action is
	// the whole triple. Ranking by targetKey alone makes a personal BUG default
	// outrank the org's FEATURE default for the same agent — reporting the org
	// prompt as not-default when it is the only thing bound for its own kind,
	// and no runtime lookup can ever consider the two together.
	const actionKey = (b: {
		targetKey: string;
		documentType?: string;
		storyKind?: string | null;
	}) =>
		JSON.stringify([
			b.targetKey,
			b.documentType ?? null,
			b.storyKind ?? null,
		]);

	// Best (lowest) rank of a default binding per action.
	const winningRankByTarget = new Map<string, number>();
	for (const b of bindings) {
		if (!b.isDefault) {
			continue;
		}
		const rank = SCOPE_RANK[effectiveTier(b)] ?? Number.POSITIVE_INFINITY;
		const current = winningRankByTarget.get(actionKey(b));
		if (current === undefined || rank < current) {
			winningRankByTarget.set(actionKey(b), rank);
		}
	}

	const status = new Map<string, PromptBindingStatus>();
	for (const b of bindings) {
		const entry = status.get(b.promptId) ?? {
			isDefault: false,
			isBound: true,
			defaultScope: null,
		};
		entry.isBound = true;

		const rank = SCOPE_RANK[effectiveTier(b)] ?? Number.POSITIVE_INFINITY;
		if (b.isDefault && winningRankByTarget.get(actionKey(b)) === rank) {
			const incumbent =
				entry.defaultScope === null
					? Number.POSITIVE_INFINITY
					: (SCOPE_RANK[entry.defaultScope] ??
						Number.POSITIVE_INFINITY);
			if (rank < incumbent) {
				entry.defaultScope = effectiveTier(b) as
					| "SYSTEM"
					| "ORG"
					| "PROJECT"
					| "USER";
			}
			entry.isDefault = true;
		}

		status.set(b.promptId, entry);
	}

	return status;
}

/**
 * Get binding status for a list of prompts for a specific document type.
 * Returns a map of promptId -> { isDefault, isBound, defaultScope }.
 *
 * TENANT ISOLATION: Uses scope-aware binding lookup.
 * Only returns bindings visible to the current user/org context.
 */
export async function getBindingStatusForPrompts({
	promptIds,
	documentType,
	userId,
	organizationId,
	projectId,
}: {
	promptIds: string[];
	/** Narrows the badge to one action dimension. Omitted — the library page's
	 *  case since the scope tabs replaced the document-type tabs — the status
	 *  resolves across every action: a prompt winning any of them badges Default
	 *  at its best tier, one merely bound anywhere shows Available. */
	documentType?: string;
	userId?: string;
	organizationId?: string;
	/** When set, PROJECT-tier bindings for this project join the ranking and
	 *  can win the badge; org-wide bindings still count beneath them. */
	projectId?: string | null;
}) {
	if (promptIds.length === 0) {
		return new Map<string, PromptBindingStatus>();
	}

	// Mirrors getBoundPromptVersion exactly, which is the whole job of this
	// function: the badge must name the tier that actually runs. Since a
	// personal default now wins inside an organization (FR3), the caller's own
	// USER bindings belong in this set — and `resolvePromptBindingStatus`
	// already ranks USER above everything, so the badge reports the true
	// precedence.
	//
	// Always scoped to `userId`: one person's override must never badge for
	// another. Project bindings are ORG rows narrowed by projectId, so the
	// caller's organization gates them, never the project id alone.
	const scopeConditions: any[] = [{ scope: "SYSTEM" }];
	if (organizationId) {
		// Project bindings ride beside org-wide ones; the pure ranker below
		// decides which tier actually wins. (`in: [id, null]` is not valid
		// Prisma — null inside an `in` list needs its own OR arm.)
		scopeConditions.push(
			projectId
				? {
						scope: "ORG",
						organizationId,
						OR: [{ projectId }, { projectId: null }],
					}
				: { scope: "ORG", organizationId, projectId: null },
		);
	}
	if (userId) {
		scopeConditions.push({ scope: "USER", userId });
	}

	const bindings = await db.promptBinding.findMany({
		where: {
			...(documentType ? { documentType } : {}),
			targetType: "AGENT",
			OR: scopeConditions,
			promptVersion: {
				promptId: { in: promptIds },
			},
		},
		include: {
			promptVersion: {
				select: { promptId: true },
			},
		},
	});

	// Precedence is resolved per target by the pure helper above — previously
	// this computed the best scope per prompt and then discarded it, marking a
	// prompt default if it won at ANY scope. With a personal override in place
	// that badged both the override and the system default it shadows.
	return resolvePromptBindingStatus(
		bindings.map((b) => ({
			promptId: b.promptVersion.promptId,
			targetKey: b.targetKey,
			documentType: b.documentType,
			// Carried through so bindings for different story kinds are ranked
			// as the separate actions they are, not against each other.
			storyKind: b.storyKind,
			scope: b.scope,
			projectId: b.projectId,
			isDefault: b.isDefault,
		})),
	);
}

export async function listAvailablePromptsForAgent({
	agentName,
	userId,
	organizationId,
	documentType,
	storyKind,
}: {
	agentName: string;
	userId?: string;
	organizationId?: string;
	documentType?: string;
	/** Kind discriminator for stage bindings. When provided, only bindings
	 *  with this exact storyKind match — no cross-bucket fallback. */
	storyKind?: StoryKind | null;
}) {
	// If documentType is provided, use binding-first architecture
	if (documentType) {
		// Build binding conditions: SYSTEM always, plus tenant-specific scopes.
		// USER bindings (personal preference) are always included for the current user
		// regardless of context — they represent the user's prompt override.
		const bindingConditions: any[] = [{ scope: "SYSTEM" }];

		if (organizationId) {
			bindingConditions.push({ scope: "ORG", organizationId });
		}

		if (userId) {
			bindingConditions.push({ scope: "USER", userId });
		}

		const bindingWhere: any = {
			targetType: "AGENT",
			targetKey: agentName,
			documentType,
			OR: bindingConditions,
		};

		// Kind-scoped filter mirrors getBoundPromptForAgent's exact-match
		// semantics so BUG-stage callers never surface FEATURE prompts (and vice
		// versa). `undefined` keeps the legacy unfiltered behavior for callers
		// that haven't adopted storyKind yet.
		if (storyKind !== undefined) {
			bindingWhere.storyKind = storyKind;
		}

		// Fetch bindings with their prompts
		const bindings = await db.promptBinding.findMany({
			where: bindingWhere,
			// NO orderBy here - we'll sort in JavaScript to respect scope precedence
			include: {
				promptVersion: {
					include: {
						prompt: {
							include: {
								forkedFrom: {
									select: {
										id: true,
										key: true,
										name: true,
										scope: true,
									},
								},
							},
						},
					},
				},
			},
		});

		// Map bindings to prompt format
		const prompts = bindings.map((binding) => {
			const prompt = binding.promptVersion.prompt;
			const content = binding.promptVersion.content ?? "";
			return {
				id: prompt.id,
				key: prompt.key,
				name: prompt.name,
				description: prompt.description,
				scope: prompt.scope,
				category: prompt.category,
				tags: prompt.tags,
				forkedFrom: prompt.forkedFrom,
				isBound: true,
				isDefault: binding.isDefault,
				contentSnippet:
					content.length > 200
						? `${content.slice(0, 200)}...`
						: content,
				latestVersion: {
					id: binding.promptVersion.id,
					version: binding.promptVersion.version,
				},
			};
		});

		// Sort by scope precedence (USER > ORG > SYSTEM), then by isDefault, then by createdAt
		// This ensures USER-scoped defaults take precedence over SYSTEM-scoped defaults
		const scopeOrder = { USER: 0, ORG: 1, SYSTEM: 2 };
		const sorted = prompts.sort((a, b) => {
			// First, sort by scope (USER first, then ORG, then SYSTEM)
			const scopeDiff = scopeOrder[a.scope] - scopeOrder[b.scope];
			if (scopeDiff !== 0) {
				return scopeDiff;
			}

			// Within same scope, sort by isDefault (true first)
			if (a.isDefault !== b.isDefault) {
				return a.isDefault ? -1 : 1;
			}

			// If both have same scope and isDefault status, maintain original order
			return 0;
		});

		// Only the highest-precedence default should be marked as isDefault.
		// When a USER binding is default, lower-precedence SYSTEM/ORG defaults
		// should not also show the "Default" badge in the UI.
		let foundDefault = false;
		for (const prompt of sorted) {
			if (prompt.isDefault) {
				if (foundDefault) {
					prompt.isDefault = false;
				} else {
					foundDefault = true;
				}
			}
		}

		return sorted;
	}

	// Fallback: If no documentType, return all prompts (for backward compatibility)
	// This is used in scenarios where document type is not yet selected
	// XOR PATTERN: Strict context isolation
	const conditions: any[] = [{ scope: "SYSTEM" }];

	if (organizationId) {
		// ORGANIZATION CONTEXT: SYSTEM + ORG only (no USER prompts)
		conditions.push({ scope: "ORG", organizationId });
	} else if (userId) {
		// PERSONAL CONTEXT: SYSTEM + USER only (no ORG prompts)
		conditions.push({ scope: "USER", userId });
	}

	const where: any = {
		OR: conditions,
	};

	const prompts = await db.prompt.findMany({
		where,
		orderBy: [{ usageCount: "desc" }, { name: "asc" }],
		include: {
			versions: {
				orderBy: { version: "desc" },
				take: 1,
			},
			forkedFrom: {
				select: {
					id: true,
					key: true,
					name: true,
					scope: true,
				},
			},
		},
	});

	return prompts.map((prompt) => {
		const content = prompt.versions[0]?.content ?? "";
		return {
			id: prompt.id,
			key: prompt.key,
			name: prompt.name,
			description: prompt.description,
			scope: prompt.scope,
			category: prompt.category,
			tags: prompt.tags,
			forkedFrom: prompt.forkedFrom,
			isBound: false,
			isDefault: false,
			contentSnippet:
				content.length > 200 ? `${content.slice(0, 200)}...` : content,
			latestVersion: prompt.versions[0]
				? {
						id: prompt.versions[0].id,
						version: prompt.versions[0].version,
					}
				: null,
		};
	});
}

export type StageDefaultBinding = {
	id: string;
	scope: "USER" | "ORG" | "SYSTEM";
	versionId: string;
	isDefault: boolean;
};

export type StagePromptPayload = Awaited<
	ReturnType<
		typeof db.promptBinding.findMany<{
			include: {
				promptVersion: {
					include: {
						prompt: {
							include: {
								_count: { select: { versions: true } };
								versions: {
									orderBy: { version: "desc" };
									take: 1;
								};
								forkedFrom: {
									select: {
										id: true;
										key: true;
										name: true;
										scope: true;
									};
								};
							};
						};
					};
				};
			};
		}>
	>
>[number]["promptVersion"]["prompt"];

export type StageBindingsEntry = {
	documentType: string;
	bindings: Array<{
		prompt: StagePromptPayload;
		binding: StageDefaultBinding;
	}>;
};

/**
 * List all prompts bound to each (agent, documentType) pair, surfacing
 * `isDefault` on each entry so callers can highlight defaults without
 * collapsing the result set.
 *
 * Scope visibility mirrors the runtime resolver in `getBoundPromptVersion`:
 *  - SYSTEM bindings always visible.
 *  - Organization context (`organizationId` set): USER + ORG + SYSTEM, with the
 *    caller's own personal binding taking precedence — it is what actually runs
 *    for them there (FR3). Always scoped to `userId`, so one person's override
 *    is never visible to another.
 *  - Personal context (`organizationId` null/undefined): USER + SYSTEM.
 *
 * When `scope` is provided, results are restricted to that single scope.
 */
export async function listPromptsForStages({
	agentName,
	documentTypes,
	storyKind,
	userId,
	organizationId,
	projectId,
	scope,
}: {
	agentName: string;
	documentTypes: string[];
	// Exact-match filter against PromptBinding.storyKind. Pass "BUG" / "FEATURE"
	// to list stage bindings for that kind; omit or pass null for non-kind-
	// scoped bindings (matches rows where storyKind IS NULL).
	storyKind?: StoryKind | null;
	userId?: string;
	organizationId?: string | null;
	/** Include PROJECT-tier bindings for this project alongside org-wide ones. */
	projectId?: string | null;
	scope?: "SYSTEM" | "ORG" | "USER";
}): Promise<StageBindingsEntry[]> {
	const emptyResult = () =>
		documentTypes.map((documentType) => ({
			documentType,
			bindings: [],
		}));

	let scopeConditions: Array<Record<string, unknown>>;
	if (scope === "SYSTEM") {
		scopeConditions = [{ scope: "SYSTEM" }];
	} else if (scope === "ORG") {
		if (!organizationId) {
			return emptyResult();
		}
		scopeConditions = [{ scope: "ORG", organizationId }];
	} else if (scope === "USER") {
		// Reachable in either context now: a personal binding is what runs for
		// this caller even inside an organization.
		if (!userId) {
			return emptyResult();
		}
		scopeConditions = [{ scope: "USER", userId }];
	} else {
		scopeConditions = [{ scope: "SYSTEM" }];
		if (organizationId) {
			scopeConditions.push(
				projectId
					? {
							scope: "ORG",
							organizationId,
							OR: [{ projectId }, { projectId: null }],
						}
					: { scope: "ORG", organizationId },
			);
		}
		if (userId) {
			scopeConditions.push({ scope: "USER", userId });
		}
	}

	const bindings = await db.promptBinding.findMany({
		where: {
			targetType: "AGENT",
			targetKey: agentName,
			documentType: { in: documentTypes },
			storyKind: storyKind ?? null,
			OR: scopeConditions,
		},
		include: {
			promptVersion: {
				include: {
					prompt: {
						include: {
							_count: { select: { versions: true } },
							versions: {
								orderBy: { version: "desc" },
								take: 1,
							},
							forkedFrom: {
								select: {
									id: true,
									key: true,
									name: true,
									scope: true,
								},
							},
						},
					},
				},
			},
		},
	});

	const scopeRank: Record<string, number> = SCOPE_RANK;
	const groupedByDocType = new Map<string, StageBindingsEntry["bindings"]>();
	for (const binding of bindings) {
		const existing = groupedByDocType.get(binding.documentType) ?? [];
		// Surface the BOUND version (not the prompt's latest) so PromptCard
		// renders the content + version id the runtime actually uses via
		// getBoundPromptForAgent. The latest version is still accessible via
		// the prompt detail page.
		const promptForRow = {
			...binding.promptVersion.prompt,
			versions: [binding.promptVersion],
		} as StagePromptPayload;
		existing.push({
			prompt: promptForRow,
			binding: {
				id: binding.id,
				scope: effectiveTier(binding) as "USER" | "ORG" | "SYSTEM",
				versionId: binding.promptVersion.id,
				isDefault: binding.isDefault,
			},
		});
		groupedByDocType.set(binding.documentType, existing);
	}

	// Sort each stage's bindings by tier rank (USER > PROJECT > ORG > SYSTEM),
	// then isDefault desc within tier so the most-specific default appears
	// first.
	for (const entries of groupedByDocType.values()) {
		entries.sort((a, b) => {
			const rankDiff =
				(scopeRank[a.binding.scope] ?? 99) -
				(scopeRank[b.binding.scope] ?? 99);
			if (rankDiff !== 0) {
				return rankDiff;
			}
			if (a.binding.isDefault !== b.binding.isDefault) {
				return a.binding.isDefault ? -1 : 1;
			}
			return 0;
		});
	}

	return documentTypes.map((documentType) => ({
		documentType,
		bindings: groupedByDocType.get(documentType) ?? [],
	}));
}
