import { createHash } from "node:crypto";
import { z } from "zod";
import { withRLSContext } from "../../../src/tenant-db";
import { db, Prisma } from "../../client";

export const CONTEXT_QUALITY_RUN_STATUSES = [
	"QUEUED",
	"EXPORTING",
	"DISPATCHING",
	"RUNNING",
	"CANCEL_REQUESTED",
	"SUCCEEDED",
	"FAILED",
	"CANCELLED",
	"RECONCILIATION_REQUIRED",
] as const;
export type ContextQualityRunStatus =
	(typeof CONTEXT_QUALITY_RUN_STATUSES)[number];
export const CONTEXT_QUALITY_TERMINAL_STATUSES = [
	"SUCCEEDED",
	"FAILED",
	"CANCELLED",
] as const;
export const CONTEXT_QUALITY_CLEANUP_STATUSES = [
	"NOT_REQUIRED",
	"PENDING",
	"CONFIRMED",
	"BLOCKED",
] as const;
export type ContextQualityCleanupStatus =
	(typeof CONTEXT_QUALITY_CLEANUP_STATUSES)[number];

export interface ContextQualityScope {
	organizationId: string;
	projectId: string;
}
export interface ContextQualityRunScope extends ContextQualityScope {
	runId: string;
}

export class ContextQualityStoreError extends Error {
	constructor(
		readonly code:
			| "INVALID_INPUT"
			| "NOT_FOUND"
			| "INVALID_BINDING"
			| "IDEMPOTENCY_CONFLICT"
			| "BINDING_CHANGED"
			| "INVALID_TRANSITION",
	) {
		super("Context evaluation persistence request could not be completed.");
		this.name = "ContextQualityStoreError";
	}
}

function validId(value: unknown, max = 128): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}
function hash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function requireScope(scope: ContextQualityScope): void {
	if (!validId(scope.organizationId) || !validId(scope.projectId))
		throw new ContextQualityStoreError("INVALID_INPUT");
}
function requireRunScope(scope: ContextQualityRunScope): void {
	requireScope(scope);
	if (!validId(scope.runId))
		throw new ContextQualityStoreError("INVALID_INPUT");
}
function boundedJson(value: Prisma.InputJsonValue, max = 128 * 1024): void {
	try {
		const text = JSON.stringify(value);
		if (
			!text ||
			text.includes("\\u0000") ||
			Buffer.byteLength(text, "utf8") > max
		)
			throw new Error();
	} catch {
		throw new ContextQualityStoreError("INVALID_INPUT");
	}
}
function scopeWhere(scope: ContextQualityScope) {
	requireScope(scope);
	return { organizationId: scope.organizationId, projectId: scope.projectId };
}
function runWhere(scope: ContextQualityRunScope) {
	requireRunScope(scope);
	return { id: scope.runId, ...scopeWhere(scope) };
}

function unresolvedRunsWhere(
	scope: ContextQualityScope,
): Prisma.ProjectContextQualityRunWhereInput {
	return {
		...scopeWhere(scope),
		OR: [
			{ status: { notIn: [...CONTEXT_QUALITY_TERMINAL_STATUSES] } },
			{ cleanupStatus: { notIn: ["CONFIRMED", "NOT_REQUIRED"] } },
			// NOT_REQUIRED is valid only when no export or remote receipt exists.
			{
				cleanupStatus: "NOT_REQUIRED",
				OR: [
					{ remoteRunId: { not: null } },
					{ remoteMlflowRunId: { not: null } },
					{ remoteInputPath: { not: null } },
					{ providerReceiptJson: { not: Prisma.DbNull } },
				],
			},
		],
	};
}

function canonical(value: Prisma.InputJsonValue | Prisma.JsonValue): string {
	if (Array.isArray(value))
		return `[${value.map((item) => canonical(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Prisma.JsonObject)[key]!)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().refine((value) => validId(value));
const outcome = z.enum(["passed", "failed"]);
const metric = z.strictObject({
	precision: z.number().min(0).max(1).nullable(),
	recall: z.number().min(0).max(1).nullable(),
});
// Persistence accepts only the content-free report contract, not arbitrary JSON
// or an evaluator import (RAG depends on database, never the reverse).
const safeResult = z.strictObject({
	version: z.literal(1),
	mode: z.literal("recorded-output"),
	scorerVersion: identifier,
	datasetHash: digest,
	configurationHash: digest,
	snapshotHash: digest,
	status: outcome,
	counts: z.strictObject({
		cases: z.number().int().min(1).max(50),
		passed: z.number().int().min(0).max(50),
		failed: z.number().int().min(0).max(50),
		integrityFailures: z.number().int().min(0).max(500),
		qualityFailures: z.number().int().min(0).max(500),
	}),
	sources: z
		.array(z.strictObject({ id: identifier, revision: digest }))
		.max(50),
	cases: z
		.array(
			z.strictObject({
				id: identifier,
				status: outcome,
				checks: z
					.array(
						z.strictObject({
							id: z.enum([
								"recorded-answer-present",
								"retrieved-sources-available",
								"cited-sources-available",
								"citations-retrieved",
								"expected-sources-available",
								"expected-sources-retrieved",
								"expected-sources-cited",
								"citation-precision",
								"required-phrases",
								"forbidden-phrases",
							]),
							category: z.enum(["integrity", "quality"]),
							status: outcome,
						}),
					)
					.min(1)
					.max(10),
				retrieval: metric,
				citations: metric,
			}),
		)
		.min(1)
		.max(50),
});
const sourceRefs = z
	.array(
		z.strictObject({
			sourceId: identifier,
			expectedRevision: digest,
		}),
	)
	.min(1)
	.max(8);
const providerReceipt = z.strictObject({
	version: z.literal(1),
	fabricRunId: identifier,
	payloadHash: digest,
	experimentId: z.string().regex(/^(0|[1-9]\d{0,31})$/),
	mlflowRunId: z.string().regex(/^[a-f0-9]{32}$/),
});

function parseStoredJson<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new ContextQualityStoreError("INVALID_INPUT");
	return parsed.data;
}

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

async function lockProject(
	tx: Prisma.TransactionClient,
	scope: ContextQualityScope,
) {
	await tx.$executeRaw(
		Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`context-quality-binding:${scope.organizationId}:${scope.projectId}`}, 0))`,
	);
}

