import { generateId } from "../../utils";
import { db } from "../client";
import {
	Prisma,
	type ReportArtifactType,
	type ReportExecutionStatus,
	type ReportOutputFormat,
	type ReportTemplateScope,
	type ReportTemplateType,
	type ScheduleMode,
	type TemplateExecutionStatus,
	type TemplateInstance,
	type TemplateInstanceStatus,
} from "../generated/client";
import { ownerScopedTemplateSchedule } from "./lib/owner-scoped-schedule";
import {
	normalizeReportSchedule,
	type ReportScheduleConfig,
} from "./lib/report-schedule";

// =============================================================================
// Report Template Queries
// =============================================================================

export interface ListReportTemplatesParams {
	userId?: string;
	organizationId?: string;
	scope?: ReportTemplateScope;
	templateType?: ReportTemplateType;
	category?: string;
	tags?: string[];
	search?: string;
	isPublic?: boolean;
	limit?: number;
	offset?: number;
	sortBy?: "name" | "createdAt" | "updatedAt" | "useCount" | "lastUsedAt";
	sortOrder?: "asc" | "desc";
}

export async function listReportTemplates({
	userId,
	organizationId,
	scope,
	templateType,
	category,
	tags,
	search,
	isPublic,
	limit = 50,
	offset = 0,
	sortBy = "updatedAt",
	sortOrder = "desc",
}: ListReportTemplatesParams) {
	const where: any = {};

	// Scope filtering with XOR tenant isolation
	if (scope) {
		where.scope = scope;
		if (scope === "USER") {
			// USER scope REQUIRES personal context (no organizationId)
			if (organizationId || !userId) {
				return { templates: [], total: 0 };
			}
			where.userId = userId;
		} else if (scope === "ORGANIZATION") {
			// ORGANIZATION scope REQUIRES org context
			if (!organizationId) {
				return { templates: [], total: 0 };
			}
			where.organizationId = organizationId;
		}
	} else {
		// XOR PATTERN: Show templates based on context
		// Personal and organization contexts are MUTUALLY EXCLUSIVE
		const conditions: any[] = [{ scope: "SYSTEM" }];

		if (organizationId) {
			// ORGANIZATION CONTEXT: SYSTEM + ORG templates only
			// User's personal templates are NOT accessible in org context
			conditions.push({ scope: "ORGANIZATION", organizationId });
		} else if (userId) {
			// PERSONAL CONTEXT: SYSTEM + USER templates only
			// Org templates are NOT accessible in personal context
			conditions.push({ scope: "USER", userId });
		}

		// Public templates are always accessible (read-only showcase)
		conditions.push({ isPublic: true });
		where.OR = conditions;
	}

	// Template type filter
	if (templateType) {
		where.templateType = templateType;
	}

	// Category filter
	if (category) {
		where.category = category;
	}

	// Tags filter (templates that have ALL specified tags)
	if (tags && tags.length > 0) {
		where.tags = {
			hasEvery: tags,
		};
	}

	// Public filter
	if (isPublic !== undefined) {
		where.isPublic = isPublic;
	}

	// Search filter (name or description)
	if (search) {
		where.AND = [
			...(where.AND || []),
			{
				OR: [
					{ name: { contains: search, mode: "insensitive" } },
					{ description: { contains: search, mode: "insensitive" } },
				],
			},
		];
	}

	const [templates, total] = await Promise.all([
		db.reportTemplate.findMany({
			where,
			orderBy: { [sortBy]: sortOrder },
			take: limit,
			skip: offset,
			include: {
				_count: {
					select: { executions: true, artifacts: true },
				},
			},
		}),
		db.reportTemplate.count({ where }),
	]);

	return { templates, total };
}

export async function getReportTemplate({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId?: string;
	organizationId?: string;
}) {
	const template = await db.reportTemplate.findUnique({
		where: { id },
		include: {
			executions: {
				orderBy: { createdAt: "desc" },
				take: 10,
				select: {
					id: true,
					status: true,
					startedAt: true,
					completedAt: true,
					duration: true,
					createdAt: true,
				},
			},
			_count: {
				select: { executions: true, artifacts: true },
			},
		},
	});

	if (!template) {
		return null;
	}

	// Check access
	if (template.scope === "USER" && template.userId !== userId) {
		if (!template.isPublic) {
			return null;
		}
	}
	if (
		template.scope === "ORGANIZATION" &&
		template.organizationId !== organizationId
	) {
		if (!template.isPublic) {
			return null;
		}
	}

	return template;
}

export interface CreateReportTemplateParams {
	name: string;
	description?: string;
	heroEmojis?: string[];
	heroImageUrl?: string;
	templateType: ReportTemplateType;
	category?: string;
	tags?: string[];
	definition: Prisma.InputJsonValue;
	connections?: Prisma.InputJsonValue;
	parameters?: Prisma.InputJsonValue;
	outputFormat?: ReportOutputFormat;
	fabricConfig?: Prisma.InputJsonValue;
	schedule?: Prisma.InputJsonValue;
	evidenceProjectId?: string;
	evidenceReportSlug?: string;
	evidenceConfig?: Prisma.InputJsonValue;
	userId?: string;
	organizationId?: string;
	scope?: ReportTemplateScope;
	isPublic?: boolean;
}

export async function createReportTemplate(params: CreateReportTemplateParams) {
	return db.reportTemplate.create({
		data: {
			name: params.name,
			description: params.description,
			heroEmojis: params.heroEmojis || [],
			heroImageUrl: params.heroImageUrl,
			templateType: params.templateType,
			category: params.category,
			tags: params.tags || [],
			definition: params.definition,
			connections: params.connections,
			parameters: params.parameters,
			outputFormat: params.outputFormat || "MARKDOWN",
			fabricConfig: params.fabricConfig,
			schedule: params.schedule,
			evidenceProjectId: params.evidenceProjectId,
			evidenceReportSlug: params.evidenceReportSlug,
			evidenceConfig: params.evidenceConfig,
			userId: params.userId,
			organizationId: params.organizationId,
			scope: params.scope || "USER",
			isPublic: params.isPublic || false,
		},
	});
}

export interface UpdateReportTemplateParams {
	id: string;
	name?: string;
	description?: string;
	heroEmojis?: string[];
	heroImageUrl?: string;
	templateType?: ReportTemplateType;
	category?: string;
	tags?: string[];
	definition?: Prisma.InputJsonValue;
	connections?: Prisma.InputJsonValue;
	parameters?: Prisma.InputJsonValue;
	outputFormat?: ReportOutputFormat;
	fabricConfig?: Prisma.InputJsonValue;
	/** Set to an object to (re)set the schedule, `null` to clear it (→ SQL NULL). */
	schedule?: Prisma.InputJsonValue | null;
	evidenceProjectId?: string;
	evidenceReportSlug?: string;
	evidenceConfig?: Prisma.InputJsonValue;
	isPublic?: boolean;
}

