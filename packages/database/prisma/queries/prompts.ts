import { logger } from "@repo/logs";
import { promptDocumentTypeLabel } from "@repo/utils/prompt-action-catalog";
import { db, Prisma } from "../client";
import type { PromptFormat, PromptScope, StoryKind } from "../generated/client";
import { advisoryObjectKey } from "./lib/refresh-lock-key";

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

	// A personal prompt belongs to its author in every context, an organization
	// included — the same exception the binding resolvers make. The userId filter
	// is what isolates it: nobody ever reaches a prompt that is not their own.
	if (opts.userId) {
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
 * Create a new prompt.
 *
 * A SYSTEM-scope insert goes through {@link insertSystemPromptUnlessRetired}
 * and is REFUSED when the key carries a retirement record (R9): creating a
 * prompt under a retired key through the product API would be an unaudited
 * restore by a different name. The operator path — remove the record, then run
 * a catalogue seed — stays the only way back.
 *
 * ORG and USER scopes are untouched by that guard. A retirement is a statement
 * about the platform's own catalogue key, and a tenant's own prompt happening
 * to share the key is nobody else's business (the deletion leaves it alone for
 * the same reason).
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
	const data = {
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
	};

	// Create initial version if content provided.
	// TENANT ISOLATION: version row must mirror parent Prompt's tenancy exactly
	// (XOR pattern) so version-level access checks and RLS stay consistent.
	const versionData = (promptId: string, content: string) => ({
		promptId,
		version: 1,
		content,
		variables: initialVariables ?? {},
		createdBy,
		scope,
		userId: scope === "USER" ? (userId ?? null) : null,
		organizationId: scope === "ORG" ? (organizationId ?? null) : null,
	});

	if (scope === "SYSTEM") {
		// The prompt row and its first version are written INSIDE the guarded
		// transaction, so a deletion committing mid-create cannot leave a
		// version orphaned on a row it is about to remove.
		const prompt = await insertSystemPromptUnlessRetired({
			key,
			insert: async (tx) => {
				const created = await tx.prompt.create({ data });
				if (initialContent) {
					await tx.promptVersion.create({
						data: versionData(created.id, initialContent),
					});
				}
				return created;
			},
		});

		if (!prompt) {
			throw new PromptKeyRetiredError(key);
		}

		return prompt;
	}

	const prompt = await db.prompt.create({ data });

	if (initialContent) {
		await db.promptVersion.create({
			data: versionData(prompt.id, initialContent),
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

// ============================================================================
// SYSTEM prompt key retirement (Fizzy #2328 — R9, R14, KTD4, KTD5)
// ============================================================================

/**
 * Advisory-lock class id namespacing SYSTEM-prompt key retirement (arbitrary
 * but stable). A DISTINCT class from `REFRESH_ADVISORY_CLASS` in
 * `./lib/refresh-lock-key.ts` and from the pipeline-sync class in
 * `./projects/pipeline-results.ts` — Postgres keeps
 * `pg_advisory_xact_lock(int4, int4)` id spaces separate per class, so this
 * domain needs its own rather than accidentally sharing one.
 *
 * Deliberately stays in the `(int4, int4)` space the rest of this repo uses
 * rather than the bigint form: `lib/refresh-lock-key.ts` documents an incident
 * caused by the same logical lock living in BOTH spaces, where neither ever
 * blocked the other. The residual risk of the shared 32-bit hash is contention
 * only — two unrelated keys colliding briefly serialize — never correctness,
 * because every statement inside the lock still keys off the full prompt key.
 */
const PROMPT_KEY_RETIREMENT_ADVISORY_CLASS = 0x50524b52; // "PRKR"

/** How long a deletion may hold the key lock before the transaction gives up.
 *  Sized above the largest plausible cascade: a SYSTEM prompt's versions can
 *  carry bindings in every tenant on the platform, and all of them go in this
 *  one transaction. */
const PROMPT_DELETE_TRANSACTION_TIMEOUT_MS = 60_000;
/** How long to wait for a POOL CONNECTION, before the transaction opens.
 *  Prisma's `maxWait` bounds acquiring the transaction and nothing that
 *  happens inside it — the key lock is taken in the transaction body, so this
 *  number says nothing about waiting for it (see
 *  {@link PROMPT_CREATE_LOCK_TIMEOUT_MS}, which does). */
const PROMPT_DELETE_MAX_WAIT_MS = 10_000;

/**
 * Take the per-key retirement lock inside an already-open transaction.
 *
 * The deletion takes it before it reads anything, and every path that CREATES a
 * SYSTEM prompt takes the same lock before its own insert (U5). That is what
 * stops a creator reading "not retired", losing the race to a deletion, and
 * then inserting on a decision that is already stale.
 *
 * MUST use `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock()` returns
 * `void`, which the Postgres driver adapter's `$queryRaw` cannot deserialize
 * ("Failed to deserialize column of type 'void'"). Mirrors `withRefreshLock`
 * in `./lib/refresh-lock.ts`, where that throw silently aborted every token
 * refresh.
 */
export async function acquirePromptKeyRetirementLock(
	tx: Prisma.TransactionClient,
	key: string,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROMPT_KEY_RETIREMENT_ADVISORY_CLASS}::int, ${advisoryObjectKey(key)}::int)`;
}

/**
 * Did the database tell us `retired_prompt_key` does not exist?
 *
 * A seed run against a database that predates this table's migration must
 * degrade to "nothing is retired" rather than throw: the ordered seed runner
 * (`scripts/deploy-seeds.ts`) aborts every later entry when one fails, so a
 * missing table would take the whole catalogue down instead of one guard.
 */
function isMissingRetirementTable(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	// P2021 is Prisma's own "table does not exist in the current database".
	// 42P01 is Postgres' `undefined_table` SQLSTATE, which is what surfaces
	// when the driver adapter passes the database's error through untranslated.
	if (code === "P2021" || code === "42P01") {
		return true;
	}
	const message = error instanceof Error ? error.message : "";
	return message.includes("retired_prompt_key") && message.includes("exist");
}

/**
 * Which of these prompt keys have been retired.
 *
 * ONE query for the whole set, never one per prompt: both seeds walk an array
 * of dozens of catalogue entries, and a per-entry lookup would turn a single
 * round trip into dozens on every deploy. Callers pass the keys they are about
 * to consider and read the answer out of the returned set.
 *
 * Pass no argument to read every retirement (operator tooling, tests).
 *
 * TOLERATES THE TABLE NOT EXISTING. See {@link isMissingRetirementTable}: a
 * database that predates the migration logs a warning and reports "nothing is
 * retired", which is the pre-change behaviour, rather than failing the seed and
 * taking every later seed entry with it. The warning is the detection signal —
 * a key that stops being skipped between two runs means either the migration is
 * missing or a record was removed.
 */
export async function getRetiredPromptKeys(
	keys?: string[],
): Promise<Set<string>> {
	if (keys && keys.length === 0) {
		return new Set();
	}

	try {
		const rows = await db.retiredPromptKey.findMany({
			where: keys ? { key: { in: keys } } : undefined,
			select: { key: true },
		});
		return new Set(rows.map((row) => row.key));
	} catch (error) {
		if (isMissingRetirementTable(error)) {
			logger.warn(
				"[prompts] retired_prompt_key is missing — treating every key as not retired. Run the pending migration before the next catalogue seed.",
				{
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			return new Set();
		}
		throw error;
	}
}

/**
 * Record that a SYSTEM prompt key has been retired.
 *
 * An UPSERT keyed by `key`, so retiring the same key twice refreshes the record
 * rather than failing on the unique index — which is what happens whenever a
 * duplicate SYSTEM row is created after a retirement and then deleted again.
 *
 * `client` exists so the deletion can pass its own transaction: a retirement
 * that commits apart from the deletion (or the other way round) is the exact
 * failure this record exists to prevent — a prompt deleted with no record is
 * silently resurrectable, and a record with no deletion vetoes a live prompt.
 */
export async function recordPromptKeyRetirement({
	key,
	retiredBy,
	client = db,
}: {
	key: string;
	retiredBy: string;
	client?: Prisma.TransactionClient;
}) {
	return client.retiredPromptKey.upsert({
		where: { key },
		create: { key, retiredBy },
		update: { retiredBy, retiredAt: new Date() },
	});
}

/**
 * A creation was refused because the key is recorded as retired (R9).
 *
 * Carries a stable `code` because that is how the procedures in this module
 * classify a database failure — see the `P2025` duck-typing in
 * `packages/api/modules/prompts/procedures/delete.ts`. The handler never
 * imports this class, so a test can hand it a plain object carrying the code
 * and the refusal survives module mocking.
 */
export class PromptKeyRetiredError extends Error {
	readonly code = "PROMPT_KEY_RETIRED";
	readonly promptKey: string;

	constructor(key: string) {
		super(
			`The prompt key "${key}" is recorded as retired; creating it again would undo a deliberate deletion.`,
		);
		this.name = "PromptKeyRetiredError";
		this.promptKey = key;
	}
}

/**
 * A SYSTEM deletion was refused because `retired_prompt_key` is not there to
 * record it (R9).
 *
 * The read paths degrade to "nothing is retired" when the table is missing, and
 * that is right for them: the worst case is a prompt that could have been
 * skipped getting seeded. A DELETION cannot degrade the same way. Removing the
 * rows without the record produces precisely the state the record exists to
 * prevent — a prompt the next catalogue seed puts back under its seed name,
 * with nothing anywhere saying it was deliberately retired.
 *
 * Carries a stable `code` for the same reason {@link PromptKeyRetiredError}
 * does: the delete procedure duck-types on codes (`P2025`, and this) rather
 * than importing error classes, so the classification survives module mocking.
 */
export class PromptRetirementUnavailableError extends Error {
	readonly code = "PROMPT_RETIREMENT_UNAVAILABLE";
	readonly promptKey: string;

	constructor(key: string) {
		super(
			`The prompt key "${key}" cannot be retired: retired_prompt_key does not exist in this database. Run the pending migration, then delete again.`,
		);
		this.name = "PromptRetirementUnavailableError";
		this.promptKey = key;
	}
}

/** How long a guarded creation may hold the key lock. Far below the deletion's
 *  budget: a creation writes two rows, while a deletion cascades through every
 *  binding on the platform. What it mostly waits for is a deletion in flight,
 *  and the ceiling is deliberately lower than that deletion's — a creation that
 *  waited the full cascade would hold a request open for a minute to be told
 *  the key is now retired. It fails instead, and the retry gets the refusal. */
const PROMPT_CREATE_TRANSACTION_TIMEOUT_MS = 15_000;
/** How long to wait for a POOL CONNECTION, before the transaction opens.
 *  Prisma's `maxWait` bounds acquiring the transaction and nothing that
 *  happens inside it. */
const PROMPT_CREATE_MAX_WAIT_MS = 10_000;
/** How long a creation may WAIT FOR THE KEY LOCK, applied inside the
 *  transaction because nothing outside it can bound a statement in its body.
 *  Without this the wait is bounded only by the transaction budget — and
 *  arguably not even by that, since the connection stays pinned to Postgres
 *  until the lock is granted whatever the client has given up on. A deletion
 *  can hold the key for a minute, so creations arriving behind one would each
 *  pin a pool connection for the whole cascade. Sized well inside the creation
 *  budget so contention surfaces as a prompt, catchable failure (SQLSTATE
 *  55P03) and the retry gets a real answer — usually the refusal, because what
 *  a creation mostly waits behind is the deletion that retires its key. */
const PROMPT_CREATE_LOCK_TIMEOUT_MS = 5_000;

/**
 * Does `retired_prompt_key` exist, asked from INSIDE an open transaction?
 *
 * A PROBE rather than a try/catch, and that is load-bearing. Querying a table
 * that does not exist raises inside the transaction, and Postgres then refuses
 * every later statement in it ("current transaction is aborted") — so the
 * tolerate-a-missing-table degradation {@link getRetiredPromptKeys} performs
 * with a try/catch cannot be written that way in here: catching the error would
 * leave a transaction that can no longer write anything. `to_regclass` returns
 * NULL for an absent relation instead of raising, so this is safe to run before
 * the table is guaranteed to exist. Unqualified on purpose, so it resolves
 * against the same `search_path` the rest of the client uses.
 *
 * The two callers do OPPOSITE things with the answer, and both are right: a
 * creation carries on unguarded (a database that predates the migration behaves
 * as it did before), while a deletion refuses outright, because a SYSTEM
 * deletion whose record cannot be written is exactly the silently-resurrectable
 * prompt the record exists to prevent.
 */
async function retirementTableExists(
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const probe = await tx.$queryRaw<{ present: boolean }[]>`
		SELECT to_regclass('retired_prompt_key') IS NOT NULL AS present
	`;

	return probe[0]?.present === true;
}

/**
 * Is this key retired, asked from INSIDE an open transaction?
 *
 * Deliberately not {@link getRetiredPromptKeys}: that one reads through the
 * top-level client, so its answer is taken outside whatever transaction the
 * caller is in and can go stale before the insert lands. This one reads under
 * the caller's advisory lock, which is what makes the decision and the insert
 * one atomic step.
 *
 * PROBES THE CATALOG FIRST — see {@link retirementTableExists} for why that
 * ordering cannot be replaced by a try/catch.
 */
async function isPromptKeyRetiredWithin(
	tx: Prisma.TransactionClient,
	key: string,
): Promise<boolean> {
	if (!(await retirementTableExists(tx))) {
		logger.warn(
			"[prompts] retired_prompt_key is missing — creating without the retirement guard. Run the pending migration before the next catalogue seed.",
			{ key },
		);
		return false;
	}

	const record = await tx.retiredPromptKey.findUnique({
		where: { key },
		select: { key: true },
	});

	return record !== null;
}

/**
 * Insert a SYSTEM prompt unless its key has been retired — the ONE creation
 * boundary every SYSTEM-scope insert goes through (R9, KTD5).
 *
 * Returns `null` when the key is recorded, having written nothing. A seed turns
 * that into a logged skip and carries on with the rest of the catalogue;
 * `createPrompt` turns it into a {@link PromptKeyRetiredError} for the product
 * API. Neither decides for itself whether the key is retired.
 *
 * THE CHECK AND THE INSERT SHARE ONE TRANSACTION, serialized per key by the
 * same advisory lock the deletion takes. A read followed by an insert would be
 * a decision made on state that can change in between: a deletion committing in
 * that window leaves the caller inserting a prompt whose retirement is already
 * recorded, which is exactly the resurrection this guard exists to prevent.
 * A caller may pre-filter with {@link getRetiredPromptKeys} to avoid opening a
 * transaction per catalogue entry — the seeds do — but that read is an
 * optimization, never the decision.
 *
 * The callback receives the transaction client and MUST write through it.
 */
export async function insertSystemPromptUnlessRetired<T>({
	key,
	insert,
}: {
	key: string;
	insert: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<T | null> {
	return db.$transaction(
		async (tx) => {
			// Bound the wait for the key lock BEFORE asking for it. Nothing
			// outside the transaction can do this: `maxWait` is spent by the
			// time this callback runs. `set_config(..., true)` is `SET LOCAL`
			// in a form that takes a bind parameter — the utility statement
			// does not — so it dies with this transaction and no value is ever
			// interpolated into SQL.
			await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${PROMPT_CREATE_LOCK_TIMEOUT_MS}ms`}, true)`;

			await acquirePromptKeyRetirementLock(tx, key);

			if (await isPromptKeyRetiredWithin(tx, key)) {
				return null;
			}

			return insert(tx);
		},
		{
			timeout: PROMPT_CREATE_TRANSACTION_TIMEOUT_MS,
			maxWait: PROMPT_CREATE_MAX_WAIT_MS,
		},
	);
}

/**
 * What a deletion actually removed — not what a pre-flight snapshot predicted
 * it would (R15).
 *
 * Field names mirror {@link PlatformWidePromptDeletionImpact} on purpose: the
 * confirmation dialog and the completion message describe the same quantities,
 * so one formatter serves both and a reader can compare the two figures
 * directly when a binding was written between them.
 */
export type PromptDeletionResult = {
	/** The deleted prompt's key — the key a retirement record now carries. */
	promptKey: string;
	/** The deleted prompt's scope, so a caller can report a SYSTEM retirement
	 *  differently from an ordinary tenant deletion. */
	scope: PromptScope;
	/** Prompt rows removed. More than one only for SYSTEM, where every row
	 *  carrying the key goes together (R14). */
	promptRowCount: number;
	/** Bindings removed, of every target type, in every tenant. Derived from
	 *  the deletion itself, so a binding written after the pre-flight snapshot
	 *  is in this number. */
	bindingCount: number;
	/** Distinct organizations that lost at least one binding. */
	organizationCount: number;
	/** Distinct PEOPLE who lost a personal override. */
	personalOverrideUserCount: number;
	/** De-duplicated, sorted, already humanized for display. */
	documentTypeLabels: string[];
	/** True when a retirement record was written — SYSTEM deletions only. */
	retirementRecorded: boolean;
};

/**
 * The error a caller maps to "this prompt has already been deleted".
 *
 * Raised with Prisma's own `P2025` code rather than a bespoke class so the
 * procedure above has ONE not-found shape to handle: the single-row delete
 * raises `P2025` by itself, and the multi-row SYSTEM path — which removes zero
 * rows SILENTLY rather than raising anything — raises the same thing through
 * the in-transaction recheck. Without that, "somebody deleted it a moment ago"
 * would surface as an internal error on one path and a cheerful success on the
 * other (R11).
 */
function promptAlreadyDeleted(id: string): Error {
	return new Prisma.PrismaClientKnownRequestError(
		`Prompt ${id} no longer exists`,
		{ code: "P2025", clientVersion: "n/a" },
	);
}

/**
 * Split prompt bindings into the three figures an operator is shown.
 *
 * Identifiers are gathered to be COUNTED and then dropped; none of these sets
 * leaves this function.
 *
 * No organization leaves two cases, and they are not the same thing. A row with
 * a userId is one person's own override (bind.ts writes USER bindings with the
 * caller's id and no organization). A row with neither is the platform's OWN
 * SYSTEM-tier binding — the one both seeds create for every seeded prompt.
 * Folding those into the personal figure would tell an operator that people hold
 * overrides they have never set. Both stay in the binding total; only the first
 * is a person.
 *
 * Shared by the pre-flight impact read and the deletion itself so the two can
 * never disagree about what a binding means.
 */
function tallyBindingImpact(
	bindings: {
		documentType: string;
		organizationId: string | null;
		userId: string | null;
	}[],
): {
	organizationCount: number;
	personalOverrideUserCount: number;
	documentTypeLabels: string[];
} {
	const organizationIds = new Set<string>();
	const overrideUserIds = new Set<string>();
	const documentTypeLabels = new Set<string>();

	for (const binding of bindings) {
		documentTypeLabels.add(promptDocumentTypeLabel(binding.documentType));

		if (binding.organizationId) {
			organizationIds.add(binding.organizationId);
			continue;
		}

		if (binding.userId) {
			overrideUserIds.add(binding.userId);
		}
	}

	return {
		organizationCount: organizationIds.size,
		personalOverrideUserCount: overrideUserIds.size,
		documentTypeLabels: [...documentTypeLabels].sort(),
	};
}

/**
 * Delete a prompt, and for a SYSTEM prompt record that its key is retired.
 *
 * Authorization is enforced by the delete procedure before calling this.
 *
 * ONE TRANSACTION, in this order:
 *
 *  1. Take the per-key advisory lock, so a creation of the same key cannot
 *     interleave with this deletion (KTD5). U5 takes the same lock on the
 *     creation side; the two are useless apart.
 *  2. Re-read the selected row INSIDE the transaction. The SYSTEM path deletes
 *     by key, and a multi-row delete that matches nothing removes zero rows
 *     silently instead of raising not-found — so without this recheck a
 *     deletion of an already-deleted prompt would report success. The recheck
 *     is what makes that outcome reportable (R11).
 *  3. Lock the versions the bindings hang off (FOR UPDATE), so no other
 *     session can commit a binding against them while this runs — an insert
 *     takes FOR KEY SHARE on the version it references, and that conflicts.
 *     The window this closes is narrow and one-directional: a binding written
 *     after the delete below is cascaded away by the version delete, removed
 *     and unreportable.
 *  4. Delete the bindings EXPLICITLY, twice, and take every figure from those
 *     deletions' own RETURNING rows. A count taken before the delete would miss
 *     a binding inserted in between — the report has to be an account of what
 *     happened, not a prediction that preceded it (R15). The second delete
 *     catches anything attached to a version created after the lock, and
 *     RETURNS it rather than counting it, so the organization, personal-override
 *     and document-type figures cover the same rows the total does.
 *  5. Delete the versions and the prompt rows, and for SYSTEM write the
 *     retirement record ONCE. A deletion that commits without its record is
 *     silently resurrectable by the next catalogue seed, which is why the two
 *     share a transaction rather than being two statements in a row — and why a
 *     SYSTEM deletion is refused outright when the record's table is missing.
 *
 * SCOPE DECIDES HOW MANY ROWS, NOT WHICH TABLES. A SYSTEM deletion takes every
 * SYSTEM row carrying the key — duplicate SYSTEM keys are legal, the unique
 * index spans two nullable owner columns and Postgres treats NULLs as distinct,
 * and resolution takes the first match, so leaving a survivor would be a
 * deletion that is reported, recorded and ineffective (R14). An ORG or USER
 * deletion takes exactly the row it was given. Prompts at another scope that
 * happen to share the key are never touched, and only SYSTEM writes a record.
 */
export async function deletePrompt({
	id,
	deletedBy,
}: {
	id: string;
	deletedBy: string;
}): Promise<PromptDeletionResult> {
	// Read the key OUTSIDE the transaction only to address the lock — every
	// decision below is re-made inside it, against rows read under the lock.
	const selected = await db.prompt.findUnique({
		where: { id },
		select: { id: true, key: true },
	});

	if (!selected) {
		throw promptAlreadyDeleted(id);
	}

	return db.$transaction(
		async (tx) => {
			// 1. Serialize against every creation of this key (KTD5).
			await acquirePromptKeyRetirementLock(tx, selected.key);

			// 2. Whatever we read before the lock may be gone by now.
			const prompt = await tx.prompt.findUnique({
				where: { id },
				select: { id: true, key: true, scope: true },
			});

			if (!prompt) {
				throw promptAlreadyDeleted(id);
			}

			const isSystem = prompt.scope === "SYSTEM";

			// A SYSTEM key can name several rows; every other scope names one.
			const promptIds = isSystem
				? (
						await tx.prompt.findMany({
							where: { key: prompt.key, scope: "SYSTEM" },
							select: { id: true },
						})
					).map((row) => row.id)
				: [prompt.id];

			// A SYSTEM deletion that cannot record its retirement is refused,
			// and refused HERE — before the locks and the cascade — so a
			// database missing the table costs one probe rather than a full
			// deletion that is then rolled back. The read paths tolerate the
			// table being absent; this path cannot, because rows removed
			// without a record are exactly the silently-resurrectable prompt
			// the record exists to prevent. Probed rather than caught: see
			// `retirementTableExists` for why a try/catch is not available
			// inside a transaction.
			if (isSystem && !(await retirementTableExists(tx))) {
				throw new PromptRetirementUnavailableError(prompt.key);
			}

			// 3. Shut the door before removing anything. Inserting a
			// prompt_binding takes FOR KEY SHARE on the prompt_version row
			// its foreign key names, and FOR KEY SHARE conflicts with FOR
			// UPDATE — so from here on no other session can COMMIT a new
			// binding against a version this transaction is about to
			// delete. Without it, a binding inserted between the delete
			// below and the version delete is cascaded away by that version
			// delete: removed, and gone before any statement here could
			// have seen it.
			await tx.$queryRaw<{ id: string }[]>`
				SELECT "id" FROM "prompt_version"
				WHERE "promptId" IN (${Prisma.join(promptIds)})
				FOR UPDATE
			`;

			// 4. The bindings, removed and counted in the same statement.
			// `deleteMany` reports only a count, and a count cannot say which
			// organizations lost a default — so this is raw SQL with RETURNING
			// rather than a read followed by a delete.
			const removed = await tx.$queryRaw<
				{
					documentType: string;
					organizationId: string | null;
					userId: string | null;
				}[]
			>`
				DELETE FROM "prompt_binding"
				WHERE "promptVersionId" IN (
					SELECT "id" FROM "prompt_version"
					WHERE "promptId" IN (${Prisma.join(promptIds)})
				)
				RETURNING "documentType", "organizationId", "userId"
			`;

			// The lock above covers the versions that EXISTED when it was
			// taken; a version created after it is outside it and can still
			// gain a binding. So sweep again — and sweep with a DELETE that
			// RETURNS, never a count. A count would raise `bindingCount`
			// while `organizationCount`, `personalOverrideUserCount` and
			// `documentTypeLabels` went on describing the first batch alone:
			// "1 binding removed, affecting 0 organizations", for a deletion
			// that has just taken an organization's default away. Both
			// batches feed ONE tally below, so all four figures describe the
			// same set of rows (R15).
			const stragglers = await tx.$queryRaw<
				{
					documentType: string;
					organizationId: string | null;
					userId: string | null;
				}[]
			>`
				DELETE FROM "prompt_binding"
				WHERE "promptVersionId" IN (
					SELECT "id" FROM "prompt_version"
					WHERE "promptId" IN (${Prisma.join(promptIds)})
				)
				RETURNING "documentType", "organizationId", "userId"
			`;

			const removedBindings = [...removed, ...stragglers];
			const tally = tallyBindingImpact(removedBindings);

			// 5. The versions, then the prompt rows themselves.
			await tx.promptVersion.deleteMany({
				where: { promptId: { in: promptIds } },
			});

			const { count: promptRowCount } = await tx.prompt.deleteMany({
				where: { id: { in: promptIds } },
			});

			if (isSystem) {
				await recordPromptKeyRetirement({
					key: prompt.key,
					retiredBy: deletedBy,
					client: tx,
				});
			}

			return {
				promptKey: prompt.key,
				scope: prompt.scope,
				promptRowCount,
				bindingCount: removedBindings.length,
				organizationCount: tally.organizationCount,
				personalOverrideUserCount: tally.personalOverrideUserCount,
				documentTypeLabels: tally.documentTypeLabels,
				retirementRecorded: isSystem,
			};
		},
		{
			timeout: PROMPT_DELETE_TRANSACTION_TIMEOUT_MS,
			maxWait: PROMPT_DELETE_MAX_WAIT_MS,
		},
	);
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

	/** The row this bind owns, by the columns the unique key is built on. */
	const identity = {
		targetType: targetType as any,
		targetKey,
		documentType,
		storyKind: storyKindFilter,
		scope: scope as any,
		userId: userId ?? null,
		organizationId: organizationId ?? null,
		projectId: projectId ?? null,
	};

	const run = async (tx: PromptBindingClient) => {
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
		const existing = await tx.promptBinding.findFirst({ where: identity });

		if (existing) {
			return tx.promptBinding.update({
				where: { id: existing.id },
				data: { promptVersionId, isDefault },
			});
		}

		return tx.promptBinding.create({
			data: { ...identity, promptVersionId, isDefault },
		});
	};

	// Demoting the previous default and writing the new one is one change: a
	// failure between them would leave the action with no default at all. A
	// caller that already owns a transaction keeps it, so a multi-action bind
	// still lands as a single unit.
	if (client) {
		return run(client);
	}

	try {
		return await db.$transaction((tx) => run(tx));
	} catch (error) {
		// Another caller inserted this exact row between our read and our write,
		// and the unique key rejected ours now that NULL columns compare equal.
		//
		// The retry has to be a FRESH transaction. Postgres marks a transaction
		// aborted the moment a statement in it errors — every later command
		// returns 25P02 "current transaction is aborted" until it ends — so
		// recovering inside the failed one cannot work, and the demote it
		// performed is rolled back with it. Running the whole thing again
		// re-demotes and then finds the winner's row on the read.
		const lostTheRace =
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002";
		if (!lostTheRace) {
			throw error;
		}
		return db.$transaction((tx) => run(tx));
	}
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
 * The ORG arm of a binding lookup, defined once because four readers have to
 * agree on it.
 *
 * A PROJECT binding is an ORG row narrowed by `projectId`, so "the org-wide
 * tier" means `projectId: null` and nothing else. Omitting that filter lets a
 * project-narrowed row into a ranking nobody scoped to that project, which is
 * how the catalog came to badge a prompt the runtime would never resolve.
 * `getBoundPromptVersion` keeps its own inline copy: it queries the two tiers
 * as separate statements rather than as arms of one OR.
 *
 * `in: [id, null]` is not valid Prisma for a nullable column — the null needs
 * its own OR arm.
 */
function orgScopeCondition(
	organizationId: string,
	projectId?: string | null,
): Record<string, unknown> {
	return projectId
		? {
				scope: "ORG",
				organizationId,
				OR: [{ projectId }, { projectId: null }],
			}
		: { scope: "ORG", organizationId, projectId: null };
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
		scopeConditions.push(orgScopeCondition(organizationId, projectId));
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
 * What deleting a SYSTEM prompt would take with it, counted across the whole
 * platform (Fizzy #2328, R5/R6).
 */
export type PlatformWidePromptDeletionImpact = {
	/** How many prompt rows carry the key and would be removed together (R14). */
	promptRowCount: number;
	/** Every binding the cascade would remove, of every target type, in every
	 *  tenant — including the personal overrides counted separately below. */
	bindingCount: number;
	/** Distinct organizations losing at least one binding. Never includes a
	 *  binding that has no organization. */
	organizationCount: number;
	/** Distinct PEOPLE losing a personal override, not the number of override
	 *  rows: one person can override the same prompt for several actions. */
	personalOverrideUserCount: number;
	/** De-duplicated, sorted, already humanized for display. */
	documentTypeLabels: string[];
};

/**
 * Everything a prompt deletion would remove, across every tenant on the
 * platform.
 *
 * UNSCOPED ON PURPOSE — there is no tenant predicate anywhere below. A SYSTEM
 * prompt's versions can be bound by any organization and by any individual, so
 * an impact built from the ordinary tenant-scoped read would report zero while
 * the cascade removed several. That makes reading this a privileged act:
 * CALL IT ONLY BEHIND THE SAME AUTHORITY THE DELETION ITSELF REQUIRES, never
 * from an ordinary tenant-facing procedure.
 *
 * It mirrors `listActionsForPrompt` above and departs from it exactly twice,
 * both deliberately: no scope/tenant condition, and no `targetType: "AGENT"`
 * filter. The cascade removes bindings of EVERY target type, so an impact
 * counting only AGENT rows would understate the thing it exists to warn about.
 *
 * Duplicate SYSTEM keys are legal — the unique index spans two nullable owner
 * columns and Postgres treats NULLs as distinct, which is why every lookup by
 * key uses `findFirst`. Resolution takes the first row matching a key, so a
 * deletion has to take every SYSTEM row carrying it or a survivor keeps
 * answering that key. The impact is therefore computed over that whole set,
 * and reports `promptRowCount` so the confirmation can say how many rows are
 * going (R14).
 *
 * Returns counts and display labels only: no organization id, no user id,
 * nothing that lets the caller name a tenant or a person.
 *
 * RLS: `prompt_binding` carries no row-level-security policy yet — it is listed
 * as a latent-RLS backfill in `__tests__/rls-coverage.test.ts`. When RLS
 * activates on that table this read will start being filtered and will
 * under-report exactly the cross-tenant rows it exists to surface, so it will
 * need an explicit bypass (a privileged connection) or a recorded exemption at
 * that point. Whoever activates RLS there: this is the call site to fix.
 *
 * The figures are a SNAPSHOT. A binding written between this read and the
 * deletion is not in them, which is why the deletion reports its own totals
 * rather than replaying these (R15).
 *
 * Returns null when no prompt carries the id, so a caller can report not-found
 * rather than an empty impact.
 */
export async function getPlatformWidePromptDeletionImpact({
	promptId,
}: {
	promptId: string;
}): Promise<PlatformWidePromptDeletionImpact | null> {
	const prompt = await db.prompt.findUnique({
		where: { id: promptId },
		select: { id: true, key: true, scope: true },
	});
	if (!prompt) {
		return null;
	}

	// A SYSTEM deletion takes every SYSTEM row carrying the key (R14). Any
	// other scope owns exactly one row: its key is unique within its owner.
	const promptIds =
		prompt.scope === "SYSTEM"
			? (
					await db.prompt.findMany({
						where: { key: prompt.key, scope: "SYSTEM" },
						select: { id: true },
					})
				).map((row) => row.id)
			: [prompt.id];

	// Bindings hang off VERSIONS, and a binding may point at any version, not
	// just the newest — so the question is asked of the prompt ids, never of a
	// version. No targetType filter, no tenant filter: see the doc-comment.
	const bindings = await db.promptBinding.findMany({
		where: { promptVersion: { promptId: { in: promptIds } } },
		select: { documentType: true, organizationId: true, userId: true },
	});

	const tally = tallyBindingImpact(bindings);

	return {
		promptRowCount: promptIds.length,
		bindingCount: bindings.length,
		organizationCount: tally.organizationCount,
		personalOverrideUserCount: tally.personalOverrideUserCount,
		documentTypeLabels: tally.documentTypeLabels,
	};
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
 * so a cleared row cannot accumulate into clutter. That guarantee is only real
 * from migration 20260903100000: before it the key was a plain unique index, and
 * Postgres treats NULL as distinct there, so every row shape this table actually
 * writes went unconstrained. Revert that migration and this sentence stops being
 * true.
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
		// decides which tier actually wins.
		scopeConditions.push(orgScopeCondition(organizationId, projectId));
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
	projectId,
}: {
	agentName: string;
	userId?: string;
	organizationId?: string;
	documentType?: string;
	/** Kind discriminator for stage bindings. When provided, only bindings
	 *  with this exact storyKind match — no cross-bucket fallback. */
	storyKind?: StoryKind | null;
	/** When set, this project's PROJECT-tier bindings join the list and can be
	 *  the one in force, matching what the agent resolves inside it. Without it
	 *  the list is the org-wide tier only — never another project's. */
	projectId?: string | null;
}) {
	// If documentType is provided, use binding-first architecture
	if (documentType) {
		// Build binding conditions: SYSTEM always, plus tenant-specific scopes.
		// USER bindings (personal preference) are always included for the current user
		// regardless of context — they represent the user's prompt override.
		const bindingConditions: any[] = [{ scope: "SYSTEM" }];

		if (organizationId) {
			bindingConditions.push(
				orgScopeCondition(organizationId, projectId),
			);
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

		// Order by tier precedence (USER > PROJECT > ORG > SYSTEM), then by
		// isDefault, BEFORE mapping. Only the first default survives the pass
		// below, so this order decides which prompt is badged Default and it
		// has to be the one getBoundPromptVersion would resolve.
		//
		// Ranked from the binding through the shared effectiveTier/SCOPE_RANK
		// helper. The mapped object's `scope` is the bound prompt's own catalog
		// scope, which is a different thing — a project-tier binding can point
		// at a SYSTEM prompt — so ranking by that badged the wrong row.
		bindings.sort((a, b) => {
			const rankDiff =
				SCOPE_RANK[effectiveTier(a)] - SCOPE_RANK[effectiveTier(b)];
			if (rankDiff !== 0) {
				return rankDiff;
			}
			if (a.isDefault !== b.isDefault) {
				return a.isDefault ? -1 : 1;
			}
			return 0;
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

		const sorted = prompts;

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
		scopeConditions = [orgScopeCondition(organizationId, projectId)];
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
			scopeConditions.push(orgScopeCondition(organizationId, projectId));
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