async function requireSharedIntegration(
	tx: Prisma.TransactionClient,
	input: ContextQualityScope & { integrationId: string },
) {
	const integration = await tx.workflowIntegration.findFirst({
		where: {
			id: input.integrationId,
			organizationId: input.organizationId,
			provider: "DATABRICKS_PLATFORM",
			workflowId: null,
			isActive: true,
			usageScope: "ORGANIZATION_SHARED",
		},
		select: { id: true, userId: true },
	});
	if (
		!integration ||
		!(await tx.member.findFirst({
			where: {
				organizationId: input.organizationId,
				userId: integration.userId,
			},
			select: { id: true },
		}))
	)
		throw new ContextQualityStoreError("INVALID_BINDING");
}

export interface ContextQualityBindingSnapshot extends ContextQualityScope {
	id: string;
	integrationId: string;
	workspaceOrigin: string;
	jobId: string;
	experimentId: string;
	volumeRoot: string;
	notebookPath: string;
	notebookSha256: string;
	principalFingerprint: string;
	configHash: string;
	configVersion: number;
}

export function contextQualityBindingSnapshot(
	binding: ContextQualityBindingSnapshot,
): ContextQualityBindingSnapshot {
	return {
		id: binding.id,
		organizationId: binding.organizationId,
		projectId: binding.projectId,
		integrationId: binding.integrationId,
		workspaceOrigin: binding.workspaceOrigin,
		jobId: binding.jobId,
		experimentId: binding.experimentId,
		volumeRoot: binding.volumeRoot,
		notebookPath: binding.notebookPath,
		notebookSha256: binding.notebookSha256,
		principalFingerprint: binding.principalFingerprint,
		configHash: binding.configHash,
		configVersion: binding.configVersion,
	};
}

export interface SaveContextQualityBindingInput extends ContextQualityScope {
	integrationId: string;
	workspaceOrigin: string;
	jobId: string;
	experimentId: string;
	volumeRoot: string;
	notebookPath: string;
	notebookSha256: string;
	principalFingerprint: string;
	configHash: string;
	isEnabled: boolean;
	exportApproved: boolean;
	actorId: string;
	expectedConfigHash?: string;
}

const bindingConfigurationFields = [
	"integrationId",
	"workspaceOrigin",
	"jobId",
	"experimentId",
	"volumeRoot",
	"notebookPath",
	"notebookSha256",
	"principalFingerprint",
] as const;
const bindingReservationFields = [
	"integrationId",
	"workspaceOrigin",
	"jobId",
	"experimentId",
	"volumeRoot",
	"principalFingerprint",
] as const;