export async function updateReportTemplate({
	id,
	...data
}: UpdateReportTemplateParams) {
	// Increment version if definition changes
	const updateData: any = { ...data };
	if (data.definition) {
		updateData.version = { increment: 1 };
	}
	// An explicit `schedule: null` clears it to SQL NULL (so the inheritance query's
	// `{ not: Prisma.DbNull }` no longer matches). `undefined`/omitted leaves it unchanged
	// (Prisma treats the spread's `schedule: undefined` as no-op).
	if (data.schedule === null) {
		updateData.schedule = Prisma.DbNull;
	}

	return db.reportTemplate.update({
		where: { id },
		data: updateData,
	});
}

export async function deleteReportTemplate(id: string) {
	return db.reportTemplate.delete({
		where: { id },
	});
}

export async function incrementTemplateUsage(id: string) {
	return db.reportTemplate.update({
		where: { id },
		data: {
			useCount: { increment: 1 },
			lastUsedAt: new Date(),
		},
	});
}

// =============================================================================
// Report Execution Queries
// =============================================================================

export interface CreateReportExecutionParams {
	templateId: string;
	userId: string;
	organizationId?: string;
	parameters?: Prisma.InputJsonValue;
	dateRange?: Prisma.InputJsonValue;
	workflowId?: string;
	runId?: string;
}

export async function createReportExecution(
	params: CreateReportExecutionParams,
) {
	return db.reportExecution.create({
		data: {
			templateId: params.templateId,
			userId: params.userId,
			organizationId: params.organizationId,
			parameters: params.parameters,
			dateRange: params.dateRange,
			workflowId: params.workflowId,
			runId: params.runId,
			status: "PENDING",
		},
	});
}

export async function updateReportExecution({
	id,
	status,
	startedAt,
	completedAt,
	duration,
	dataSources,
	error,
	workflowId,
}: {
	id: string;
	status?: ReportExecutionStatus;
	startedAt?: Date;
	completedAt?: Date;
	duration?: number;
	dataSources?: Prisma.InputJsonValue;
	error?: string;
	workflowId?: string;
}) {
	return db.reportExecution.update({
		where: { id },
		data: {
			status,
			startedAt,
			completedAt,
			duration,
			dataSources,
			error,
			workflowId,
		},
	});
}

export async function getReportExecution(id: string) {
	return db.reportExecution.findUnique({
		where: { id },
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
					outputFormat: true,
				},
			},
			artifacts: {
				orderBy: { createdAt: "desc" },
			},
		},
	});
}

export interface ListReportExecutionsParams {
	templateId?: string;
	userId?: string;
	organizationId?: string;
	status?: ReportExecutionStatus;
	limit?: number;
	offset?: number;
}

export async function listReportExecutions({
	templateId,
	userId,
	organizationId,
	status,
	limit = 50,
	offset = 0,
}: ListReportExecutionsParams) {
	// SECURITY: User-owned pattern - only load executions owned by current user
	// In org context: user's executions within that org
	// In personal context: user's personal executions
	const where: any = {};

	if (templateId) {
		where.templateId = templateId;
	}

	// Require userId for security - prevents viewing all org executions
	where.userId = userId;

	// In org context: user's executions within that org
	// In personal context: user's personal executions (organizationId must be null)
	where.organizationId = organizationId || null;

	if (status) {
		where.status = status;
	}

	const [executions, total] = await Promise.all([
		db.reportExecution.findMany({
			where,
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
			include: {
				template: {
					select: {
						id: true,
						name: true,
						templateType: true,
					},
				},
				_count: {
					select: { artifacts: true },
				},
			},
		}),
		db.reportExecution.count({ where }),
	]);

	return { executions, total };
}

// =============================================================================
// Report Artifact Queries
// =============================================================================

export interface CreateReportArtifactParams {
	executionId: string;
	templateId: string;
	userId: string;
	organizationId?: string;
	name: string;
	description?: string;
	artifactType: ReportArtifactType;
	s3Path?: string;
	s3Bucket?: string;
	mimeType: string;
	size: number;
	content?: string;
	metadata?: Prisma.InputJsonValue;
	evidenceEmbedUrl?: string;
}

export async function createReportArtifact(params: CreateReportArtifactParams) {
	return db.reportArtifact.create({
		data: {
			executionId: params.executionId,
			templateId: params.templateId,
			userId: params.userId,
			organizationId: params.organizationId,
			name: params.name,
			description: params.description,
			artifactType: params.artifactType,
			s3Path: params.s3Path,
			s3Bucket: params.s3Bucket,
			mimeType: params.mimeType,
			size: params.size,
			content: params.content,
			metadata: params.metadata,
			evidenceEmbedUrl: params.evidenceEmbedUrl,
		},
	});
}

export async function getReportArtifact(id: string) {
	return db.reportArtifact.findUnique({
		where: { id },
		include: {
			execution: {
				select: {
					id: true,
					status: true,
					createdAt: true,
				},
			},
			template: {
				select: {
					id: true,
					name: true,
				},
			},
		},
	});
}

export interface ListReportArtifactsParams {
	executionId?: string;
	templateId?: string;
	userId?: string;
	organizationId?: string;
	artifactType?: ReportArtifactType;
	limit?: number;
	offset?: number;
}

export async function listReportArtifacts({
	executionId,
	templateId,
	userId,
	organizationId,
	artifactType,
	limit = 50,
	offset = 0,
}: ListReportArtifactsParams) {
	// SECURITY: User-owned pattern with XOR tenant isolation
	// In org context: user's artifacts within that org
	// In personal context: user's personal artifacts (organizationId must be null)
	const where: any = {};

	if (executionId) {
		where.executionId = executionId;
	}
	if (templateId) {
		where.templateId = templateId;
	}

	// XOR PATTERN: Require userId for security
	if (userId) {
		where.userId = userId;
		// Explicit XOR: org context OR personal context (never both)
		where.organizationId = organizationId || null;
	}

	if (artifactType) {
		where.artifactType = artifactType;
	}

	const [artifacts, total] = await Promise.all([
		db.reportArtifact.findMany({
			where,
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
			include: {
				template: {
					select: {
						id: true,
						name: true,
					},
				},
			},
		}),
		db.reportArtifact.count({ where }),
	]);

	return { artifacts, total };
}

export async function updateReportArtifactRag({
	id,
	qdrantId,
	chunkCount,
}: {
	id: string;
	qdrantId: string;
	chunkCount: number;
}) {
	return db.reportArtifact.update({
		where: { id },
		data: {
			qdrantId,
			chunkCount,
			embeddedAt: new Date(),
		},
	});
}

// =============================================================================
// Report Artifact Chunk Queries
// =============================================================================

