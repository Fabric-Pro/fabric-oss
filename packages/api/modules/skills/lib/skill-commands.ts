import { randomUUID } from "node:crypto";
import {
	SKILL_MANAGEMENT_MAX_BYTES,
	type SkillActor,
	type SkillDetailDTO,
	type SkillDTO,
	SkillError,
	type SkillGovernancePolicy,
	skillArchiveSchema,
	skillCreateSchema,
	skillDeleteSchema,
	skillGetSchema,
	skillGovernancePolicySchema,
	skillGovernanceReadSchema,
	skillGovernanceUpdateSchema,
	skillListSchema,
	skillPublishSchema,
	skillRestoreSchema,
	skillUpdateSchema,
} from "@repo/ai/skill-contracts";
import { invalidateSkillCache } from "@repo/ai/skills";
import {
	db,
	hasPermission,
	Permissions,
	type Prisma,
	skillVisibilityWhere,
} from "@repo/database";
import { logDataEvent } from "@repo/logs";
import { resolveOrgPermissions } from "@repo/permissions";
import { z } from "zod";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";

type Client = Prisma.TransactionClient;
export type SkillAudit = (event: RecordAuditFromRequestInput) => unknown;
const defaultPolicy: SkillGovernancePolicy = {
	create: "permitted_members",
	publish: "permitted_members",
	discover: "permitted_members",
};
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
	const result = schema.safeParse(raw);
	if (!result.success) {
		throw new SkillError(
			"BAD_REQUEST",
			result.error.issues[0]?.message ?? "Invalid skill request.",
		);
	}
	return result.data;
}
function bounded(raw: unknown) {
	if (
		Buffer.byteLength(JSON.stringify(raw) ?? "") >
		SKILL_MANAGEMENT_MAX_BYTES
	) {
		throw new SkillError(
			"BAD_REQUEST",
			"This skill is too large. Keep the request below 1 MiB.",
		);
	}
}
async function access(actor: SkillActor, client: Client = db) {
	if (!actor.userId || !actor.organizationId) {
		throw new SkillError(
			"FORBIDDEN",
			"A current organization membership is required.",
		);
	}
	const member = await client.member.findFirst({
		where: {
			userId: actor.userId,
			organizationId: actor.organizationId,
			organization: { deletedAt: null },
		},
		select: { role: true, organization: { select: { metadata: true } } },
	});
	if (!member) {
		throw new SkillError(
			"FORBIDDEN",
			"Your current organization access is unavailable.",
		);
	}
	const permissions = resolveOrgPermissions(member.role);
	if (!hasPermission(permissions, Permissions.SKILL_READ)) {
		throw new SkillError(
			"FORBIDDEN",
			"Your current role does not allow reading skills.",
		);
	}
	let metadata: Record<string, unknown> = {};
	try {
		if (member.organization.metadata) {
			const value = JSON.parse(member.organization.metadata);
			const record = object(value);
			if (!record) {
				throw Error();
			}
			metadata = record;
		}
	} catch {
		throw new SkillError(
			"CONFLICT",
			"Organization settings could not be read safely.",
		);
	}
	let policy = defaultPolicy;
	let revision = 0;
	if (metadata.skillGovernance !== undefined) {
		const data = parse(
			z.strictObject({
				...skillGovernancePolicySchema.shape,
				revision: z.number().int().nonnegative(),
			}),
			metadata.skillGovernance,
		);
		policy = {
			create: data.create,
			publish: data.publish,
			discover: data.discover,
		};
		revision = data.revision;
	}
	const admin = ["owner", "admin"].includes(member.role);
	const allowed = (action: keyof SkillGovernancePolicy) =>
		policy[action] === "permitted_members" || admin;
	const capabilities = {
		canCreate:
			hasPermission(permissions, Permissions.SKILL_CREATE) &&
			allowed("create"),
		canPublish:
			hasPermission(permissions, Permissions.SKILL_UPDATE) &&
			allowed("publish"),
		canDiscover:
			hasPermission(permissions, Permissions.SKILL_UPDATE) &&
			allowed("publish") &&
			allowed("discover"),
	};
	return {
		permissions,
		policy,
		revision,
		capabilities,
		canManage: admin && hasPermission(permissions, Permissions.ORG_UPDATE),
		metadata,
		rawMetadata: member.organization.metadata,
	};
}
export async function assertSkillAuthoringAccess(
	actor: SkillActor,
	action: "read" | "create" | "publish" | "discover",
) {
	const a = await access(actor);
	const key = {
		create: "canCreate",
		publish: "canPublish",
		discover: "canDiscover",
	} as const;
	if (action !== "read" && !a.capabilities[key[action]]) {
		throw new SkillError(
			"FORBIDDEN",
			`Your current role and organization policy do not allow skill ${action}.`,
		);
	}
	return {
		policy: a.policy,
		revision: a.revision,
		canManage: a.canManage,
		capabilities: a.capabilities,
	};
}
type Access = Awaited<ReturnType<typeof access>>;
function capabilities(
	row: {
		scope: string;
		userId: string | null;
		organizationId: string | null;
		archivedAt: Date | null;
		isPublished: boolean;
		isDiscoverable: boolean;
	},
	actor: SkillActor,
	a: Access,
) {
	const owner =
		row.scope === "ORGANIZATION" &&
		row.organizationId === actor.organizationId &&
		row.userId === actor.userId;
	const update =
		owner && hasPermission(a.permissions, Permissions.SKILL_UPDATE);
	const live = !row.archivedAt;
	const canPublish = update && live && a.capabilities.canPublish;
	const canDiscover = canPublish && a.capabilities.canDiscover;
	return {
		canEdit:
			update &&
			live &&
			(!row.isPublished || canPublish) &&
			(!row.isDiscoverable || canDiscover),
		canArchive: update && live,
		canRestore: update && !live,
		canPublish,
		canDiscover,
		canUnpublish: update && live && row.isPublished,
		canDelete:
			owner && hasPermission(a.permissions, Permissions.SKILL_DELETE),
	};
}
const files = {
	select: { path: true, contentType: true, sizeBytes: true, version: true },
	orderBy: { path: "asc" as const },
	take: 129,
};
async function row(actor: SkillActor, id: string, client: Client = db) {
	const result = await client.skill.findFirst({
		where: {
			AND: [skillVisibilityWhere(actor, true), { id }],
		},
		include: { files },
	});
	if (!result) {
		throw new SkillError("NOT_FOUND", "Skill not found or access denied.");
	}
	return result;
}
function dto(
	value: Awaited<ReturnType<typeof row>>,
	actor: SkillActor,
	a: Access,
	includeContent: boolean,
): SkillDTO {
	return {
		id: value.id,
		slug: value.slug,
		name: value.name,
		description: value.description,
		...(includeContent ? { content: value.content } : {}),
		category: value.category,
		tags: value.tags,
		scope: value.scope as "SYSTEM" | "ORGANIZATION",
		userId: value.userId,
		organizationId: value.organizationId,
		version: value.version,
		isPublished: value.isPublished,
		isDiscoverable: value.isDiscoverable,
		archivedAt: value.archivedAt?.toISOString() ?? null,
		createdAt: value.createdAt.toISOString(),
		updatedAt: value.updatedAt.toISOString(),
		useCount: value.useCount,
		availability:
			value.scope === "SYSTEM"
				? "builtin"
				: !value.isPublished
					? "draft"
					: value.isDiscoverable
						? "agents"
						: "members",
		files: value.files.slice(0, 128),
		fileManifestComplete: value.files.length <= 128,
		capabilities: capabilities(value, actor, a),
	};
}
async function detail(actor: SkillActor, id: string) {
	const a = await access(actor);
	const value = await row(actor, id);
	await access(actor);
	return { skill: dto(value, actor, a, true) as SkillDetailDTO };
}
function own(
	value: Awaited<ReturnType<typeof row>>,
	actor: SkillActor,
	a: Access,
	permission:
		| typeof Permissions.SKILL_UPDATE
		| typeof Permissions.SKILL_DELETE = Permissions.SKILL_UPDATE,
) {
	if (
		value.scope !== "ORGANIZATION" ||
		value.organizationId !== actor.organizationId ||
		value.userId !== actor.userId ||
		!hasPermission(a.permissions, permission)
	) {
		throw new SkillError(
			"FORBIDDEN",
			"Only this skill's owner with current permission can change it.",
		);
	}
}
async function serial<T>(work: (tx: Client) => Promise<T>): Promise<T> {
	try {
		return await db.$transaction(work, { isolationLevel: "Serializable" });
	} catch (error) {
		if (
			object(error)?.code === "P2034" ||
			object(error)?.code === "P2002"
		) {
			throw new SkillError(
				"CONFLICT",
				"This skill or its settings changed. Reload before trying again.",
			);
		}
		throw error;
	}
}
async function event(
	audit: SkillAudit,
	actor: SkillActor,
	action: RecordAuditFromRequestInput["action"],
	id: string,
	version?: number,
) {
	invalidateSkillCache();
	await audit({
		action,
		organizationId: actor.organizationId,
		resource: { type: "skill", id },
		metadata: { ...(version ? { version } : {}) },
	});
	await logDataEvent(
		action.endsWith("created")
			? "CREATE"
			: action.endsWith("deleted")
				? "DELETE"
				: "UPDATE",
		"skill",
		id,
		actor.userId,
		{ organizationId: actor.organizationId, source: "skills_lifecycle" },
	).catch(() => {});
}
export async function getSkillCommand(actor: SkillActor, raw: unknown) {
	const input = parse(skillGetSchema, raw);
	await access(actor);
	const direct = await db.skill.findFirst({
		where: { AND: [skillVisibilityWhere(actor, true), { id: input.id }] },
		select: { id: true },
	});
	if (direct) {
		return detail(actor, direct.id);
	}
	const aliases = await db.skill.findMany({
		where: { AND: [skillVisibilityWhere(actor, true), { slug: input.id }] },
		select: { id: true },
		take: 2,
	});
	if (aliases.length > 1) {
		throw new SkillError(
			"CONFLICT",
			"Several skills use this identifier. Open the skill by its unique ID.",
		);
	}
	if (!aliases.length) {
		throw new SkillError("NOT_FOUND", "Skill not found or access denied.");
	}
	return detail(actor, aliases[0].id);
}
export async function listSkillsCommand(
	actor: SkillActor,
	raw: unknown,
	options: { includeContent?: boolean } = {},
) {
	const input = parse(skillListSchema, raw);
	const a = await access(actor);
	const predicates: Prisma.SkillWhereInput[] = [
		skillVisibilityWhere(actor, input.tab === "archived"),
	];
	if (input.tab === "builtin") {
		predicates.push({ scope: "SYSTEM" });
	}
	if (input.tab === "organization") {
		predicates.push({
			scope: "ORGANIZATION",
			organizationId: actor.organizationId,
		});
	}
	if (input.tab === "drafts") {
		predicates.push({
			scope: "ORGANIZATION",
			organizationId: actor.organizationId,
			userId: actor.userId,
			isPublished: false,
			archivedAt: null,
		});
	} else if (input.tab === "archived") {
		predicates.push({
			scope: "ORGANIZATION",
			organizationId: actor.organizationId,
			userId: actor.userId,
			archivedAt: { not: null },
		});
	} else {
		predicates.push({ isPublished: input.isPublished ?? true });
	}
	if (input.scope) {
		predicates.push({ scope: input.scope });
	}
	if (input.category) {
		predicates.push({ category: input.category });
	}
	if (input.tags?.length) {
		predicates.push({ tags: { hasSome: input.tags } });
	}
	if (input.isDiscoverable !== undefined) {
		predicates.push({ isDiscoverable: input.isDiscoverable });
	}
	if (input.search) {
		predicates.push({
			OR: [
				{ name: { contains: input.search, mode: "insensitive" } },
				{ slug: { contains: input.search, mode: "insensitive" } },
				{
					description: {
						contains: input.search,
						mode: "insensitive",
					},
				},
			],
		});
	}
	const where = { AND: predicates };
	if (
		input.cursor &&
		!(await db.skill.findFirst({
			where: { AND: [where, { id: input.cursor }] },
			select: { id: true },
		}))
	) {
		throw new SkillError(
			"BAD_REQUEST",
			"Use a cursor from this skill view.",
		);
	}
	const [values, total] = await Promise.all([
		db.skill.findMany({
			where,
			include: { files },
			orderBy: [{ [input.sortBy]: input.sortOrder }, { id: "asc" }],
			take: input.limit + 1,
			...(input.cursor
				? { cursor: { id: input.cursor }, skip: 1 }
				: { skip: input.offset }),
		}),
		db.skill.count({ where }),
	]);
	await access(actor);
	const page = values.slice(0, input.limit);
	return {
		skills: page.map((value) =>
			dto(value, actor, a, options.includeContent === true),
		),
		total,
		hasMore: values.length > input.limit,
		nextCursor:
			values.length > input.limit ? (page.at(-1)?.id ?? null) : null,
	};
}