/** Authorization to configure a binding belongs at the API boundary too. */
export async function saveContextQualityBinding(
	input: SaveContextQualityBindingInput,
) {
	requireScope(input);
	let origin: URL;
	try {
		origin = new URL(input.workspaceOrigin);
	} catch {
		throw new ContextQualityStoreError("INVALID_INPUT");
	}
	if (
		!validId(input.actorId) ||
		!validId(input.integrationId) ||
		!hash(input.principalFingerprint) ||
		!hash(input.configHash) ||
		!hash(input.notebookSha256) ||
		(input.expectedConfigHash !== undefined &&
			!hash(input.expectedConfigHash)) ||
		origin.protocol !== "https:" ||
		origin.origin !== input.workspaceOrigin ||
		input.workspaceOrigin.length > 512 ||
		origin.username ||
		origin.password ||
		!/^(0|[1-9]\d{0,31})$/.test(input.jobId) ||
		!/^(0|[1-9]\d{0,31})$/.test(input.experimentId) ||
		// Unity Catalog identifiers are case-insensitive: aliases must not
		// evade the workspace/resource unique constraints.
		!/^\/Volumes\/[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(
			input.volumeRoot,
		) ||
		input.volumeRoot.length > 512 ||
		!validId(input.notebookPath, 768) ||
		!input.notebookPath.startsWith("/") ||
		input.notebookPath.includes("\\") ||
		input.notebookPath
			.split("/")
			.slice(1)
			.some((part) => !part || part === "." || part === "..") ||
		typeof input.isEnabled !== "boolean" ||
		typeof input.exportApproved !== "boolean" ||
		(input.isEnabled && !input.exportApproved)
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	return withRLSContext(db, async (tx) => {
		await lockProject(tx, input);
		const project = await tx.project.findFirst({
			where: {
				id: input.projectId,
				organizationId: input.organizationId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!project) throw new ContextQualityStoreError("NOT_FOUND");
		await requireSharedIntegration(tx, input);
		// The global primary key is the exclusion guard even when another
		// organization's claim is invisible under tenant filters and RLS.
		await tx.projectContextQualityPrincipal.createMany({
			data: [
				{
					fingerprint: input.principalFingerprint,
					organizationId: input.organizationId,
				},
			],
			skipDuplicates: true,
		});
		if (
			!(await tx.projectContextQualityPrincipal.findFirst({
				where: {
					fingerprint: input.principalFingerprint,
					organizationId: input.organizationId,
				},
				select: { fingerprint: true },
			}))
		)
			throw new ContextQualityStoreError("INVALID_BINDING");
		const existing = await tx.projectContextQualityBinding.findFirst({
			where: scopeWhere(input),
		});
		if (
			input.expectedConfigHash !== undefined &&
			existing?.configHash !== input.expectedConfigHash
		)
			throw new ContextQualityStoreError("BINDING_CHANGED");
		const sameConfiguration =
			existing &&
			bindingConfigurationFields.every(
				(key) => existing[key] === input[key],
			);
		if (existing?.configHash === input.configHash && !sameConfiguration)
			throw new ContextQualityStoreError("BINDING_CHANGED");
		if (
			existing &&
			sameConfiguration &&
			existing.configHash === input.configHash &&
			existing.isEnabled === input.isEnabled &&
			Boolean(existing.exportApprovedAt) === input.exportApproved
		)
			return existing;
		if (
			existing &&
			bindingReservationFields.some(
				(key) => existing[key] !== input[key],
			) &&
			(await tx.projectContextQualityRun.count({
				where: unresolvedRunsWhere(input),
			})) > 0
		) {
			// Keep both the resource reservation and the integration FK alive
			// until the original frozen receipts can no longer need cleanup.
			throw new ContextQualityStoreError("BINDING_CHANGED");
		}
		const data = {
			integrationId: input.integrationId,
			workspaceOrigin: input.workspaceOrigin,
			jobId: input.jobId,
			experimentId: input.experimentId,
			volumeRoot: input.volumeRoot,
			notebookPath: input.notebookPath,
			notebookSha256: input.notebookSha256,
			principalFingerprint: input.principalFingerprint,
			configHash: input.configHash,
			isEnabled: input.isEnabled,
			exportApprovedAt: input.exportApproved ? new Date() : null,
			exportApprovedBy: input.exportApproved ? input.actorId : null,
			updatedBy: input.actorId,
		};
		return tx.projectContextQualityBinding.upsert({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			create: {
				...data,
				organizationId: input.organizationId,
				projectId: input.projectId,
				createdBy: input.actorId,
			},
			update: { ...data, configVersion: { increment: 1 } },
		});
	}).catch((error: unknown) => {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2002"
		) {
			// Resource uniqueness is global to a workspace. Do not disclose the
			// other project's identifiers from Prisma's constraint diagnostics.
			throw new ContextQualityStoreError("INVALID_BINDING");
		}
		throw error;
	});
}

/** Revocation is local and remains possible when the remote connection is unavailable. */
export async function disableContextQualityBinding(
	scope: ContextQualityScope & { actorId: string },
) {
	const where = scopeWhere(scope);
	if (!validId(scope.actorId))
		throw new ContextQualityStoreError("INVALID_INPUT");
	return withRLSContext(db, async (tx) => {
		await lockProject(tx, scope);
		await tx.projectContextQualityBinding.updateMany({
			where: { ...where, isEnabled: true },
			data: {
				isEnabled: false,
				exportApprovedAt: null,
				exportApprovedBy: null,
				updatedBy: scope.actorId,
				configVersion: { increment: 1 },
			},
		});
	});
}

export async function getContextQualityBinding(scope: ContextQualityScope) {
	const where = scopeWhere(scope);
	return withRLSContext(db, (tx) =>
		tx.projectContextQualityBinding.findFirst({ where }),
	);
}

const summarySelect = {
	id: true,
	organizationId: true,
	projectId: true,
	requestedBy: true,
	name: true,
	status: true,
	stateVersion: true,
	sourceRefsJson: true,
	payloadHash: true,
	snapshotHash: true,
	scorerVersion: true,
	bindingConfigHash: true,
	bindingConfigJson: true,
	workflowId: true,
	remoteRunId: true,
	remoteMlflowRunId: true,
	remoteState: true,
	resultJson: true,
	errorCode: true,
	cleanupStatus: true,
	cleanupErrorCode: true,
	cancelRequestedAt: true,
	startedAt: true,
	completedAt: true,
	deadlineAt: true,
	snapshotExpiresAt: true,
	snapshotPurgedAt: true,
	createdAt: true,
	updatedAt: true,
} as const;

function summarize<T extends { bindingConfigJson: Prisma.JsonValue }>(row: T) {
	const { bindingConfigJson, ...safe } = row;
	const binding =
		bindingConfigJson &&
		typeof bindingConfigJson === "object" &&
		!Array.isArray(bindingConfigJson)
			? bindingConfigJson
			: {};
	return {
		...safe,
		workspaceOrigin:
			typeof binding.workspaceOrigin === "string"
				? binding.workspaceOrigin
				: null,
		jobId: typeof binding.jobId === "string" ? binding.jobId : null,
		experimentId:
			typeof binding.experimentId === "string"
				? binding.experimentId
				: null,
	};
}

export async function getContextQualityRunSummary(
	scope: ContextQualityRunScope,
) {
	const where = runWhere(scope);
	const row = await withRLSContext(db, (tx) =>
		tx.projectContextQualityRun.findFirst({ where, select: summarySelect }),
	);
	return row ? summarize(row) : null;
}

/** Retry lookup precedes source loading; a previously admitted key is immutable. */
export async function getContextQualityRunByRequest(
	input: ContextQualityScope & {
		requestedBy: string;
		idempotencyKey: string;
	},
) {
	const where = scopeWhere(input);
	if (!validId(input.requestedBy) || !validId(input.idempotencyKey))
		throw new ContextQualityStoreError("INVALID_INPUT");
	const row = await withRLSContext(db, (tx) =>
		tx.projectContextQualityRun.findFirst({
			where: {
				...where,
				requestedBy: input.requestedBy,
				idempotencyKey: input.idempotencyKey,
			},
			select: { ...summarySelect, requestHash: true },
		}),
	);
	return row ? summarize(row) : null;
}

export async function listContextQualityRunSummaries(
	input: ContextQualityScope & { limit?: number; cursor?: string },
) {
	const limit = input.limit ?? 20;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 50 ||
		(input.cursor !== undefined && !validId(input.cursor))
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	const scope = scopeWhere(input);
	return withRLSContext(db, async (tx) => {
		const cursor = input.cursor
			? await tx.projectContextQualityRun.findFirst({
					where: { ...scope, id: input.cursor },
					select: { id: true, createdAt: true },
				})
			: null;
		if (input.cursor && !cursor)
			throw new ContextQualityStoreError("INVALID_INPUT");
		const rows = await tx.projectContextQualityRun.findMany({
			where: {
				...scope,
				...(cursor
					? {
							OR: [
								{ createdAt: { lt: cursor.createdAt } },
								{
									createdAt: cursor.createdAt,
									id: { lt: cursor.id },
								},
							],
						}
					: {}),
			},
			select: summarySelect,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit + 1,
		});
		return {
			runs: rows.slice(0, limit).map(summarize),
			nextCursor:
				rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
		};
	});
}

export interface AdmitContextQualityRunInput extends ContextQualityScope {
	id: string;
	requestedBy: string;
	name: string;
	idempotencyKey: string;
	requestHash: string;
	bindingId: string;
	bindingConfigHash: string;
	sourceRefsJson: Prisma.InputJsonValue;
	snapshotPayload: string;
	payloadHash: string;
	snapshotHash: string;
	scorerVersion: string;
	localResultJson: Prisma.InputJsonValue;
	workflowId: string;
	dispatchToken: string;
	deadlineAt: Date;
	snapshotExpiresAt: Date;
}

/** Immutable input is loaded privately by worker activities, never workflow arguments. */
export async function admitContextQualityRun(
	input: AdmitContextQualityRunInput,
) {
	requireScope(input);
	if (
		![
			input.id,
			input.bindingId,
			input.requestedBy,
			input.idempotencyKey,
		].every((value) => validId(value)) ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
		!validId(input.name, 80) ||
		!validId(input.workflowId, 256) ||
		!validId(input.dispatchToken, 64) ||
		!validId(input.scorerVersion) ||
		![
			input.requestHash,
			input.bindingConfigHash,
			input.payloadHash,
			input.snapshotHash,
		].every(hash) ||
		typeof input.snapshotPayload !== "string" ||
		!input.snapshotPayload.length ||
		input.snapshotPayload.includes("\u0000") ||
		Buffer.byteLength(input.snapshotPayload, "utf8") > 128 * 1024 ||
		Buffer.from(input.snapshotPayload, "utf8").toString("utf8") !==
			input.snapshotPayload ||
		createHash("sha256")
			.update(input.snapshotPayload, "utf8")
			.digest("hex") !== input.payloadHash ||
		!validDate(input.deadlineAt) ||
		!validDate(input.snapshotExpiresAt) ||
		input.snapshotExpiresAt < input.deadlineAt
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	boundedJson(input.sourceRefsJson, 16 * 1024);
	boundedJson(input.localResultJson);
	const refs = parseStoredJson(sourceRefs, input.sourceRefsJson);
	const localResult = parseStoredJson(safeResult, input.localResultJson);
	if (
		localResult.snapshotHash !== input.snapshotHash ||
		localResult.scorerVersion !== input.scorerVersion ||
		new Set(refs.map((ref) => ref.sourceId)).size !== refs.length ||
		canonical(localResult.sources) !==
			canonical(
				refs
					.map((ref) => ({
						id: ref.sourceId,
						revision: ref.expectedRevision,
					}))
					.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
			)
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	const key = {
		...scopeWhere(input),
		requestedBy: input.requestedBy,
		idempotencyKey: input.idempotencyKey,
	};
	try {
		return await withRLSContext(db, async (tx) => {
			// Serialize admission, rebinding and deletion for this exact project.
			await lockProject(tx, input);
			const existing = await tx.projectContextQualityRun.findFirst({
				where: key,
				select: { id: true, requestHash: true },
			});
			if (existing) {
				if (existing.requestHash !== input.requestHash)
					throw new ContextQualityStoreError("IDEMPOTENCY_CONFLICT");
				const row = await tx.projectContextQualityRun.findFirst({
					where: { ...key, id: existing.id },
					select: summarySelect,
				});
				return { created: false, run: row ? summarize(row) : null };
			}
			// A retry of an already-admitted request remains valid after expiry.
			if (input.deadlineAt.getTime() <= Date.now())
				throw new ContextQualityStoreError("INVALID_INPUT");
			const project = await tx.project.findFirst({
				where: {
					id: input.projectId,
					organizationId: input.organizationId,
					deletedAt: null,
				},
				select: { id: true },
			});
			if (!project) throw new ContextQualityStoreError("NOT_FOUND");
			const binding = await tx.projectContextQualityBinding.findFirst({
				where: {
					...scopeWhere(input),
					id: input.bindingId,
					isEnabled: true,
					exportApprovedAt: { not: null },
				},
			});
			if (!binding) throw new ContextQualityStoreError("INVALID_BINDING");
			if (binding.configHash !== input.bindingConfigHash)
				throw new ContextQualityStoreError("BINDING_CHANGED");
			await requireSharedIntegration(tx, {
				...input,
				integrationId: binding.integrationId,
			});
			const row = await tx.projectContextQualityRun.create({
				data: {
					id: input.id,
					...scopeWhere(input),
					requestedBy: input.requestedBy,
					name: input.name,
					idempotencyKey: input.idempotencyKey,
					requestHash: input.requestHash,
					bindingId: input.bindingId,
					sourceRefsJson: refs,
					snapshotPayload: input.snapshotPayload,
					payloadHash: input.payloadHash,
					snapshotHash: input.snapshotHash,
					scorerVersion: input.scorerVersion,
					bindingConfigJson: {
						...contextQualityBindingSnapshot(binding),
					},
					bindingConfigHash: binding.configHash,
					localResultJson: localResult,
					workflowId: input.workflowId,
					dispatchToken: input.dispatchToken,
					deadlineAt: input.deadlineAt,
					snapshotExpiresAt: input.snapshotExpiresAt,
				},
				select: summarySelect,
			});
			return { created: true, run: summarize(row) };
		});
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2002"
		) {
			const winner = await withRLSContext(db, (tx) =>
				tx.projectContextQualityRun.findFirst({
					where: key,
					select: { id: true, requestHash: true },
				}),
			);
			if (winner) {
				if (winner.requestHash !== input.requestHash)
					throw new ContextQualityStoreError("IDEMPOTENCY_CONFLICT");
				return {
					created: false,
					run: await getContextQualityRunSummary({
						...input,
						runId: winner.id,
					}),
				};
			}
		}
		if (error instanceof ContextQualityStoreError) throw error;
		// Prisma create diagnostics can include its data arguments. Never attach
		// the original error/cause when those arguments contain private bytes.
		throw new Error(
			"Context evaluation persistence request could not be completed.",
		);
	}
}

/** INTERNAL: raw bounded input is deliberately absent from all summary readers. */
export async function getContextQualityRunForWorker(
	scope: ContextQualityRunScope,
) {
	const where = runWhere(scope);
	return withRLSContext(db, (tx) =>
		tx.projectContextQualityRun.findFirst({
			where,
			include: { binding: true },
		}),
	);
}

export interface ContextQualityRunPatch {
	status?: ContextQualityRunStatus;
	remoteRunId?: string;
	remoteMlflowRunId?: string;
	remoteLookupPageToken?: string | null;
	remoteState?: string;
	providerReceiptJson?: Prisma.InputJsonValue;
	resultJson?: Prisma.InputJsonValue;
	errorCode?: string | null;
	remoteInputPath?: string;
	cleanupStatus?: ContextQualityCleanupStatus;
	cleanupErrorCode?: string | null;
	startedAt?: Date;
	completedAt?: Date;
}

const transitions: Record<
	ContextQualityRunStatus,
	readonly ContextQualityRunStatus[]
> = {
	QUEUED: [
		"EXPORTING",
		"FAILED",
		"CANCEL_REQUESTED",
		"CANCELLED",
		"RECONCILIATION_REQUIRED",
	],
	EXPORTING: [
		"EXPORTING",
		"DISPATCHING",
		"FAILED",
		"CANCEL_REQUESTED",
		"CANCELLED",
		"RECONCILIATION_REQUIRED",
	],
	DISPATCHING: [
		"EXPORTING",
		"RUNNING",
		"FAILED",
		"CANCEL_REQUESTED",
		"CANCELLED",
		"RECONCILIATION_REQUIRED",
	],
	RUNNING: [
		"SUCCEEDED",
		"FAILED",
		"CANCEL_REQUESTED",
		"CANCELLED",
		"RECONCILIATION_REQUIRED",
	],
	CANCEL_REQUESTED: ["CANCELLED", "RECONCILIATION_REQUIRED"],
	RECONCILIATION_REQUIRED: [
		"EXPORTING",
		"DISPATCHING",
		"RUNNING",
		"SUCCEEDED",
		"FAILED",
		"CANCEL_REQUESTED",
		"CANCELLED",
		"RECONCILIATION_REQUIRED",
	],
	SUCCEEDED: [],
	FAILED: [],
	CANCELLED: [],
};
const cleanupTransitions: Record<
	ContextQualityCleanupStatus,
	readonly ContextQualityCleanupStatus[]
> = {
	NOT_REQUIRED: ["NOT_REQUIRED", "PENDING", "BLOCKED", "CONFIRMED"],
	PENDING: ["PENDING", "BLOCKED", "CONFIRMED"],
	BLOCKED: ["BLOCKED", "PENDING", "CONFIRMED"],
	CONFIRMED: ["CONFIRMED"],
};

/** CAS fences delayed activities and prevents terminal result replacement. */
export async function transitionContextQualityRun(
	input: ContextQualityRunScope & {
		expectedStateVersion: number;
		fromStatuses: readonly ContextQualityRunStatus[];
		patch: ContextQualityRunPatch;
	},
) {
	const where = runWhere(input);
	const allowedKeys = new Set([
		"status",
		"remoteRunId",
		"remoteMlflowRunId",
		"remoteLookupPageToken",
		"remoteState",
		"providerReceiptJson",
		"resultJson",
		"errorCode",
		"remoteInputPath",
		"cleanupStatus",
		"cleanupErrorCode",
		"startedAt",
		"completedAt",
	]);
	if (
		Object.keys(input.patch).some((key) => !allowedKeys.has(key)) ||
		(input.patch.cleanupStatus !== undefined &&
			!CONTEXT_QUALITY_CLEANUP_STATUSES.includes(
				input.patch.cleanupStatus,
			)) ||
		(input.patch.remoteRunId !== undefined &&
			!/^(0|[1-9]\d{0,31})$/.test(input.patch.remoteRunId)) ||
		(input.patch.remoteMlflowRunId !== undefined &&
			!/^[a-f0-9]{32}$/.test(input.patch.remoteMlflowRunId)) ||
		[input.patch.errorCode, input.patch.cleanupErrorCode].some(
			(code) => code != null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(code),
		) ||
		(input.patch.remoteState !== undefined &&
			!validId(input.patch.remoteState, 64)) ||
		(input.patch.remoteInputPath !== undefined &&
			(!validId(input.patch.remoteInputPath, 768) ||
				!input.patch.remoteInputPath.startsWith("/Volumes/") ||
				input.patch.remoteInputPath.includes("\\") ||
				input.patch.remoteInputPath
					.split("/")
					.slice(1)
					.some((part) => !part || part === "." || part === ".."))) ||
		[input.patch.startedAt, input.patch.completedAt].some(
			(date) => date !== undefined && !validDate(date),
		)
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	if (
		!Number.isInteger(input.expectedStateVersion) ||
		input.expectedStateVersion < 0 ||
		input.fromStatuses.length === 0 ||
		input.fromStatuses.some(
			(s) => !CONTEXT_QUALITY_RUN_STATUSES.includes(s),
		) ||
		(input.patch.status !== undefined &&
			!CONTEXT_QUALITY_RUN_STATUSES.includes(input.patch.status))
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	if (input.patch.providerReceiptJson !== undefined)
		boundedJson(input.patch.providerReceiptJson, 16 * 1024);
	if (input.patch.resultJson !== undefined)
		boundedJson(input.patch.resultJson);
	const patch = { ...input.patch };
	if (
		patch.remoteLookupPageToken !== undefined &&
		patch.remoteLookupPageToken !== null &&
		(typeof patch.remoteLookupPageToken !== "string" ||
			patch.remoteLookupPageToken.length > 2048 ||
			/[\p{Cc}]/u.test(patch.remoteLookupPageToken))
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	if (patch.resultJson !== undefined)
		patch.resultJson = parseStoredJson(safeResult, patch.resultJson);
	if (patch.providerReceiptJson !== undefined)
		patch.providerReceiptJson = parseStoredJson(
			providerReceipt,
			patch.providerReceiptJson,
		);
	return withRLSContext(db, async (tx) => {
		await lockProject(tx, input);
		const existing = await tx.projectContextQualityRun.findFirst({
			where,
			include: { binding: true },
		});
		if (!existing) return { updated: false, run: null };
		const reject = () => {
			throw new ContextQualityStoreError("INVALID_TRANSITION");
		};
		for (const field of [
			"remoteRunId",
			"remoteMlflowRunId",
			"remoteInputPath",
		] as const) {
			if (
				patch[field] !== undefined &&
				existing[field] !== null &&
				patch[field] !== existing[field]
			)
				reject();
		}
		if (
			patch.providerReceiptJson !== undefined &&
			existing.providerReceiptJson !== null &&
			canonical(patch.providerReceiptJson) !==
				canonical(existing.providerReceiptJson)
		)
			reject();
		if (
			existing.stateVersion !== input.expectedStateVersion ||
			!input.fromStatuses.includes(
				existing.status as ContextQualityRunStatus,
			)
		) {
			return { updated: false, run: existing };
		}
		const current = existing.status as ContextQualityRunStatus;
		if (
			!transitions[current] ||
			(patch.status !== undefined &&
				!transitions[current].includes(patch.status))
		)
			reject();
		const terminal = (
			CONTEXT_QUALITY_TERMINAL_STATUSES as readonly string[]
		).includes(current);
		if (
			terminal &&
			Object.keys(patch).some(
				(key) => !["cleanupStatus", "cleanupErrorCode"].includes(key),
			)
		)
			reject();
		if (
			existing.cancelRequestedAt &&
			patch.status &&
			![
				"CANCEL_REQUESTED",
				"CANCELLED",
				"RECONCILIATION_REQUIRED",
			].includes(patch.status)
		) {
			return { updated: false, run: existing };
		}
		if (
			patch.startedAt &&
			existing.startedAt &&
			patch.startedAt.getTime() !== existing.startedAt.getTime()
		)
			reject();
		if (
			patch.completedAt &&
			(!patch.status ||
				!(
					CONTEXT_QUALITY_TERMINAL_STATUSES as readonly string[]
				).includes(patch.status))
		)
			reject();
		if (
			patch.status &&
			(CONTEXT_QUALITY_TERMINAL_STATUSES as readonly string[]).includes(
				patch.status,
			) &&
			!patch.completedAt
		)
			reject();

		const binding = existing.bindingConfigJson as Prisma.JsonObject | null;
		if (
			!binding ||
			binding.projectId !== input.projectId ||
			binding.organizationId !== input.organizationId
		)
			reject();
		if (
			patch.remoteInputPath &&
			patch.remoteInputPath !==
				`${binding!.volumeRoot}/${existing.id}.json`
		)
			reject();
		if (patch.status === "EXPORTING") {
			if (
				existing.remoteRunId ||
				!patch.remoteInputPath ||
				existing.snapshotPayload === null ||
				existing.deadlineAt.getTime() <= Date.now() ||
				existing.snapshotExpiresAt.getTime() <= Date.now() ||
				(patch.cleanupStatus !== undefined &&
					patch.cleanupStatus !== "PENDING")
			)
				reject();
			patch.cleanupStatus = "PENDING";
		}
		if (
			patch.status === "DISPATCHING" &&
			!(patch.remoteInputPath ?? existing.remoteInputPath)
		)
			reject();
		if (
			patch.status === "RUNNING" &&
			!(patch.remoteRunId ?? existing.remoteRunId)
		)
			reject();
		const remoteRunId = patch.remoteRunId ?? existing.remoteRunId;
		const mlflowRunId =
			patch.remoteMlflowRunId ?? existing.remoteMlflowRunId;
		if (patch.providerReceiptJson !== undefined) {
			const receipt = parseStoredJson(
				providerReceipt,
				patch.providerReceiptJson,
			);
			if (
				!remoteRunId ||
				receipt.fabricRunId !== existing.id ||
				receipt.payloadHash !== existing.payloadHash ||
				receipt.experimentId !== binding!.experimentId ||
				receipt.mlflowRunId !== mlflowRunId
			)
				reject();
		}
		if (
			patch.resultJson !== undefined &&
			(patch.status !== "SUCCEEDED" ||
				canonical(patch.resultJson) !==
					canonical(existing.localResultJson))
		)
			reject();
		if (
			patch.status === "SUCCEEDED" &&
			(!remoteRunId ||
				!mlflowRunId ||
				!patch.resultJson ||
				!(patch.providerReceiptJson ?? existing.providerReceiptJson))
		)
			reject();

		const hasRemoteReceipt = Boolean(
			remoteRunId ||
				mlflowRunId ||
				patch.remoteInputPath ||
				existing.remoteInputPath ||
				patch.providerReceiptJson ||
				existing.providerReceiptJson,
		);
		const cleanup = existing.cleanupStatus as ContextQualityCleanupStatus;
		// An unfinished, non-cancelled admission may retry the SAME immutable
		// upload after erasure. Record that new cleanup obligation atomically;
		// settled rows can never downgrade a confirmed receipt.
		const retryingExport =
			cleanup === "CONFIRMED" &&
			patch.cleanupStatus === "PENDING" &&
			patch.status === "EXPORTING" &&
			!terminal &&
			!existing.cancelRequestedAt &&
			!existing.remoteRunId &&
			existing.snapshotPayload !== null &&
			existing.deadlineAt.getTime() > Date.now() &&
			existing.snapshotExpiresAt.getTime() > Date.now();
		if (
			!cleanupTransitions[cleanup] ||
			(patch.cleanupStatus !== undefined &&
				!cleanupTransitions[cleanup].includes(patch.cleanupStatus) &&
				!retryingExport)
		)
			reject();
		if (hasRemoteReceipt && patch.cleanupStatus === "NOT_REQUIRED")
			reject();
		if (
			terminal &&
			cleanup === "NOT_REQUIRED" &&
			patch.cleanupStatus &&
			patch.cleanupStatus !== "NOT_REQUIRED" &&
			!hasRemoteReceipt
		)
			reject();
		if (
			hasRemoteReceipt &&
			cleanup === "NOT_REQUIRED" &&
			patch.cleanupStatus === undefined
		)
			patch.cleanupStatus = "PENDING";
		const changed = await tx.projectContextQualityRun.updateMany({
			where: {
				...where,
				stateVersion: input.expectedStateVersion,
				status: current,
				...(patch.status &&
				![
					"CANCEL_REQUESTED",
					"CANCELLED",
					"RECONCILIATION_REQUIRED",
				].includes(patch.status)
					? { cancelRequestedAt: null }
					: {}),
			},
			data: {
				...patch,
				stateVersion: { increment: 1 },
				...(patch.status === "CANCEL_REQUESTED"
					? {
							cancelRequestedAt:
								existing.cancelRequestedAt ?? new Date(),
						}
					: {}),
			},
		});
		return {
			updated: changed.count === 1,
			run: await tx.projectContextQualityRun.findFirst({
				where,
				include: { binding: true },
			}),
		};
	});
}

export async function requestContextQualityRunCancellation(
	scope: ContextQualityRunScope,
) {
	const where = runWhere(scope);
	return withRLSContext(db, async (tx) => {
		await tx.projectContextQualityRun.updateMany({
			where: {
				...where,
				status: { notIn: [...CONTEXT_QUALITY_TERMINAL_STATUSES] },
				cancelRequestedAt: null,
			},
			data: {
				status: "CANCEL_REQUESTED",
				cancelRequestedAt: new Date(),
				stateVersion: { increment: 1 },
			},
		});
		const row = await tx.projectContextQualityRun.findFirst({
			where,
			select: summarySelect,
		});
		return row ? summarize(row) : null;
	});
}

/** Expiry scrubs local input independently of unresolved remote cleanup. */
export async function purgeContextQualityRunSnapshot(
	scope: ContextQualityRunScope & { before?: Date },
) {
	const before = scope.before ?? new Date();
	if (!validDate(before) || before > new Date())
		throw new ContextQualityStoreError("INVALID_INPUT");
	const where = runWhere(scope);
	const outcome = await withRLSContext(db, (tx) =>
		tx.projectContextQualityRun.updateMany({
			where: {
				...where,
				snapshotPayload: { not: null },
				snapshotExpiresAt: { lte: before },
			},
			data: {
				snapshotPayload: null,
				snapshotPurgedAt: new Date(),
				stateVersion: { increment: 1 },
			},
		}),
	);
	return outcome.count;
}

/** Trusted worker scan: payload-free unfinished runs and retention candidates. */
export async function findContextQualityRunsForRecovery(input: {
	before: Date;
	limit?: number;
}) {
	const limit = input.limit ?? 50;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		!validDate(input.before)
	)
		throw new ContextQualityStoreError("INVALID_INPUT");
	return db.projectContextQualityRun.findMany({
		where: {
			OR: [
				{
					status: { notIn: [...CONTEXT_QUALITY_TERMINAL_STATUSES] },
					createdAt: { lte: input.before },
				},
				{
					snapshotExpiresAt: { lte: input.before },
					OR: [
						{ snapshotPayload: { not: null } },
						{ cleanupStatus: { in: ["PENDING", "BLOCKED"] } },
					],
				},
			],
		},
		select: {
			id: true,
			organizationId: true,
			projectId: true,
			status: true,
			workflowId: true,
			cleanupStatus: true,
			snapshotExpiresAt: true,
		},
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
		take: limit,
	});
}

/** Hard-delete guard: only fully settled and remotely cleaned receipts may go. */
export async function deleteSettledContextQualityRunsInTransaction(
	tx: Prisma.TransactionClient,
	scope: ContextQualityScope,
) {
	const where = scopeWhere(scope);
	await lockProject(tx, scope);
	const pending = await tx.projectContextQualityRun.count({
		where: unresolvedRunsWhere(scope),
	});
	if (pending > 0) return { deleted: false, pending };
	await tx.projectContextQualityRun.deleteMany({ where });
	await tx.projectContextQualityBinding.deleteMany({ where });
	return { deleted: true, pending: 0 };
}
export async function deleteSettledContextQualityRunsForProject(
	scope: ContextQualityScope,
) {
	return withRLSContext(db, (tx) =>
		deleteSettledContextQualityRunsInTransaction(tx, scope),
	);
}

/** Match project purge's exact receipt guard and locks for organization purge. */
export async function deleteSettledContextQualityRunsForOrganizationInTransaction(
	tx: Prisma.TransactionClient,
	organizationId: string,
) {
	if (!validId(organizationId))
		throw new ContextQualityStoreError("INVALID_INPUT");
	const projects = await tx.project.findMany({
		where: { organizationId },
		select: { id: true },
		orderBy: { id: "asc" },
	});
	for (const project of projects) {
		const removed = await deleteSettledContextQualityRunsInTransaction(tx, {
			organizationId,
			projectId: project.id,
		});
		if (!removed.deleted)
			throw new ContextQualityStoreError("INVALID_TRANSITION");
	}
	await tx.projectContextQualityPrincipal.deleteMany({
		where: { organizationId },
	});
}
export async function listContextQualityProjectsBoundToIntegration(
	integrationId: string,
	organizationId: string,
) {
	if (!validId(integrationId) || !validId(organizationId))
		throw new ContextQualityStoreError("INVALID_INPUT");
	const bindings = await db.projectContextQualityBinding.findMany({
		where: { integrationId, organizationId },
		select: { project: { select: { id: true, name: true } } },
		take: 50,
	});
	return bindings.map(({ project }) => ({
		projectId: project.id,
		projectName: project.name,
	}));
}

/** Once terminal, no future execution needs private case/source bytes. */
export async function purgeSettledContextQualityRunSnapshot(
	scope: ContextQualityRunScope,
) {
	const where = runWhere(scope);
	const result = await withRLSContext(db, (tx) =>
		tx.projectContextQualityRun.updateMany({
			where: {
				...where,
				status: { in: [...CONTEXT_QUALITY_TERMINAL_STATUSES] },
				snapshotPayload: { not: null },
			},
			data: {
				snapshotPayload: null,
				snapshotPurgedAt: new Date(),
				stateVersion: { increment: 1 },
			},
		}),
	);
	return result.count;
}