/**
 * Create report artifact chunks
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createReportArtifactChunks(
	chunks: Array<{
		artifactId: string;
		content: string;
		chunkIndex: number;
		qdrantId?: string;
		metadata?: Prisma.InputJsonValue;
	}>,
	tenantContext: {
		userId: string;
		organizationId?: string;
	},
) {
	return db.reportArtifactChunk.createMany({
		data: chunks.map((chunk) => ({
			artifactId: chunk.artifactId,
			content: chunk.content,
			chunkIndex: chunk.chunkIndex,
			qdrantId: chunk.qdrantId,
			metadata: chunk.metadata,
			userId: tenantContext.userId,
			organizationId: tenantContext.organizationId,
		})),
	});
}

export async function getReportArtifactChunks(artifactId: string) {
	return db.reportArtifactChunk.findMany({
		where: { artifactId },
		orderBy: { chunkIndex: "asc" },
	});
}

// =============================================================================
// Template Instance Queries
// =============================================================================

export interface CreateTemplateInstanceParams {
	templateId: string;
	userId: string;
	organizationId?: string;
	name: string;
	description?: string;
	heroEmojis?: string[];
	connections: Prisma.InputJsonValue;
	parameterDefaults?: Prisma.InputJsonValue;
	fabricConfig?: Prisma.InputJsonValue;
	schedule?: Prisma.InputJsonValue;
	scheduleMode?: ScheduleMode;
}

export async function createTemplateInstance(
	params: CreateTemplateInstanceParams,
) {
	// Generate a stable sId for this instance (remains constant across versions)
	const sId = generateId();

	// Normalize the schedule (if any) and freeze the first nextRunAt.
	// A malformed schedule normalizes to null → instance is created unscheduled.
	const normalizedSchedule = params.schedule
		? normalizeReportSchedule(params.schedule, new Date())
		: null;

	return db.templateInstance.create({
		data: {
			templateId: params.templateId,
			userId: params.userId,
			organizationId: params.organizationId,
			// Versioning fields
			sId,
			version: 1,
			status: "ACTIVE",
			// User customization
			name: params.name,
			description: params.description,
			heroEmojis: params.heroEmojis || [],
			connections: params.connections,
			parameterDefaults: params.parameterDefaults,
			fabricConfig: params.fabricConfig,
			schedule: normalizedSchedule
				? (normalizedSchedule as unknown as Prisma.InputJsonValue)
				: params.schedule === undefined
					? undefined
					: Prisma.DbNull,
			nextRunAt: normalizedSchedule
				? new Date(normalizedSchedule.anchorAt)
				: undefined,
			scheduleMode: params.scheduleMode ?? "INHERITED",
		},
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
					definition: true,
					parameters: true,
					connections: true,
					fabricConfig: true,
					outputFormat: true,
				},
			},
		},
	});
}

/**
 * Strip a (now-deleted) MCP config id from a report instance's stored
 * `connections` JSON — both the `mcpConfigs` array and any `mcpBindings` entries
 * pointing at it. Pure + side-effect-free so it can be unit-tested; returns the
 * cleaned connections and whether anything actually changed.
 */
export function stripMcpConfigFromConnections(
	connections: unknown,
	configId: string,
): { connections: Record<string, unknown>; changed: boolean } | null {
	if (!connections || typeof connections !== "object" || !configId) {
		return null;
	}
	const conn = connections as {
		mcpConfigs?: unknown;
		mcpBindings?: unknown;
		[k: string]: unknown;
	};
	const origConfigs = Array.isArray(conn.mcpConfigs) ? conn.mcpConfigs : [];
	const nextConfigs = origConfigs.filter((c) => c !== configId);
	const origBindings =
		conn.mcpBindings && typeof conn.mcpBindings === "object"
			? (conn.mcpBindings as Record<string, string>)
			: {};
	const nextBindings = Object.fromEntries(
		Object.entries(origBindings).filter(([, v]) => v !== configId),
	);
	const changed =
		nextConfigs.length !== origConfigs.length ||
		Object.keys(nextBindings).length !== Object.keys(origBindings).length;
	return {
		connections: {
			...conn,
			mcpConfigs: nextConfigs,
			mcpBindings: nextBindings,
		},
		changed,
	};
}

/**
 * Remove a deleted MCP config id from every report instance that references it
 * (delete-time integrity guardrail). Run-time resolution self-heals regardless,
 * but clearing the dead reference keeps the stored data + the UI honest. Scans
 * the (small) template_instance table by JSON text match. Never throws — a
 * failure here must NEVER block config deletion. Returns instances updated.
 */
export async function clearMcpConfigFromReportInstances(
	configId: string,
): Promise<number> {
	if (!configId) {
		return 0;
	}
	try {
		const rows = await db.$queryRaw<Array<{ id: string }>>`
			SELECT id FROM template_instance
			WHERE connections::text LIKE ${`%${configId}%`}
		`;
		let updated = 0;
		for (const { id } of rows) {
			const inst = await db.templateInstance.findUnique({
				where: { id },
				select: { connections: true },
			});
			const stripped = stripMcpConfigFromConnections(
				inst?.connections,
				configId,
			);
			if (!stripped || !stripped.changed) {
				continue;
			}
			await db.templateInstance.update({
				where: { id },
				data: {
					connections: stripped.connections as Prisma.InputJsonValue,
				},
			});
			updated++;
		}
		return updated;
	} catch {
		// Best-effort — cleanup failure must not block the config deletion.
		return 0;
	}
}

export async function getTemplateInstance({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string;
}) {
	const instance = await db.templateInstance.findUnique({
		where: { id },
		include: {
			template: {
				select: {
					id: true,
					name: true,
					description: true,
					templateType: true,
					definition: true,
					parameters: true,
					connections: true,
					fabricConfig: true,
					outputFormat: true,
					heroEmojis: true,
				},
			},
			executions: {
				orderBy: { createdAt: "desc" },
				take: 10,
				select: {
					id: true,
					status: true,
					userId: true,
					startedAt: true,
					completedAt: true,
					duration: true,
					error: true,
					mcpDiagnostics: true,
					createdAt: true,
					artifacts: {
						select: {
							id: true,
							name: true,
							artifactType: true,
							mimeType: true,
							size: true,
							createdAt: true,
						},
						orderBy: { createdAt: "desc" },
					},
				},
			},
			_count: {
				select: { executions: true },
			},
		},
	});

	if (!instance) {
		return null;
	}

	// Check access
	if (instance.userId !== userId) {
		if (instance.organizationId !== organizationId) {
			return null;
		}
	}

	return instance;
}

/** Read just the scheduleMode for a dispatch-time re-check. */
export async function getInstanceScheduleMode(
	id: string,
): Promise<ScheduleMode | null> {
	const row = await db.templateInstance.findUnique({
		where: { id },
		select: { scheduleMode: true },
	});
	return row?.scheduleMode ?? null;
}

export interface ListTemplateInstancesParams {
	userId: string;
	organizationId?: string;
	templateId?: string;
	/** @deprecated Use status instead */
	isActive?: boolean;
	status?: TemplateInstanceStatus | TemplateInstanceStatus[];
	search?: string;
	limit?: number;
	offset?: number;
	sortBy?: "name" | "createdAt" | "updatedAt" | "lastRunAt" | "runCount";
	sortOrder?: "asc" | "desc";
	/** If true, returns only the latest version of each instance (by sId). Default: true */
	latestVersionOnly?: boolean;
}