export interface PreparedSkillFile {
	path: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	storageKey: string;
}
export interface SkillCreateOptions {
	id?: string;
	preparedFiles?: PreparedSkillFile[];
	importProvenance?: {
		kind: "file" | "github";
		sha256: string;
		fileName?: string;
		repository?: string;
		commit?: string;
		path?: string;
	};
}
function prepared(id: string, options: SkillCreateOptions) {
	const values = options.preparedFiles ?? [];
	if (values.length > 128) {
		throw new SkillError(
			"BAD_REQUEST",
			"A skill can contain at most 128 supporting files.",
		);
	}
	const paths = new Set<string>();
	let total = 0;
	for (const file of values) {
		const parts = file.path.split("/");
		if (
			!file.path ||
			file.path.length > 1024 ||
			file.path.includes("\\") ||
			file.path.includes("\0") ||
			parts.some((p) => !p || p === "." || p === "..") ||
			/^[a-z]:/i.test(file.path) ||
			file.path.toLowerCase() === "skill.md" ||
			paths.has(file.path.toLowerCase())
		) {
			throw new SkillError(
				"BAD_REQUEST",
				"Supporting files need unique safe relative paths.",
			);
		}
		paths.add(file.path.toLowerCase());
		if (
			!/^[a-f0-9]{64}$/.test(file.sha256) ||
			!Number.isSafeInteger(file.sizeBytes) ||
			file.sizeBytes < 0 ||
			file.sizeBytes > 8 * 1024 * 1024 ||
			!file.contentType ||
			file.contentType.length > 200 ||
			!file.storageKey.startsWith(`skills/${id}/`) ||
			file.storageKey.includes("..") ||
			file.storageKey.includes("\\")
		) {
			throw new SkillError(
				"BAD_REQUEST",
				"Prepared skill files could not be verified.",
			);
		}
		total += file.sizeBytes;
	}
	if (total > 32 * 1024 * 1024) {
		throw new SkillError(
			"BAD_REQUEST",
			"Supporting skill files exceed the 32 MiB package limit.",
		);
	}
	const provenance =
		options.importProvenance === undefined
			? undefined
			: parse(
					z.strictObject({
						kind: z.enum(["file", "github"]),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
						fileName: z.string().max(200).optional(),
						repository: z
							.string()
							.max(300)
							.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
							.optional(),
						commit: z
							.string()
							.regex(/^[a-f0-9]{40,64}$/)
							.optional(),
						path: z.string().max(1024).optional(),
					}),
					options.importProvenance,
				);
	return { values, provenance };
}
async function discoverySlug(
	tx: Client,
	actor: SkillActor,
	slug: string,
	id?: string,
) {
	if (
		await tx.skill.findFirst({
			where: {
				slug,
				...(id ? { id: { not: id } } : {}),
				isPublished: true,
				archivedAt: null,
				OR: [
					{ scope: "SYSTEM", organizationId: null, userId: null },
					{
						scope: "ORGANIZATION",
						organizationId: actor.organizationId,
						isDiscoverable: true,
					},
				],
			},
			select: { id: true },
		})
	) {
		throw new SkillError(
			"CONFLICT",
			"An available agent skill already uses this identifier. Choose a different identifier before making this skill discoverable.",
		);
	}
}
export async function createSkillCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
	options: SkillCreateOptions = {},
) {
	bounded(raw);
	const input = parse(skillCreateSchema, raw);
	const id = options.id ?? `skill-${randomUUID()}`;
	if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
		throw new SkillError(
			"BAD_REQUEST",
			"Invalid prepared skill identifier.",
		);
	}
	const attachments = prepared(id, options);
	const value = await serial(async (tx) => {
		const a = await access(actor, tx);
		if (!a.capabilities.canCreate) {
			throw new SkillError(
				"FORBIDDEN",
				"Your current role and policy do not allow creating skills.",
			);
		}
		if (
			(input.isPublished && !a.capabilities.canPublish) ||
			(input.isDiscoverable && !a.capabilities.canDiscover)
		) {
			throw new SkillError(
				"FORBIDDEN",
				"Your current role and policy do not allow publishing with this availability.",
			);
		}
		if (input.isDiscoverable) {
			await discoverySlug(tx, actor, input.slug);
		}
		return tx.skill.create({
			data: {
				id,
				scope: "ORGANIZATION",
				organizationId: actor.organizationId,
				userId: actor.userId,
				...input,
				importProvenance: attachments.provenance as
					| Prisma.InputJsonValue
					| undefined,
				...(attachments.values.length
					? { files: { create: attachments.values } }
					: {}),
			},
			select: { id: true, version: true },
		});
	});
	await event(audit, actor, "org.skill.created", value.id, value.version);
	return detail(actor, value.id);
}
export async function updateSkillCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
) {
	bounded(raw);
	const input = parse(skillUpdateSchema, raw);
	const { id, expectedVersion, ...data } = input;
	if (!Object.keys(data).length) {
		throw new SkillError("BAD_REQUEST", "Choose a field to update.");
	}
	const value = await serial(async (tx) => {
		const a = await access(actor, tx);
		const current = await row(actor, id, tx);
		own(current, actor, a);
		if (!capabilities(current, actor, a).canEdit) {
			throw new SkillError(
				"FORBIDDEN",
				current.archivedAt
					? "Restore this skill as a draft before editing it."
					: "Current publication policy prevents editing a shared skill. Make it private before editing.",
			);
		}
		if (current.isDiscoverable && data.slug && data.slug !== current.slug) {
			await discoverySlug(tx, actor, data.slug, current.id);
		}
		const changed = await tx.skill.updateMany({
			where: {
				id: current.id,
				organizationId: actor.organizationId,
				userId: actor.userId,
				scope: "ORGANIZATION",
				version: expectedVersion ?? current.version,
				archivedAt: null,
			},
			data: { ...data, version: { increment: 1 } },
		});
		if (!changed.count) {
			throw new SkillError(
				"CONFLICT",
				"This skill changed. Reload before saving your edits.",
			);
		}
		return { id: current.id, version: current.version + 1 };
	});
	await event(audit, actor, "org.skill.updated", value.id, value.version);
	return detail(actor, value.id);
}
export async function publishSkillCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
) {
	const input = parse(skillPublishSchema, raw);
	const value = await serial(async (tx) => {
		const a = await access(actor, tx);
		const current = await row(actor, input.id, tx);
		own(current, actor, a);
		if (current.archivedAt) {
			throw new SkillError(
				"CONFLICT",
				"Restore this skill as a draft before publishing it.",
			);
		}
		if (
			(input.availability !== "draft" && !a.capabilities.canPublish) ||
			(input.availability === "agents" && !a.capabilities.canDiscover)
		) {
			throw new SkillError(
				"FORBIDDEN",
				"Your current role and policy do not allow this skill availability.",
			);
		}
		if (input.availability === "agents") {
			await discoverySlug(tx, actor, current.slug, current.id);
		}
		const changed = await tx.skill.updateMany({
			where: {
				id: current.id,
				scope: "ORGANIZATION",
				userId: actor.userId,
				organizationId: actor.organizationId,
				version: input.expectedVersion,
				archivedAt: null,
			},
			data: {
				isPublished: input.availability !== "draft",
				isDiscoverable: input.availability === "agents",
				version: { increment: 1 },
			},
		});
		if (!changed.count) {
			throw new SkillError(
				"CONFLICT",
				"This skill changed. Reload before changing its availability.",
			);
		}
		return { id: current.id, version: current.version + 1 };
	});
	await event(audit, actor, "org.skill.published", value.id, value.version);
	return detail(actor, value.id);
}
export async function archiveSkillCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
) {
	const input = parse(skillArchiveSchema, raw);
	const value = await serial(async (tx) => {
		const a = await access(actor, tx);
		const current = await row(actor, input.id, tx);
		own(current, actor, a);
		if (current.archivedAt) {
			throw new SkillError("CONFLICT", "This skill is already archived.");
		}
		const changed = await tx.skill.updateMany({
			where: {
				id: current.id,
				scope: "ORGANIZATION",
				userId: actor.userId,
				organizationId: actor.organizationId,
				version: input.expectedVersion ?? current.version,
				archivedAt: null,
			},
			data: {
				archivedAt: new Date(),
				isPublished: false,
				isDiscoverable: false,
				version: { increment: 1 },
			},
		});
		if (!changed.count) {
			throw new SkillError(
				"CONFLICT",
				"This skill changed. Reload before archiving it.",
			);
		}
		return { id: current.id, version: current.version + 1 };
	});
	await event(audit, actor, "org.skill.archived", value.id, value.version);
	return detail(actor, value.id);
}
export async function restoreSkillCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
) {
	const input = parse(skillRestoreSchema, raw);
	const value = await serial(async (tx) => {
		const a = await access(actor, tx);
		const current = await row(actor, input.id, tx);
		own(current, actor, a);
		if (!current.archivedAt) {
			throw new SkillError("CONFLICT", "This skill is not archived.");
		}
		const changed = await tx.skill.updateMany({
			where: {
				id: current.id,
				scope: "ORGANIZATION",
				userId: actor.userId,
				organizationId: actor.organizationId,
				version: input.expectedVersion ?? current.version,
				archivedAt: { not: null },
			},
			data: {
				archivedAt: null,
				isPublished: false,
				isDiscoverable: false,
				version: { increment: 1 },
			},
		});
		if (!changed.count) {
			throw new SkillError(
				"CONFLICT",
				"This skill changed. Reload before restoring it.",
			);
		}
		return { id: current.id, version: current.version + 1 };
	});
	await event(audit, actor, "org.skill.restored", value.id, value.version);
	return detail(actor, value.id);
}
export async function deleteSkillCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
) {
	const input = parse(skillDeleteSchema, raw);
	await serial(async (tx) => {
		const a = await access(actor, tx);
		const current = await row(actor, input.id, tx);
		own(current, actor, a, Permissions.SKILL_DELETE);
		// The FK otherwise sets sourceSkillId=null and erases the copied source ACL.
		// Remove protected copies before parent deletion in the same transaction.
		await tx.agentMemoryFile.deleteMany({
			where: { sourceSkillId: current.id },
		});
		const changed = await tx.skill.deleteMany({
			where: {
				id: current.id,
				scope: "ORGANIZATION",
				userId: actor.userId,
				organizationId: actor.organizationId,
				version: input.expectedVersion ?? current.version,
			},
		});
		if (!changed.count) {
			throw new SkillError(
				"CONFLICT",
				"This skill changed. Reload before permanently deleting it.",
			);
		}
	});
	await event(audit, actor, "org.skill.deleted", input.id);
	return { success: true as const };
}
export async function getSkillGovernanceCommand(
	actor: SkillActor,
	raw: unknown = {},
) {
	parse(skillGovernanceReadSchema, raw);
	const a = await access(actor);
	return {
		policy: a.policy,
		revision: a.revision,
		canManage: a.canManage,
		capabilities: a.capabilities,
	};
}
export async function updateSkillGovernanceCommand(
	actor: SkillActor,
	raw: unknown,
	audit: SkillAudit,
) {
	const input = parse(skillGovernanceUpdateSchema, raw);
	const revision = await serial(async (tx) => {
		const a = await access(actor, tx);
		if (!a.canManage) {
			throw new SkillError(
				"FORBIDDEN",
				"Only organization owners or administrators can manage skill governance.",
			);
		}
		if (a.revision !== input.expectedRevision) {
			throw new SkillError(
				"CONFLICT",
				"Skill governance changed. Reload before saving.",
			);
		}
		const next = a.revision + 1;
		const changed = await tx.organization.updateMany({
			where: {
				id: actor.organizationId,
				deletedAt: null,
				metadata: a.rawMetadata,
			},
			data: {
				metadata: JSON.stringify({
					...a.metadata,
					skillGovernance: { ...input.policy, revision: next },
				}),
			},
		});
		if (!changed.count) {
			throw new SkillError(
				"CONFLICT",
				"Organization settings changed. Reload before saving governance.",
			);
		}
		return next;
	});
	invalidateSkillCache();
	await audit({
		action: "org.skill_governance.updated",
		organizationId: actor.organizationId,
		resource: { type: "organization", id: actor.organizationId },
		metadata: { revision },
	});
	await logDataEvent(
		"UPDATE",
		"organization",
		actor.organizationId,
		actor.userId,
		{ source: "skill_governance", revision },
	).catch(() => {});
	return getSkillGovernanceCommand(actor, {});
}