export async function listTemplateInstances({
	userId,
	organizationId,
	templateId,
	isActive,
	status,
	search,
	limit = 50,
	offset = 0,
	sortBy = "updatedAt",
	sortOrder = "desc",
	latestVersionOnly = true,
}: ListTemplateInstancesParams) {
	// SECURITY: User-owned pattern - only load instances owned by current user
	// In org context: user's instances within that org
	// In personal context: user's personal instances
	const where: Prisma.TemplateInstanceWhereInput = organizationId
		? { userId, organizationId } // Org context: user's instances only
		: { userId, organizationId: null }; // Personal context: user's personal instances

	if (templateId) {
		where.templateId = templateId;
	}

	// Status filtering (new versioning-aware approach)
	if (status) {
		if (Array.isArray(status)) {
			where.status = { in: status };
		} else {
			where.status = status;
		}
	} else if (isActive !== undefined) {
		// Backwards compatibility: isActive maps to status
		where.status = isActive ? "ACTIVE" : "ARCHIVED";
	} else {
		// Default: only show ACTIVE instances
		where.status = "ACTIVE";
	}

	// Store search conditions separately - apply AFTER computing latest versions
	const searchConditions = search
		? [
				{ name: { contains: search, mode: "insensitive" as const } },
				{
					description: {
						contains: search,
						mode: "insensitive" as const,
					},
				},
			]
		: null;

	// If latestVersionOnly, filter to only the highest version per sId
	// IMPORTANT: Compute latest versions BEFORE applying search filter
	if (latestVersionOnly) {
		// First, get the max version for each sId using base criteria (WITHOUT search)
		const latestVersions = await db.templateInstance.groupBy({
			by: ["sId"],
			where, // Does NOT include search conditions yet
			_max: {
				version: true,
			},
		});

		// Build version conditions for each sId + max version
		if (latestVersions.length > 0) {
			const versionConditions = latestVersions.map((lv) => ({
				sId: lv.sId,
				version: lv._max.version || 1,
			}));

			// Now combine: (latest version) AND optionally (search matches)
			if (searchConditions) {
				where.AND = [
					{ OR: versionConditions },
					{ OR: searchConditions },
				];
			} else {
				where.OR = versionConditions;
			}
		} else if (searchConditions) {
			// No instances found, but still apply search conditions
			where.OR = searchConditions;
		}
	} else if (searchConditions) {
		// Not filtering by latest version, just apply search
		where.OR = searchConditions;
	}

	const [instances, total] = await Promise.all([
		db.templateInstance.findMany({
			where,
			orderBy: { [sortBy]: sortOrder },
			take: limit,
			skip: offset,
			include: {
				template: {
					select: {
						id: true,
						name: true,
						templateType: true,
						heroEmojis: true,
					},
				},
				executions: {
					select: {
						status: true,
						startedAt: true,
					},
					orderBy: { createdAt: "desc" },
					take: 1,
				},
				_count: {
					select: { executions: true },
				},
			},
		}),
		db.templateInstance.count({ where }),
	]);

	return { instances, total };
}

export interface UpdateTemplateInstanceParams {
	id: string;
	name?: string;
	description?: string;
	heroEmojis?: string[];
	connections?: Prisma.InputJsonValue;
	parameterDefaults?: Prisma.InputJsonValue;
	fabricConfig?: Prisma.InputJsonValue;
	/**
	 * Three-state schedule command. Omit to leave scheduling unchanged (no-op).
	 * inherit = re-seed from the owner-owned template (fresh snapshot); custom = set
	 * this instance's own schedule; off = disable (retain JSON, null nextRunAt).
	 */
	scheduleUpdate?:
		| { mode: "inherit" }
		| { mode: "custom"; schedule: unknown }
		| { mode: "off" };
	isActive?: boolean;
	status?: TemplateInstanceStatus;
	/**
	 * If true, creates a new version instead of updating in place.
	 * The old version will be archived, and a new version with incremented
	 * version number will be created with the updates applied.
	 * @default false
	 */
	createNewVersion?: boolean;
}

export async function updateTemplateInstance({
	id,
	createNewVersion = false,
	...data
}: UpdateTemplateInstanceParams): Promise<TemplateInstance> {
	// Get the current instance
	const current = await db.templateInstance.findUnique({
		where: { id },
		include: { template: true },
	});

	if (!current) {
		throw new Error(`Template instance not found: ${id}`);
	}

	// Resolve the schedule command into concrete column writes (Part 2, §7.2).
	// undefined => no-op (write none of the three columns).
	const su = data.scheduleUpdate;
	type SchedWrite = {
		scheduleMode: ScheduleMode;
		schedule?: Prisma.InputJsonValue | typeof Prisma.DbNull;
		nextRunAt: Date | null;
	};
	let schedWrite: SchedWrite | undefined;
	if (su) {
		if (su.mode === "off") {
			// retain current.schedule (omit `schedule`), null nextRunAt
			schedWrite = { scheduleMode: "OFF", nextRunAt: null };
		} else {
			const raw =
				su.mode === "custom"
					? su.schedule
					: ownerScopedTemplateSchedule(
							current.template,
							current.userId,
							current.organizationId,
						);
			const norm =
				raw != null ? normalizeReportSchedule(raw, new Date()) : null;
			schedWrite = {
				scheduleMode: su.mode === "custom" ? "CUSTOM" : "INHERITED",
				schedule: norm
					? (norm as unknown as Prisma.InputJsonValue)
					: Prisma.DbNull,
				nextRunAt: norm ? new Date(norm.anchorAt) : null,
			};
		}
	}

	if (createNewVersion) {
		// Archive current version and create new one
		return db.$transaction(async (tx) => {
			// Archive the current version
			await tx.templateInstance.update({
				where: { id },
				data: { status: "ARCHIVED" },
			});

			// Create new version with updates
			const newVersion = await tx.templateInstance.create({
				data: {
					// Copy from current
					templateId: current.templateId,
					userId: current.userId,
					organizationId: current.organizationId,
					sId: current.sId, // Keep same sId
					version: current.version + 1, // Increment version
					status: "ACTIVE",
					// Apply updates or keep current values
					name: data.name ?? current.name,
					description: data.description ?? current.description,
					heroEmojis: data.heroEmojis ?? current.heroEmojis,
					connections:
						(data.connections as Prisma.InputJsonValue) ??
						current.connections,
					parameterDefaults:
						(data.parameterDefaults as Prisma.InputJsonValue) ??
						current.parameterDefaults ??
						Prisma.DbNull,
					fabricConfig:
						(data.fabricConfig as Prisma.InputJsonValue) ??
						current.fabricConfig ??
						Prisma.DbNull,
					scheduleMode: schedWrite
						? schedWrite.scheduleMode
						: current.scheduleMode,
					schedule: schedWrite
						? "schedule" in schedWrite
							? (schedWrite.schedule as
									| Prisma.InputJsonValue
									| typeof Prisma.DbNull) // inherit/custom — DbNull when template has no inheritable schedule
							: ((current.schedule as Prisma.InputJsonValue) ??
								Prisma.DbNull) // off: retain
						: ((current.schedule as Prisma.InputJsonValue) ??
							Prisma.DbNull), // no-op: clone
					nextRunAt: schedWrite
						? schedWrite.nextRunAt
						: current.nextRunAt,
					isActive: data.isActive ?? current.isActive,
					// Reset usage stats for new version
					runCount: 0,
					lastRunAt: null,
				},
				include: {
					template: {
						select: {
							id: true,
							name: true,
							templateType: true,
						},
					},
				},
			});

			return newVersion;
		});
	}

	// Simple in-place update (no versioning).
	const { scheduleUpdate: _su, ...restData } = data;
	const inPlaceData: Prisma.TemplateInstanceUpdateInput = { ...restData };
	if (schedWrite) {
		inPlaceData.scheduleMode = schedWrite.scheduleMode;
		if ("schedule" in schedWrite) {
			// value may be Prisma.DbNull (inherit with no inheritable template schedule)
			inPlaceData.schedule = schedWrite.schedule as
				| Prisma.InputJsonValue
				| typeof Prisma.DbNull;
		} // off: omit `schedule` to retain current
		inPlaceData.nextRunAt = schedWrite.nextRunAt;
	}
	return db.templateInstance.update({
		where: { id },
		data: inPlaceData,
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
				},
			},
		},
	});
}

export async function deleteTemplateInstance(id: string): Promise<void> {
	// Get the sId of the instance being deleted
	const instance = await db.templateInstance.findUnique({
		where: { id },
		select: { sId: true },
	});

	if (instance) {
		// Delete all versions with the same sId (including archived versions)
		await db.templateInstance.deleteMany({
			where: { sId: instance.sId },
		});
	}
}

/**
 * Set lastRunAt on a template instance.
 * Called when an execution starts so that "Last run" reflects when the user triggered it.
 */
export async function updateTemplateInstanceLastRunAt(
	id: string,
	lastRunAt: Date,
) {
	return db.templateInstance.update({
		where: { id },
		data: { lastRunAt },
	});
}

// =============================================================================
// Template Instance Versioning Queries
// =============================================================================

/**
 * Get the latest (highest version) of a report instance by its stable sId.
 */
export async function getReportLatestInstanceVersion(
	sId: string,
): Promise<TemplateInstance | null> {
	return db.templateInstance.findFirst({
		where: { sId },
		orderBy: { version: "desc" },
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
					heroEmojis: true,
				},
			},
		},
	});
}

/**
 * Get the active version of a report instance (status = ACTIVE).
 * There should typically be only one active version per sId.
 */
export async function getReportActiveInstanceVersion(sId: string): Promise<
	| (TemplateInstance & {
			template: {
				id: string;
				name: string;
				templateType: string;
				heroEmojis: string[];
			};
	  })
	| null
> {
	return db.templateInstance.findFirst({
		where: { sId, status: "ACTIVE" },
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
					heroEmojis: true,
				},
			},
		},
	}) as unknown as Promise<
		| (TemplateInstance & {
				template: {
					id: string;
					name: string;
					templateType: string;
					heroEmojis: string[];
				};
		  })
		| null
	>;
}

/**
 * Get a specific version of a report instance.
 */
export async function getReportInstanceVersion(
	sId: string,
	version: number,
): Promise<TemplateInstance | null> {
	return db.templateInstance.findUnique({
		where: {
			sId_version: { sId, version },
		},
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
					heroEmojis: true,
				},
			},
		},
	});
}

/**
 * Get the version history for a report instance (all versions, sorted by version desc).
 */
export async function getReportInstanceVersionHistory(
	sId: string,
	options?: { limit?: number; includeArchived?: boolean },
): Promise<
	Array<
		TemplateInstance & {
			template: {
				id: string;
				name: string;
				templateType: string;
				heroEmojis: string[];
			};
		}
	>
> {
	const where: Prisma.TemplateInstanceWhereInput = { sId };

	if (!options?.includeArchived) {
		// By default, show all versions (including archived) for history
		// But if explicitly set to false, only show non-archived
		where.status = { not: "ARCHIVED" };
	}

	return db.templateInstance.findMany({
		where,
		orderBy: { version: "desc" },
		take: options?.limit,
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
					heroEmojis: true,
				},
			},
		},
	}) as unknown as Promise<
		Array<
			TemplateInstance & {
				template: {
					id: string;
					name: string;
					templateType: string;
					heroEmojis: string[];
				};
			}
		>
	>;
}

/**
 * Archive a specific report instance version (soft delete).
 */
export async function archiveReportInstanceVersion(
	id: string,
): Promise<TemplateInstance> {
	return db.templateInstance.update({
		where: { id },
		data: { status: "ARCHIVED" },
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
				},
			},
		},
	});
}

/**
 * Restore an archived report version by creating a new version from it.
 * This does NOT reactivate the old version - it creates a copy as the new latest.
 */
export async function restoreReportInstanceVersion(
	id: string,
): Promise<TemplateInstance> {
	const archived = await db.templateInstance.findUnique({
		where: { id },
	});

	if (!archived) {
		throw new Error(`Instance not found: ${id}`);
	}

	// Get the current max version for this sId
	const maxVersion = await db.templateInstance.aggregate({
		where: { sId: archived.sId },
		_max: { version: true },
	});

	const newVersion = (maxVersion._max.version || 0) + 1;

	// Archive any currently active version
	await db.templateInstance.updateMany({
		where: { sId: archived.sId, status: "ACTIVE" },
		data: { status: "ARCHIVED" },
	});

	// Create new version as a copy of the archived one
	const newInstance = await db.templateInstance.create({
		data: {
			templateId: archived.templateId,
			userId: archived.userId,
			organizationId: archived.organizationId,
			sId: archived.sId,
			version: newVersion,
			status: "ACTIVE",
			name: archived.name,
			description: archived.description,
			heroEmojis: archived.heroEmojis,
			connections: archived.connections as Prisma.InputJsonValue,
			parameterDefaults: archived.parameterDefaults ?? Prisma.DbNull,
			fabricConfig: archived.fabricConfig ?? Prisma.DbNull,
			schedule: archived.schedule ?? Prisma.DbNull,
			scheduleMode: archived.scheduleMode,
			nextRunAt: null,
			isActive: true,
			runCount: 0,
			lastRunAt: null,
		},
		include: {
			template: {
				select: {
					id: true,
					name: true,
					templateType: true,
				},
			},
		},
	});

	return newInstance;
}

// =============================================================================
// Template Instance Execution Queries
// =============================================================================

export interface CreateTemplateInstanceExecutionParams {
	instanceId: string;
	userId: string;
	organizationId?: string;
	parameters?: Prisma.InputJsonValue;
	workflowId?: string;
	runId?: string;
}

export async function createTemplateInstanceExecution(
	params: CreateTemplateInstanceExecutionParams,
) {
	return db.templateInstanceExecution.create({
		data: {
			instanceId: params.instanceId,
			userId: params.userId,
			organizationId: params.organizationId,
			parameters: params.parameters,
			workflowId: params.workflowId,
			runId: params.runId,
			status: "PENDING",
		},
	});
}

export async function updateTemplateInstanceExecution({
	id,
	status,
	startedAt,
	completedAt,
	duration,
	fabricEnrichment,
	dataSources,
	error,
	mcpDiagnostics,
	workflowId,
	runId,
}: {
	id: string;
	status?: TemplateExecutionStatus;
	startedAt?: Date;
	completedAt?: Date;
	duration?: number;
	fabricEnrichment?: Prisma.InputJsonValue;
	dataSources?: Prisma.InputJsonValue;
	error?: string;
	mcpDiagnostics?: Prisma.InputJsonValue;
	workflowId?: string;
	runId?: string;
}) {
	return db.templateInstanceExecution.update({
		where: { id },
		data: {
			status,
			startedAt,
			completedAt,
			duration,
			fabricEnrichment,
			dataSources,
			error,
			mcpDiagnostics,
			workflowId,
			runId,
		},
	});
}

/**
 * Compare-and-set cancel: flip an execution to CANCELLED only while it is still
 * active (PENDING/RUNNING). Returns true iff this caller won the flip. A zero count
 * means the run already went terminal (completed, failed, or cancelled first) — the
 * caller treats that as a lost race and reports the real outcome. Mirrors
 * `claimAndAdvanceScheduledInstance`. (cancel report jobs — race-safe flip)
 */
export async function cancelActiveTemplateInstanceExecution(
	id: string,
	{ cancelledBy }: { cancelledBy: string },
): Promise<boolean> {
	const now = new Date();
	const result = await db.templateInstanceExecution.updateMany({
		where: { id, status: { in: ["PENDING", "RUNNING"] } },
		data: {
			status: "CANCELLED",
			error: "Cancelled by user",
			completedAt: now,
			cancelledBy,
			cancelledAt: now,
		},
	});
	return result.count === 1;
}

/**
 * Guarded status write for the execution workflow's OWN status writes: never overwrite
 * a row a user already cancelled ("CANCELLED wins once set"). Guards both the terminal
 * COMPLETED/FAILED writes and the start-time RUNNING write, so a cancel that lands in the
 * PENDING→RUNNING gap is not clobbered either. Returns true iff the write landed; a zero
 * count means the row was CANCELLED and was intentionally left untouched.
 * (cancel report jobs — reverse-race guard)
 */
export async function finalizeTemplateInstanceExecutionStatus(
	id: string,
	{
		status,
		startedAt,
		completedAt,
		duration,
		fabricEnrichment,
		dataSources,
		mcpDiagnostics,
		error,
	}: {
		status: TemplateExecutionStatus;
		startedAt?: Date;
		completedAt?: Date;
		duration?: number;
		fabricEnrichment?: Prisma.InputJsonValue;
		dataSources?: Prisma.InputJsonValue;
		mcpDiagnostics?: Prisma.InputJsonValue;
		error?: string;
	},
): Promise<boolean> {
	const result = await db.templateInstanceExecution.updateMany({
		where: { id, status: { not: "CANCELLED" } },
		data: {
			status,
			startedAt,
			completedAt,
			duration,
			fabricEnrichment,
			dataSources,
			mcpDiagnostics,
			error,
		},
	});
	return result.count === 1;
}

/**
 * Delete any artifacts written for an execution — used by the cancel path to
 * discard partial output (Q2/R10). A `storeInstanceArtifact` activity that was
 * already in flight when the user cancelled can persist an artifact row on a
 * different table than the guarded status row; this clears it so a cancelled run
 * leaves no artifact. Cascades to artifact chunks. Returns the number removed.
 * (cancel report jobs — partial-output cleanup)
 */
export async function deleteTemplateInstanceArtifactsForExecution(
	executionId: string,
): Promise<number> {
	const result = await db.templateInstanceArtifact.deleteMany({
		where: { executionId },
	});
	return result.count;
}

export async function getTemplateInstanceExecution(id: string) {
	return db.templateInstanceExecution.findUnique({
		where: { id },
		include: {
			instance: {
				select: {
					id: true,
					name: true,
					templateId: true,
					template: {
						select: {
							id: true,
							name: true,
							templateType: true,
							outputFormat: true,
						},
					},
				},
			},
			artifacts: {
				orderBy: { createdAt: "desc" },
			},
		},
	});
}

export interface ListTemplateInstanceExecutionsParams {
	instanceId?: string;
	userId?: string;
	organizationId?: string;
	status?: TemplateExecutionStatus;
	limit?: number;
	offset?: number;
}

export async function listTemplateInstanceExecutions({
	instanceId,
	userId,
	organizationId,
	status,
	limit = 50,
	offset = 0,
}: ListTemplateInstanceExecutionsParams) {
	// SECURITY: User-owned pattern with XOR tenant isolation
	// In org context: user's executions within that org
	// In personal context: user's personal executions (organizationId must be null)
	const where: Prisma.TemplateInstanceExecutionWhereInput = {};

	if (instanceId) {
		where.instanceId = instanceId;
	}

	// XOR PATTERN: Require userId for security
	if (userId) {
		where.userId = userId;
		// Explicit XOR: org context OR personal context (never both)
		where.organizationId = organizationId || null;
	}

	if (status) {
		where.status = status;
	}

	const [executions, total] = await Promise.all([
		db.templateInstanceExecution.findMany({
			where,
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
			include: {
				instance: {
					select: {
						id: true,
						name: true,
						template: {
							select: {
								id: true,
								name: true,
								templateType: true,
							},
						},
					},
				},
				_count: {
					select: { artifacts: true },
				},
			},
		}),
		db.templateInstanceExecution.count({ where }),
	]);

	return { executions, total };
}

// =============================================================================
// Template Instance Artifact Queries
// =============================================================================

export interface CreateTemplateInstanceArtifactParams {
	executionId: string;
	userId: string;
	organizationId?: string;
	name: string;
	description?: string;
	artifactType: ReportArtifactType;
	s3Path?: string;
	s3Bucket?: string;
	mimeType: string;
	size: number;
	content?: string;
	metadata?: Prisma.InputJsonValue;
}

export async function createTemplateInstanceArtifact(
	params: CreateTemplateInstanceArtifactParams,
) {
	return db.templateInstanceArtifact.create({
		data: {
			executionId: params.executionId,
			userId: params.userId,
			organizationId: params.organizationId,
			name: params.name,
			description: params.description,
			artifactType: params.artifactType,
			s3Path: params.s3Path,
			s3Bucket: params.s3Bucket,
			mimeType: params.mimeType,
			size: params.size,
			content: params.content,
			metadata: params.metadata,
		},
	});
}

export async function getTemplateInstanceArtifact(id: string) {
	return db.templateInstanceArtifact.findUnique({
		where: { id },
		include: {
			execution: {
				select: {
					id: true,
					status: true,
					createdAt: true,
					instance: {
						select: {
							id: true,
							name: true,
						},
					},
				},
			},
		},
	});
}

export async function updateTemplateInstanceArtifactRag({
	id,
	qdrantId,
	chunkCount,
}: {
	id: string;
	qdrantId: string;
	chunkCount: number;
}) {
	return db.templateInstanceArtifact.update({
		where: { id },
		data: {
			qdrantId,
			chunkCount,
			embeddedAt: new Date(),
		},
	});
}

/**
 * Create template instance artifact chunks
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createTemplateInstanceArtifactChunks(
	chunks: Array<{
		artifactId: string;
		content: string;
		chunkIndex: number;
		qdrantId?: string;
		metadata?: Prisma.InputJsonValue;
	}>,
	tenantContext: {
		userId: string;
		organizationId?: string;
	},
) {
	return db.templateInstanceArtifactChunk.createMany({
		data: chunks.map((chunk) => ({
			artifactId: chunk.artifactId,
			content: chunk.content,
			chunkIndex: chunk.chunkIndex,
			qdrantId: chunk.qdrantId,
			metadata: chunk.metadata,
			userId: tenantContext.userId,
			organizationId: tenantContext.organizationId,
		})),
	});
}

// =============================================================================
// Scheduled Instance Queries (for cron job)
// =============================================================================

export async function getScheduledInstances(beforeTime: Date) {
	return db.templateInstance.findMany({
		where: {
			// status ACTIVE = the latest, live version. Without this, an ARCHIVED
			// version (versioning sets status:ARCHIVED but leaves isActive/schedule/
			// nextRunAt intact) would still be swept and fired.
			status: "ACTIVE",
			isActive: true,
			schedule: { not: Prisma.DbNull },
			nextRunAt: { lte: beforeTime },
			// OFF rows retain their schedule but must never be swept — the user has
			// explicitly paused scheduling for this instance.
			scheduleMode: { not: "OFF" },
		},
		include: {
			template: {
				select: {
					id: true,
					name: true,
					definition: true,
					fabricConfig: true,
					outputFormat: true,
				},
			},
		},
	});
}

export async function updateInstanceNextRunAt(
	id: string,
	nextRunAt: Date | null,
) {
	return db.templateInstance.update({
		where: { id },
		data: { nextRunAt },
	});
}

/**
 * Compare-and-swap claim: advance `nextRunAt` only if it still equals the value the
 * dispatcher observed (`expectedNextRunAt`). Returns true iff this caller won the claim.
 * Prevents double-fire and avoids clobbering a concurrent schedule edit.
 */
export async function claimAndAdvanceScheduledInstance(
	id: string,
	expectedNextRunAt: Date,
	newNextRunAt: Date,
): Promise<boolean> {
	const result = await db.templateInstance.updateMany({
		where: { id, nextRunAt: expectedNextRunAt },
		data: { nextRunAt: newNextRunAt },
	});
	return result.count === 1;
}

/**
 * Look up an execution by its deterministic scheduled workflowId. Backs the
 * create-or-get idempotency of the scheduled dispatch.
 */
export async function findExecutionByWorkflowId(workflowId: string) {
	return db.templateInstanceExecution.findFirst({
		where: { workflowId },
		select: { id: true, instanceId: true, status: true },
	});
}

/**
 * Active instances that carry a schedule but have no computed `nextRunAt` yet
 * (legacy / freshly-inherited rows). The reconcile pass normalizes them and
 * sets `nextRunAt`.
 *
 * OFF gate (load-bearing, spec §11): an OFF instance retains its schedule object
 * and has `nextRunAt = null` after being paused — exactly this query's match
 * pattern. Without `scheduleMode != OFF`, the backfill would recompute (and
 * re-arm) a paused instance.
 */
export async function listInstancesNeedingNextRunAt(limit: number) {
	return db.templateInstance.findMany({
		where: {
			status: "ACTIVE",
			isActive: true,
			schedule: { not: Prisma.DbNull },
			nextRunAt: null,
			// OFF instances must not have their nextRunAt recomputed — they are
			// paused and their null nextRunAt is intentional.
			scheduleMode: { not: "OFF" },
		},
		select: { id: true, schedule: true },
		take: limit,
	});
}

/**
 * Active instances with NO schedule whose template carries one, scoped so a tenant
 * only ever inherits from a template IT owns — never a SYSTEM/public template owned by
 * another tenant. Returns the owning template's raw schedule to inherit.
 *
 * INHERITED gate: only rows whose `scheduleMode = INHERITED` should be
 * re-seeded. An OFF row with `schedule = null` matches the `schedule equals DbNull`
 * predicate but must NOT be re-seeded — the user explicitly paused it. Gating to
 * `scheduleMode = "INHERITED"` is the load-bearing guard here.
 */
export async function listInstancesNeedingScheduleInheritance(limit: number) {
	const rows = await db.templateInstance.findMany({
		where: {
			status: "ACTIVE",
			isActive: true,
			schedule: { equals: Prisma.DbNull },
			template: { schedule: { not: Prisma.DbNull } },
			// Only re-seed INHERITED rows — OFF rows with null schedules must stay
			// paused and must never receive a fresh schedule from the template.
			scheduleMode: "INHERITED",
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
			template: {
				select: {
					schedule: true,
					scope: true,
					userId: true,
					organizationId: true,
				},
			},
		},
		take: limit,
	});
	return rows
		.filter(
			(r) =>
				ownerScopedTemplateSchedule(
					{
						scope: r.template.scope,
						userId: r.template.userId,
						organizationId: r.template.organizationId,
						schedule: r.template.schedule,
					},
					r.userId,
					r.organizationId,
				) !== undefined,
		)
		.map((r) => ({
			id: r.id,
			userId: r.userId,
			organizationId: r.organizationId,
			templateSchedule: r.template.schedule,
		}));
}

/** Persist a normalized schedule + its computed nextRunAt onto an instance (reconcile setter). */
export async function setInstanceSchedule(
	id: string,
	schedule: ReportScheduleConfig,
	nextRunAt: Date,
) {
	await db.templateInstance.update({
		where: { id },
		data: {
			schedule: schedule as unknown as Prisma.InputJsonValue,
			nextRunAt,
		},
	});
}

// =============================================================================
// Template-instance artifact email delivery (send-by-email + per-artifact history)
//
// Backed by `template_instance_artifact_email_delivery`, FK→`template_instance_artifact`.
// `ReportArtifact` is a separate, currently-unused model — do not confuse.
// =============================================================================

export interface CreateTemplateInstanceArtifactEmailDeliveryInput {
	artifactId: string;
	sendId: string;
	userId: string;
	organizationId?: string | null;
	recipientUserId?: string | null;
	recipientEmail: string;
	messageBody?: string | null;
	status: "SENT" | "FAILED";
	errorMessage?: string | null;
}

/**
 * Bulk-insert delivery rows for a single send action — one row per recipient.
 * Uses `createMany` so all rows hit the DB in a single round-trip even when
 * the send produced a mix of SENT / FAILED outcomes. Caller passes the
 * shared `sendId` so the history-list query can aggregate the recipients
 * back into a single send entry.
 */
export async function createTemplateInstanceArtifactEmailDeliveries(
	rows: CreateTemplateInstanceArtifactEmailDeliveryInput[],
) {
	if (rows.length === 0) {
		return { count: 0 };
	}
	return db.templateInstanceArtifactEmailDelivery.createMany({
		data: rows.map((r) => ({
			artifactId: r.artifactId,
			sendId: r.sendId,
			userId: r.userId,
			organizationId: r.organizationId ?? null,
			recipientUserId: r.recipientUserId ?? null,
			recipientEmail: r.recipientEmail,
			messageBody: r.messageBody ?? null,
			status: r.status,
			errorMessage: r.errorMessage ?? null,
		})),
	});
}

export interface ListTemplateInstanceArtifactSendsParams {
	artifactId: string;
	/** Free-text filter applied to `recipientEmail` and `messageBody`, case-insensitive. */
	search?: string;
	/** Max number of *send actions* returned (not individual recipients). */
	limit: number;
	/** Number of *send actions* to skip for pagination. */
	offset: number;
}

interface DeliveryRow {
	id: string;
	sendId: string;
	sentAt: Date;
	userId: string;
	user: { id: string; name: string | null; email: string };
	recipientUserId: string | null;
	recipientEmail: string;
	recipientUser: { id: string; name: string | null; email: string } | null;
	messageBody: string | null;
	status: "SENT" | "FAILED";
	errorMessage: string | null;
}

export interface ArtifactSendHistoryEntry {
	sendId: string;
	sentAt: Date;
	sender: { id: string; name: string | null; email: string };
	messageBody: string | null;
	recipients: Array<{
		recipientEmail: string;
		recipientUserId: string | null;
		recipientUser: {
			id: string;
			name: string | null;
			email: string;
		} | null;
		status: "SENT" | "FAILED";
		errorMessage: string | null;
	}>;
}

/**
 * Per-artifact send history. Returns one entry per `sendId` (collapsed across
 * recipients), newest first, with an optional case-insensitive `search` filter
 * matching `recipientEmail` or `messageBody` on *any* row of the send.
 *
 * Pagination is at the send level — `limit`/`offset` count distinct sends.
 *
 * Tenant filtering relies on RLS (`user_owned` policy applied to
 * `template_instance_artifact_email_delivery`) — see scripts/apply-rls-direct.ts.
 * Callers MUST verify the parent artifact belongs to the requesting tenant
 * before invoking this; the RLS layer is defense-in-depth, not the only guard.
 */
export async function listTemplateInstanceArtifactEmailDeliveries(
	params: ListTemplateInstanceArtifactSendsParams,
): Promise<{ sends: ArtifactSendHistoryEntry[]; total: number }> {
	const { artifactId, search, limit, offset } = params;
	const trimmedSearch = search?.trim();

	// Identify the matching sends first (one row per sendId, ordered by the
	// most recent recipient row in each group). When `search` is supplied we
	// keep only sends that have *at least one* recipient/note matching the
	// term — the response then still includes ALL recipients of that send so
	// the user sees the full distribution.
	const filteredSendIds: Array<{ sendId: string; sentAt: Date }> =
		await db.$queryRaw<Array<{ sendId: string; sentAt: Date }>>`
		SELECT "sendId", MAX("sentAt") AS "sentAt"
		FROM "template_instance_artifact_email_delivery"
		WHERE "artifactId" = ${artifactId}
		${
			trimmedSearch
				? Prisma.sql`AND (
			"recipientEmail" ILIKE ${`%${trimmedSearch}%`}
			OR COALESCE("messageBody", '') ILIKE ${`%${trimmedSearch}%`}
		)`
				: Prisma.empty
		}
		GROUP BY "sendId"
		ORDER BY MAX("sentAt") DESC
		LIMIT ${limit}
		OFFSET ${offset}
	`;

	const totalRows: Array<{ count: bigint }> = await db.$queryRaw<
		Array<{ count: bigint }>
	>`
		SELECT COUNT(DISTINCT "sendId")::bigint AS count
		FROM "template_instance_artifact_email_delivery"
		WHERE "artifactId" = ${artifactId}
		${
			trimmedSearch
				? Prisma.sql`AND (
			"recipientEmail" ILIKE ${`%${trimmedSearch}%`}
			OR COALESCE("messageBody", '') ILIKE ${`%${trimmedSearch}%`}
		)`
				: Prisma.empty
		}
	`;
	const total = Number(totalRows[0]?.count ?? BigInt(0));

	if (filteredSendIds.length === 0) {
		return { sends: [], total };
	}

	const sendIds = filteredSendIds.map((s) => s.sendId);

	const rows = (await db.templateInstanceArtifactEmailDelivery.findMany({
		where: { artifactId, sendId: { in: sendIds } },
		include: {
			user: { select: { id: true, name: true, email: true } },
			recipientUser: {
				select: { id: true, name: true, email: true },
			},
		},
		orderBy: { sentAt: "desc" },
	})) as unknown as DeliveryRow[];

	const grouped = new Map<string, ArtifactSendHistoryEntry>();
	for (const row of rows) {
		const existing = grouped.get(row.sendId);
		if (!existing) {
			grouped.set(row.sendId, {
				sendId: row.sendId,
				sentAt: row.sentAt,
				sender: row.user,
				messageBody: row.messageBody,
				recipients: [
					{
						recipientEmail: row.recipientEmail,
						recipientUserId: row.recipientUserId,
						recipientUser: row.recipientUser,
						status: row.status,
						errorMessage: row.errorMessage,
					},
				],
			});
		} else {
			existing.recipients.push({
				recipientEmail: row.recipientEmail,
				recipientUserId: row.recipientUserId,
				recipientUser: row.recipientUser,
				status: row.status,
				errorMessage: row.errorMessage,
			});
			// Preserve the earliest sentAt of the group as the canonical send
			// time (rows share an insert batch but may differ by μs).
			if (row.sentAt < existing.sentAt) {
				existing.sentAt = row.sentAt;
			}
		}
	}

	// Preserve the order returned by the windowed query.
	const sends = sendIds
		.map((id) => grouped.get(id))
		.filter((entry): entry is ArtifactSendHistoryEntry => Boolean(entry));

	return { sends, total };
}
