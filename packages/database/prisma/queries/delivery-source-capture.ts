import { createHash } from "node:crypto";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { isEncryptedApiKey } from "@repo/utils";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../../src/tenant-context";
import { withRLSContext } from "../../src/tenant-db";
import { db, Prisma } from "../client";
import { recordAuditTx } from "./audit-log";
import {
	canEditProject,
	hasProjectAccess,
	resolveProjectAccess,
} from "./projects/projects";

export interface DeliverySourceScope {
	organizationId: string;
	projectId: string;
	userId: string;
}
export interface DeliverySourceProof {
	installationId: string;
	containerId: string;
	humanUserId: string;
	botId: string;
	botUserId: string;
	adapterVersion: string;
	label: string;
	verifiedAt: Date;
}
export interface DeliverySourcePageResult {
	captured: number;
	hasMore: boolean;
	coverage: "ROOT_MESSAGES_ONLY" | "PARTIAL";
}
export class DeliverySourceStoreError extends Error {
	constructor(
		readonly code:
			| "INVALID_INPUT"
			| "NOT_FOUND"
			| "INSUFFICIENT_PERMISSION"
			| "CONFIGURATION_CHANGED"
			| "IDEMPOTENCY_CONFLICT"
			| "CAPTURE_CONFLICT",
	) {
		super("Private source persistence is unavailable.");
		this.name = "DeliverySourceStoreError";
	}
}
function fail(code: DeliverySourceStoreError["code"]): never {
	throw new DeliverySourceStoreError(code);
}
const validId = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 200 &&
	value.trim() === value &&
	!/\p{Cc}/u.test(value);
const hash = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is Date =>
	value instanceof Date && Number.isFinite(value.getTime());
function scopeWhere(scope: DeliverySourceScope) {
	if (![scope.organizationId, scope.projectId, scope.userId].every(validId)) {
		fail("INVALID_INPUT");
	}
	return {
		organizationId: scope.organizationId,
		projectId: scope.projectId,
		userId: scope.userId,
	};
}
function watchWhere(scope: DeliverySourceScope, watchId: string) {
	if (!validId(watchId)) {
		fail("INVALID_INPUT");
	}
	return { id: watchId, ...scopeWhere(scope) };
}
/** Explicit target context and current rights, never an ambient guest grant or admin fallback. */
export async function requireDeliverySourceStoreAccess(
	tx: Prisma.TransactionClient,
	scope: DeliverySourceScope,
	write = false,
	network = false,
) {
	scopeWhere(scope);
	const actor = await tx.user.findUnique({
		where: { id: scope.userId },
		select: { banned: true, banExpires: true },
	});
	if (
		!actor ||
		(actor.banned === true &&
			(actor.banExpires === null || actor.banExpires > new Date()))
	) {
		fail("INSUFFICIENT_PERMISSION");
	}
	const project = await tx.project.findFirst({
		where: {
			id: scope.projectId,
			organizationId: scope.organizationId,
			deletedAt: null,
		},
		select: { id: true, organization: { select: { deletedAt: true } } },
	});
	if (
		!project ||
		project.organization?.deletedAt !== null ||
		!(await hasProjectAccess(scope.projectId, scope.userId, undefined, tx))
	) {
		fail("NOT_FOUND");
	}
	const access = await resolveProjectAccess(
		scope.projectId,
		scope.userId,
		tx,
	);
	const member = await tx.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: scope.organizationId,
				userId: scope.userId,
			},
		},
		select: { role: true },
	});
	if (
		!access ||
		access.organizationId !== scope.organizationId ||
		!member ||
		(write && !(await canEditProject(scope.projectId, scope.userId, tx))) ||
		![
			Permissions.PROJECT_READ,
			Permissions.STORY_READ,
			...(write
				? [Permissions.PROJECT_UPDATE, Permissions.STORY_UPDATE]
				: []),
		].every((permission) =>
			hasPermission(access.permissions, permission),
		) ||
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.INTEGRATION_READ,
		) ||
		(network &&
			!hasPermission(
				resolveOrgPermissions(member.role),
				Permissions.INTEGRATION_USE,
			))
	) {
		fail("INSUFFICIENT_PERMISSION");
	}
}
function transaction<T>(
	scope: DeliverySourceScope,
	write: boolean,
	work: (tx: Prisma.TransactionClient) => Promise<T>,
	network = false,
): Promise<T> {
	scopeWhere(scope);
	return runWithTenantContext(
		createOrganizationContext(scope.organizationId, scope.userId),
		() =>
			withRLSContext(
				db,
				async (tx) => {
					await requireDeliverySourceStoreAccess(
						tx,
						scope,
						write,
						network,
					);
					return work(tx);
				},
				{
					isolationLevel:
						Prisma.TransactionIsolationLevel.Serializable,
					timeout: 15_000,
				},
			),
	).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error) {
			if (error.code === "P2002") {
				fail("IDEMPOTENCY_CONFLICT");
			}
			if (error.code === "P2034") {
				fail("CAPTURE_CONFLICT");
			}
			if (error.code === "P2003") {
				fail("CONFIGURATION_CHANGED");
			}
		}
		throw error;
	});
}
async function lockWatch(
	tx: Prisma.TransactionClient,
	scope: DeliverySourceScope,
	watchId: string,
) {
	watchWhere(scope, watchId);
	await tx.$queryRaw`SELECT id FROM delivery_signal_watch WHERE id=${watchId} AND "organizationId"=${scope.organizationId} AND "projectId"=${scope.projectId} AND "userId"=${scope.userId} FOR UPDATE`;
	const watch = await tx.deliverySignalWatch.findFirst({
		where: watchWhere(scope, watchId),
	});
	if (!watch) {
		fail("NOT_FOUND");
	}
	return watch;
}
function integrationWhere(scope: DeliverySourceScope, integrationId?: string) {
	if (integrationId !== undefined && !validId(integrationId)) {
		fail("INVALID_INPUT");
	}
	return {
		...(integrationId ? { id: integrationId } : {}),
		organizationId: scope.organizationId,
		userId: scope.userId,
		provider: "SLACK" as const,
		isActive: true,
		workflowId: null,
		name: { not: "SLACK_OAUTH_APP" },
	};
}
const integrationSelect = {
	id: true,
	name: true,
	credentials: true,
	provider: true,
	userId: true,
	organizationId: true,
	isActive: true,
	updatedAt: true,
} satisfies Prisma.WorkflowIntegrationSelect;
/** Encrypted credentials are server-only; callers must explicitly minimize public projections. */
export function getOwnedDeliverySlackIntegration(
	scope: DeliverySourceScope,
	integrationId: string,
) {
	return transaction(scope, false, (tx) =>
		tx.workflowIntegration.findFirst({
			where: integrationWhere(scope, integrationId),
			select: integrationSelect,
		}),
	);
}
export function listOwnedDeliverySlackIntegrations(scope: DeliverySourceScope) {
	return transaction(scope, false, (tx) =>
		tx.workflowIntegration.findMany({
			where: integrationWhere(scope),
			select: integrationSelect,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 50,
		}),
	);
}
export function getOwnedDeliverySourceWatch(
	scope: DeliverySourceScope,
	watchId: string,
	write = false,
) {
	return transaction(scope, write, (tx) =>
		tx.deliverySignalWatch.findFirst({ where: watchWhere(scope, watchId) }),
	);
}
export function listOwnedDeliverySourceWatches(scope: DeliverySourceScope) {
	return transaction(scope, false, async (tx) => {
		const watches = await tx.deliverySignalWatch.findMany({
			where: scopeWhere(scope),
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 50,
		});
		const requests = watches.flatMap((watch) =>
			watch.lastRequestId ? [watch.lastRequestId] : [],
		);
		const commands = requests.length
			? await tx.deliverySignalSourceCommand.findMany({
					where: {
						...scopeWhere(scope),
						operation: "CAPTURE",
						requestId: { in: requests },
					},
				})
			: [];
		return watches.map((watch) => ({
			...watch,
			lastCaptureCommand:
				commands.find(
					(command) =>
						command.watchId === watch.id &&
						command.requestId === watch.lastRequestId,
				) ?? null,
		}));
	});
}
async function contextWith(
	tx: Prisma.TransactionClient,
	scope: DeliverySourceScope,
	watchId: string,
) {
	const watch = await tx.deliverySignalWatch.findFirst({
		where: {
			...watchWhere(scope, watchId),
			state: { not: "DISCONNECTED" },
		},
	});
	if (!watch || !watch.integrationId) {
		return null;
	}
	const [grant, integration] = await Promise.all([
		tx.deliverySignalSourceGrant.findFirst({
			where: {
				...scopeWhere(scope),
				watchId,
				revision: watch.grantRevision,
				revokedAt: null,
				audience: "ONLY_ME",
			},
		}),
		tx.workflowIntegration.findFirst({
			where: integrationWhere(scope, watch.integrationId),
			select: integrationSelect,
		}),
	]);
	const cancellation = watch.lastWorkflowId
		? await tx.deliverySignalSourceCommand.findFirst({
				where: {
					...scopeWhere(scope),
					watchId,
					workflowId: watch.lastWorkflowId,
					operation: "CANCEL",
				},
				select: { id: true },
			})
		: null;
	return grant && integration
		? { watch, grant, integration, cancelRequested: cancellation !== null }
		: null;
}
export function loadDeliverySourceCaptureContext(
	scope: DeliverySourceScope,
	watchId: string,
	write = false,
) {
	return transaction(
		scope,
		write,
		(tx) => contextWith(tx, scope, watchId),
		write,
	);
}
function validateCommand(input: { requestId: string; payloadHash: string }) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			input.requestId,
		) ||
		!hash(input.payloadHash)
	) {
		fail("INVALID_INPUT");
	}
}
async function existingCommand(
	tx: Prisma.TransactionClient,
	scope: DeliverySourceScope,
	requestId: string,
	payloadHash?: string,
	operation?: string,
) {
	const receipt = await tx.deliverySignalSourceCommand.findFirst({
		where: { ...scopeWhere(scope), requestId },
	});
	if (
		receipt &&
		((payloadHash && receipt.payloadHash !== payloadHash) ||
			(operation && receipt.operation !== operation))
	) {
		fail("IDEMPOTENCY_CONFLICT");
	}
	return receipt;
}
export function getOwnedDeliverySourceCommand(
	scope: DeliverySourceScope,
	requestId: string,
	write = false,
	operation?: string,
) {
	if (!validId(requestId)) {
		fail("INVALID_INPUT");
	}
	return transaction(scope, write, (tx) =>
		existingCommand(tx, scope, requestId, undefined, operation),
	);
}
export function getLastOwnedDeliverySourceCaptureCommand(
	scope: DeliverySourceScope,
	watchId: string,
) {
	return transaction(scope, false, async (tx) => {
		const watch = await tx.deliverySignalWatch.findFirst({
			where: watchWhere(scope, watchId),
		});
		return watch?.lastRequestId
			? existingCommand(
					tx,
					scope,
					watch.lastRequestId,
					undefined,
					"CAPTURE",
				)
			: null;
	});
}
function validateProof(proof: DeliverySourceProof) {
	if (
		![
			proof.installationId,
			proof.containerId,
			proof.humanUserId,
			proof.botId,
			proof.botUserId,
			proof.adapterVersion,
		].every(validId) ||
		!date(proof.verifiedAt) ||
		!proof.label ||
		proof.label.length > 200 ||
		/\p{Cc}/u.test(proof.label)
	) {
		fail("INVALID_INPUT");
	}
}
function identicalProof(
	watch: { installationId: string; containerId: string },
	grant: {
		humanUserId: string;
		botId: string;
		botUserId: string;
		adapterVersion: string;
	},
	proof: DeliverySourceProof,
) {
	return (
		watch.installationId === proof.installationId &&
		watch.containerId === proof.containerId &&
		grant.humanUserId === proof.humanUserId &&
		grant.botId === proof.botId &&
		grant.botUserId === proof.botUserId &&
		grant.adapterVersion === proof.adapterVersion
	);
}
const resetCheckpoint = {
	captureWindowStart: null,
	captureWindowEnd: null,
	captureCursorCiphertext: null,
	captureComplete: false,
	captureGrantRevision: null,
};
async function audit(
	tx: Prisma.TransactionClient,
	scope: DeliverySourceScope,
	watchId: string,
	action:
		| "configured"
		| "paused"
		| "resumed"
		| "disconnected"
		| "capture_requested"
		| "capture_cancelled",
	metadata: Record<string, string | number>,
) {
	await recordAuditTx(tx, {
		action: `project.delivery_source.${action}`,
		category: "project",
		organizationId: scope.organizationId,
		projectId: scope.projectId,
		actor: { type: "user", userId: scope.userId },
		resource: { type: "delivery_source", id: watchId },
		metadata,
	});
}
export interface ConfigureDeliverySourceInput {
	integrationId: string;
	requestId: string;
	payloadHash: string;
	retentionDays: 7 | 30;
	proof: DeliverySourceProof;
}
export function configureDeliverySourceWatch(
	scope: DeliverySourceScope,
	input: ConfigureDeliverySourceInput,
) {
	validateCommand(input);
	validateProof(input.proof);
	if (
		!validId(input.integrationId) ||
		![7, 30].includes(input.retentionDays)
	) {
		fail("INVALID_INPUT");
	}
	return transaction(
		scope,
		true,
		async (tx) => {
			// Serialize admission/counts for this owner/project, including two different source keys.
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["delivery-source", scope.organizationId, scope.projectId, scope.userId])}, 0))`;
			const previous = await existingCommand(
				tx,
				scope,
				input.requestId,
				input.payloadHash,
				"CONFIGURE",
			);
			if (previous) {
				return lockWatch(tx, scope, previous.watchId);
			}
			const integration = await tx.workflowIntegration.findFirst({
				where: integrationWhere(scope, input.integrationId),
				select: { id: true },
			});
			if (!integration) {
				fail("NOT_FOUND");
			}
			const source = {
				...scopeWhere(scope),
				provider: "SLACK",
				installationId: input.proof.installationId,
				containerId: input.proof.containerId,
			};
			const previousWatch = await tx.deliverySignalWatch.findFirst({
				where: source,
			});
			if (
				!previousWatch &&
				(await tx.deliverySignalWatch.count({
					where: scopeWhere(scope),
				})) >= 20
			) {
				fail("CAPTURE_CONFLICT");
			}
			const watch = previousWatch
				? await lockWatch(tx, scope, previousWatch.id)
				: null;
			const priorGrant = watch
				? await tx.deliverySignalSourceGrant.findFirst({
						where: {
							...scopeWhere(scope),
							watchId: watch.id,
							revision: watch.grantRevision,
						},
					})
				: null;
			const rotate =
				!watch ||
				watch.state === "DISCONNECTED" ||
				watch.integrationId !== input.integrationId ||
				watch.retentionDays !== input.retentionDays ||
				!priorGrant ||
				priorGrant.revokedAt !== null ||
				!identicalProof(watch, priorGrant, input.proof);
			const revision = watch ? watch.grantRevision + (rotate ? 1 : 0) : 1;
			if (watch && rotate) {
				await tx.deliverySignalSourceGrant.updateMany({
					where: {
						...scopeWhere(scope),
						watchId: watch.id,
						revokedAt: null,
					},
					data: { revokedAt: new Date() },
				});
				await tx.deliverySignalObservation.deleteMany({
					where: { ...scopeWhere(scope), watchId: watch.id },
				});
			}
			const data = {
				integrationId: input.integrationId,
				label: input.proof.label,
				retentionDays: input.retentionDays,
				verifiedAt: input.proof.verifiedAt,
				state: "ACTIVE",
				grantRevision: revision,
			};
			const saved = watch
				? await tx.deliverySignalWatch.update({
						where: { id: watch.id },
						data: {
							...data,
							version: { increment: 1 },
							...(rotate
								? {
										...resetCheckpoint,
										captureCheckpointVersion: {
											increment: 1,
										},
										lastWorkflowId: null,
										lastRequestId: null,
									}
								: {}),
						},
					})
				: await tx.deliverySignalWatch.create({
						data: { ...source, ...data },
					});
			if (rotate) {
				await tx.deliverySignalSourceGrant.create({
					data: {
						...scopeWhere(scope),
						watchId: saved.id,
						revision,
						audience: "ONLY_ME",
						humanUserId: input.proof.humanUserId,
						botId: input.proof.botId,
						botUserId: input.proof.botUserId,
						adapterVersion: input.proof.adapterVersion,
						verifiedAt: input.proof.verifiedAt,
					},
				});
			}
			await tx.deliverySignalSourceCommand.create({
				data: {
					...scopeWhere(scope),
					watchId: saved.id,
					requestId: input.requestId,
					operation: "CONFIGURE",
					payloadHash: input.payloadHash,
					expectedVersion: saved.version,
					grantRevision: revision,
				},
			});
			await audit(tx, scope, saved.id, "configured", {
				version: saved.version,
				grantRevision: revision,
				retentionDays: saved.retentionDays,
			});
			return saved;
		},
		true,
	);
}
export interface ChangeDeliverySourceStateInput {
	watchId: string;
	expectedVersion: number;
	requestId: string;
	payloadHash: string;
	action: "PAUSE" | "RESUME" | "DISCONNECT";
	proof?: DeliverySourceProof;
}
export function changeDeliverySourceWatchState(
	scope: DeliverySourceScope,
	input: ChangeDeliverySourceStateInput,
) {
	validateCommand(input);
	if (
		!Number.isSafeInteger(input.expectedVersion) ||
		input.expectedVersion < 1 ||
		!["PAUSE", "RESUME", "DISCONNECT"].includes(input.action)
	) {
		fail("INVALID_INPUT");
	}
	if (input.proof) {
		validateProof(input.proof);
	}
	return transaction(
		scope,
		true,
		async (tx) => {
			const watch = await lockWatch(tx, scope, input.watchId);
			const previous = await existingCommand(
				tx,
				scope,
				input.requestId,
				input.payloadHash,
				input.action,
			);
			if (previous) {
				if (previous.watchId !== watch.id) {
					fail("IDEMPOTENCY_CONFLICT");
				}
				return watch;
			}
			if (
				watch.version !== input.expectedVersion ||
				watch.state === "DISCONNECTED"
			) {
				fail("CONFIGURATION_CHANGED");
			}
			if (input.action === "RESUME") {
				const context = await contextWith(tx, scope, watch.id);
				if (
					!context ||
					!input.proof ||
					!identicalProof(watch, context.grant, input.proof)
				) {
					fail("CONFIGURATION_CHANGED");
				}
			}
			if (input.action === "DISCONNECT") {
				await tx.deliverySignalSourceGrant.updateMany({
					where: {
						...scopeWhere(scope),
						watchId: watch.id,
						revokedAt: null,
					},
					data: { revokedAt: new Date() },
				});
				await tx.deliverySignalObservation.deleteMany({
					where: { ...scopeWhere(scope), watchId: watch.id },
				});
			}
			const saved = await tx.deliverySignalWatch.update({
				where: { id: watch.id },
				data: {
					state:
						input.action === "PAUSE"
							? "PAUSED"
							: input.action === "RESUME"
								? "ACTIVE"
								: "DISCONNECTED",
					version: { increment: 1 },
					...(input.action === "RESUME"
						? { verifiedAt: input.proof?.verifiedAt }
						: {}),
					...(input.action === "DISCONNECT"
						? {
								...resetCheckpoint,
								captureCheckpointVersion: { increment: 1 },
							}
						: {}),
				},
			});
			await tx.deliverySignalSourceCommand.create({
				data: {
					...scopeWhere(scope),
					watchId: watch.id,
					requestId: input.requestId,
					payloadHash: input.payloadHash,
					operation: input.action,
					expectedVersion: input.expectedVersion,
					grantRevision: watch.grantRevision,
				},
			});
			await audit(
				tx,
				scope,
				watch.id,
				input.action === "PAUSE"
					? "paused"
					: input.action === "RESUME"
						? "resumed"
						: "disconnected",
				{ version: saved.version },
			);
			return saved;
		},
		input.action === "RESUME",
	);
}

export function getOwnedDeliverySourceCaptureCommandByWorkflowId(
	scope: DeliverySourceScope,
	input: { watchId: string; workflowId: string },
) {
	if (!validId(input.workflowId)) {
		fail("INVALID_INPUT");
	}
	return transaction(scope, false, async (tx) => {
		const watch = await tx.deliverySignalWatch.findFirst({
			where: watchWhere(scope, input.watchId),
			select: { id: true },
		});
		return watch
			? tx.deliverySignalSourceCommand.findFirst({
					where: {
						...scopeWhere(scope),
						watchId: input.watchId,
						workflowId: input.workflowId,
						operation: "CAPTURE",
					},
				})
			: null;
	});
}
export function getOwnedDeliverySourceCaptureCancellation(
	scope: DeliverySourceScope,
	input: { watchId: string; workflowId: string },
) {
	if (!validId(input.workflowId)) {
		fail("INVALID_INPUT");
	}
	return transaction(scope, false, async (tx) => {
		const watch = await tx.deliverySignalWatch.findFirst({
			where: watchWhere(scope, input.watchId),
			select: { id: true },
		});
		return watch
			? tx.deliverySignalSourceCommand.findFirst({
					where: {
						...scopeWhere(scope),
						watchId: input.watchId,
						workflowId: input.workflowId,
						operation: "CANCEL",
					},
				})
			: null;
	});
}

export interface PrepareDeliverySourceCaptureInput {
	watchId: string;
	requestId: string;
	expectedVersion: number;
	mode: "RECENT" | "CONTINUE" | "BACKFILL";
	window?: { start: string; end: string };
	payloadHash: string;
	workflowId: string;
	expectedLastRequestId: string | null;
}
/** A receipt is admission intent, not workflow state or an unbounded dispatch authorization. */
export function prepareDeliverySourceCaptureCommand(
	scope: DeliverySourceScope,
	input: PrepareDeliverySourceCaptureInput,
) {
	validateCommand(input);
	if (
		!validId(input.workflowId) ||
		!Number.isSafeInteger(input.expectedVersion) ||
		input.expectedVersion < 1 ||
		!["RECENT", "CONTINUE", "BACKFILL"].includes(input.mode) ||
		(input.mode === "BACKFILL") !== (input.window !== undefined) ||
		(input.window !== undefined &&
			(!date(new Date(input.window.start)) ||
				!date(new Date(input.window.end)) ||
				Date.parse(input.window.start) >=
					Date.parse(input.window.end) ||
				Date.parse(input.window.end) - Date.parse(input.window.start) >
					7 * 86_400_000)) ||
		(input.expectedLastRequestId !== null &&
			!validId(input.expectedLastRequestId))
	) {
		fail("INVALID_INPUT");
	}
	return transaction(
		scope,
		true,
		async (tx) => {
			const watch = await lockWatch(tx, scope, input.watchId);
			const context = await contextWith(tx, scope, watch.id);
			if (!context || watch.state !== "ACTIVE") {
				fail("CONFIGURATION_CHANGED");
			}
			const previous = await existingCommand(
				tx,
				scope,
				input.requestId,
				input.payloadHash,
				"CAPTURE",
			);
			if (previous) {
				if (
					previous.watchId !== watch.id ||
					previous.workflowId !== input.workflowId ||
					previous.expectedVersion !== input.expectedVersion ||
					previous.captureMode !== input.mode
				) {
					fail("IDEMPOTENCY_CONFLICT");
				}
				return {
					receipt: previous,
					watch,
					grant: context.grant,
					mayDispatch: false,
				};
			}
			if (watch.version !== input.expectedVersion) {
				fail("CONFIGURATION_CHANGED");
			}
			if (
				input.window &&
				(Date.parse(input.window.end) > Date.now() ||
					Date.parse(input.window.start) <
						Date.now() - 90 * 86_400_000)
			) {
				fail("INVALID_INPUT");
			}
			// The caller independently proves the previous native execution is terminal.
			// This comparison prevents two callers racing from replacing that same identity.
			if (watch.lastRequestId !== input.expectedLastRequestId) {
				fail("CAPTURE_CONFLICT");
			}
			if (
				input.mode === "CONTINUE" &&
				(!watch.captureWindowStart ||
					!watch.captureWindowEnd ||
					watch.captureComplete ||
					!watch.captureCursorCiphertext ||
					watch.captureGrantRevision !== watch.grantRevision)
			) {
				fail("CONFIGURATION_CHANGED");
			}
			const saved = await tx.deliverySignalWatch.update({
				where: { id: watch.id },
				data: {
					lastWorkflowId: input.workflowId,
					lastRequestId: input.requestId,
					...(input.mode !== "CONTINUE"
						? {
								...resetCheckpoint,
								captureCheckpointVersion: { increment: 1 },
							}
						: {}),
				},
			});
			const receipt = await tx.deliverySignalSourceCommand.create({
				data: {
					...scopeWhere(scope),
					watchId: watch.id,
					requestId: input.requestId,
					operation: "CAPTURE",
					payloadHash: input.payloadHash,
					workflowId: input.workflowId,
					expectedVersion: input.expectedVersion,
					grantRevision: watch.grantRevision,
					captureMode: input.mode,
					captureWindowStart: input.window
						? new Date(input.window.start)
						: null,
					captureWindowEnd: input.window
						? new Date(input.window.end)
						: null,
				},
			});
			await audit(tx, scope, watch.id, "capture_requested", {
				version: watch.version,
				grantRevision: watch.grantRevision,
				mode: input.mode,
			});
			return {
				receipt,
				watch: saved,
				grant: context.grant,
				mayDispatch: true,
			};
		},
		true,
	);
}
export function prepareDeliverySourceCancelCommand(
	scope: DeliverySourceScope,
	input: {
		watchId: string;
		requestId: string;
		payloadHash: string;
		workflowId: string;
	},
) {
	validateCommand(input);
	if (!validId(input.workflowId)) {
		fail("INVALID_INPUT");
	}
	return transaction(scope, true, async (tx) => {
		const watch = await lockWatch(tx, scope, input.watchId);
		const previous = await existingCommand(
			tx,
			scope,
			input.requestId,
			input.payloadHash,
			"CANCEL",
		);
		if (previous) {
			if (
				previous.watchId !== watch.id ||
				previous.workflowId !== input.workflowId
			) {
				fail("IDEMPOTENCY_CONFLICT");
			}
			return { receipt: previous, watch, mayDispatch: false };
		}
		if (watch.lastWorkflowId !== input.workflowId) {
			fail("CAPTURE_CONFLICT");
		}
		const capture = await tx.deliverySignalSourceCommand.findFirst({
			where: {
				...scopeWhere(scope),
				watchId: watch.id,
				workflowId: input.workflowId,
				operation: "CAPTURE",
			},
		});
		if (!capture) {
			fail("NOT_FOUND");
		}
		const receipt = await tx.deliverySignalSourceCommand.create({
			data: {
				...scopeWhere(scope),
				watchId: watch.id,
				requestId: input.requestId,
				operation: "CANCEL",
				payloadHash: input.payloadHash,
				workflowId: input.workflowId,
				expectedVersion: capture.expectedVersion,
				grantRevision: capture.grantRevision,
			},
		});
		await audit(tx, scope, watch.id, "capture_cancelled", {
			version: watch.version,
		});
		return { receipt, watch, mayDispatch: true };
	});
}

interface PageIdentity {
	watchId: string;
	workflowId: string;
	pageIndex: number;
}
function validatePageIdentity(input: PageIdentity) {
	if (
		!validId(input.watchId) ||
		!validId(input.workflowId) ||
		!Number.isSafeInteger(input.pageIndex) ||
		input.pageIndex < 0 ||
		input.pageIndex > 4
	) {
		fail("INVALID_INPUT");
	}
}
function pageResult(value: Prisma.JsonValue): DeliverySourcePageResult {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 3 ||
		!Number.isSafeInteger(value.captured) ||
		(value.captured as number) < 0 ||
		(value.captured as number) > 200 ||
		typeof value.hasMore !== "boolean" ||
		!["ROOT_MESSAGES_ONLY", "PARTIAL"].includes(value.coverage as string)
	) {
		fail("INVALID_INPUT");
	}
	return {
		captured: value.captured as number,
		hasMore: value.hasMore,
		coverage: value.coverage as DeliverySourcePageResult["coverage"],
	};
}
export function getDeliverySourcePageReceipt(
	scope: DeliverySourceScope,
	input: PageIdentity,
): Promise<DeliverySourcePageResult | null> {
	validatePageIdentity(input);
	return transaction(scope, false, async (tx) => {
		const context = await contextWith(tx, scope, input.watchId);
		if (!context || context.watch.lastWorkflowId !== input.workflowId) {
			fail("CONFIGURATION_CHANGED");
		}
		const receipt = await tx.deliverySignalCapturePage.findFirst({
			where: { ...scopeWhere(scope), ...input },
		});
		return receipt ? pageResult(receipt.result) : null;
	});
}
export interface DeliverySourceCapturedObservation {
	id: string;
	externalItemId: string;
	revisionKind: string;
	revisionValue: string;
	receiptKey: string;
	variantKey: string;
	evidenceDigest: string;
	ciphertext: string;
	occurredAt: Date;
	expiresAt: Date;
	hasReplies: boolean;
}
export interface CommitDeliverySourceCapturePageInput extends PageIdentity {
	configVersion: number;
	grantRevision: number;
	expectedCheckpointVersion: number;
	expectedCredentialDigest: string;
	expectedIntegrationUpdatedAt: Date;
	windowStart: Date;
	windowEnd: Date;
	cursorCiphertext: string | null;
	complete: boolean;
	coverage: DeliverySourcePageResult["coverage"];
	observations: DeliverySourceCapturedObservation[];
	result: DeliverySourcePageResult;
}
/** Receipt, immutable variants and checkpoint advance are one serialized transaction. */
export function commitDeliverySourceCapturePage(
	scope: DeliverySourceScope,
	input: CommitDeliverySourceCapturePageInput,
): Promise<DeliverySourcePageResult> {
	validatePageIdentity(input);
	const result = pageResult(input.result as unknown as Prisma.JsonValue);
	if (
		!Number.isSafeInteger(input.configVersion) ||
		input.configVersion < 1 ||
		!Number.isSafeInteger(input.grantRevision) ||
		input.grantRevision < 1 ||
		!Number.isSafeInteger(input.expectedCheckpointVersion) ||
		input.expectedCheckpointVersion < 0 ||
		!hash(input.expectedCredentialDigest) ||
		!date(input.expectedIntegrationUpdatedAt) ||
		!date(input.windowStart) ||
		!date(input.windowEnd) ||
		input.windowStart >= input.windowEnd ||
		input.windowEnd.getTime() - input.windowStart.getTime() >
			7 * 86_400_000 ||
		input.complete !== !result.hasMore ||
		input.coverage !== result.coverage ||
		!Array.isArray(input.observations) ||
		input.observations.length > 200 ||
		result.captured !== input.observations.length ||
		(input.cursorCiphertext !== null &&
			(!isEncryptedApiKey(input.cursorCiphertext) ||
				input.cursorCiphertext.length > 16_384)) ||
		(result.hasMore && input.cursorCiphertext === null) ||
		(!result.hasMore && input.cursorCiphertext !== null)
	) {
		fail("INVALID_INPUT");
	}
	for (const item of input.observations) {
		if (
			![item.id, item.externalItemId].every(validId) ||
			!["INTEGER", "DECIMAL", "UTC_TIME", "OPAQUE"].includes(
				item.revisionKind,
			) ||
			typeof item.revisionValue !== "string" ||
			!item.revisionValue ||
			item.revisionValue.length > 512 ||
			/\p{Cc}/u.test(item.revisionValue) ||
			![item.receiptKey, item.variantKey, item.evidenceDigest].every(
				hash,
			) ||
			!isEncryptedApiKey(item.ciphertext) ||
			item.ciphertext.length > 262_144 ||
			!date(item.occurredAt) ||
			item.occurredAt < input.windowStart ||
			item.occurredAt > input.windowEnd ||
			!date(item.expiresAt) ||
			typeof item.hasReplies !== "boolean"
		) {
			fail("INVALID_INPUT");
		}
		const expectedVariant = createHash("sha256")
			.update(
				JSON.stringify([
					1,
					item.receiptKey,
					"UPSERT",
					item.evidenceDigest,
				]),
			)
			.digest("hex");
		if (item.variantKey !== expectedVariant) {
			fail("INVALID_INPUT");
		}
	}
	return transaction(
		scope,
		true,
		async (tx) => {
			const watch = await lockWatch(tx, scope, input.watchId);
			const context = await contextWith(tx, scope, watch.id);
			if (
				!context ||
				watch.state !== "ACTIVE" ||
				watch.version !== input.configVersion ||
				watch.grantRevision !== input.grantRevision ||
				context.grant.revision !== input.grantRevision ||
				watch.lastWorkflowId !== input.workflowId
			) {
				fail("CONFIGURATION_CHANGED");
			}
			const existing = await tx.deliverySignalCapturePage.findFirst({
				where: {
					...scopeWhere(scope),
					watchId: watch.id,
					workflowId: input.workflowId,
					pageIndex: input.pageIndex,
				},
			});
			if (existing) {
				return pageResult(existing.result);
			}
			if (
				await tx.deliverySignalSourceCommand.findFirst({
					where: {
						...scopeWhere(scope),
						watchId: watch.id,
						workflowId: input.workflowId,
						operation: "CANCEL",
					},
					select: { id: true },
				})
			) {
				fail("CONFIGURATION_CHANGED");
			}
			const admission = await tx.deliverySignalSourceCommand.findFirst({
				where: {
					...scopeWhere(scope),
					watchId: watch.id,
					workflowId: input.workflowId,
					operation: "CAPTURE",
				},
			});
			if (
				admission?.captureMode === "BACKFILL" &&
				(admission.captureWindowStart?.getTime() !==
					input.windowStart.getTime() ||
					admission.captureWindowEnd?.getTime() !==
						input.windowEnd.getTime())
			) {
				fail("CONFIGURATION_CHANGED");
			}
			await tx.$queryRaw`SELECT id FROM workflow_integration WHERE id=${watch.integrationId} AND "organizationId"=${scope.organizationId} AND "userId"=${scope.userId} AND provider::text='SLACK' AND "isActive" AND "workflowId" IS NULL AND name<>'SLACK_OAUTH_APP' FOR SHARE`;
			const integration = watch.integrationId
				? await tx.workflowIntegration.findFirst({
						where: integrationWhere(scope, watch.integrationId),
						select: integrationSelect,
					})
				: null;
			if (
				!integration ||
				integration.updatedAt.getTime() !==
					input.expectedIntegrationUpdatedAt.getTime() ||
				createHash("sha256")
					.update(integration.credentials)
					.digest("hex") !== input.expectedCredentialDigest
			) {
				fail("CONFIGURATION_CHANGED");
			}
			if (
				watch.captureCheckpointVersion !==
				input.expectedCheckpointVersion
			) {
				fail("CAPTURE_CONFLICT");
			}
			const now = new Date();
			if (
				input.observations.some(
					(item) =>
						item.expiresAt <= now ||
						item.expiresAt.getTime() >
							now.getTime() + watch.retentionDays * 86_400_000,
				)
			) {
				fail("INVALID_INPUT");
			}
			const priorPage =
				input.pageIndex > 0
					? await tx.deliverySignalCapturePage.findFirst({
							where: {
								...scopeWhere(scope),
								watchId: watch.id,
								workflowId: input.workflowId,
								pageIndex: input.pageIndex - 1,
							},
							select: { id: true },
						})
					: null;
			if (input.pageIndex > 0 && !priorPage) {
				fail("CAPTURE_CONFLICT");
			}
			if (
				watch.captureWindowStart &&
				(watch.captureWindowStart.getTime() !==
					input.windowStart.getTime() ||
					watch.captureWindowEnd?.getTime() !==
						input.windowEnd.getTime() ||
					watch.captureGrantRevision !== input.grantRevision)
			) {
				fail("CONFIGURATION_CHANGED");
			}
			let captured = 0;
			if (input.observations.length) {
				const inserted = await tx.deliverySignalObservation.createMany({
					data: input.observations.map((item) => ({
						...item,
						...scopeWhere(scope),
						watchId: watch.id,
						grantId: context.grant.id,
					})),
					skipDuplicates: true,
				});
				captured = inserted.count;
			}
			const savedResult = { ...result, captured };
			await tx.deliverySignalWatch.update({
				where: { id: watch.id },
				data: {
					captureWindowStart: input.windowStart,
					captureWindowEnd: input.windowEnd,
					captureCursorCiphertext: input.cursorCiphertext,
					captureComplete: input.complete,
					captureGrantRevision: input.grantRevision,
					captureCheckpointVersion: { increment: 1 },
				},
			});
			await tx.deliverySignalCapturePage.create({
				data: {
					...scopeWhere(scope),
					watchId: watch.id,
					workflowId: input.workflowId,
					pageIndex: input.pageIndex,
					result: { ...savedResult },
				},
			});
			return savedResult;
		},
		true,
	);
}

async function observationWhere(
	tx: Prisma.TransactionClient,
	scope: DeliverySourceScope,
	watchId: string,
	now: Date,
) {
	const context = await contextWith(tx, scope, watchId);
	if (!context) {
		fail("NOT_FOUND");
	}
	return {
		...scopeWhere(scope),
		watchId,
		grantId: context.grant.id,
		expiresAt: { gt: now },
		ciphertext: { not: null },
	};
}
export function listOwnedDeliverySourceObservations(
	scope: DeliverySourceScope,
	input: {
		watchId: string;
		limit: number;
		cursor?: { id: string; capturedAt: Date };
	},
) {
	if (
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 50 ||
		(input.cursor &&
			(!validId(input.cursor.id) || !date(input.cursor.capturedAt)))
	) {
		fail("INVALID_INPUT");
	}
	return transaction(scope, false, async (tx) => {
		const where = await observationWhere(
			tx,
			scope,
			input.watchId,
			new Date(),
		);
		if (
			input.cursor &&
			!(await tx.deliverySignalObservation.findFirst({
				where: {
					...where,
					id: input.cursor.id,
					createdAt: input.cursor.capturedAt,
				},
				select: { id: true },
			}))
		) {
			fail("INVALID_INPUT");
		}
		const rows = await tx.deliverySignalObservation.findMany({
			where: {
				...where,
				...(input.cursor
					? {
							OR: [
								{ createdAt: { lt: input.cursor.capturedAt } },
								{
									createdAt: input.cursor.capturedAt,
									id: { lt: input.cursor.id },
								},
							],
						}
					: {}),
			},
			select: {
				id: true,
				receiptKey: true,
				createdAt: true,
				expiresAt: true,
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: input.limit + 1,
		});
		const visible = rows.slice(0, input.limit);
		const variants = visible.length
			? await tx.deliverySignalObservation.groupBy({
					by: ["receiptKey"],
					where: {
						...where,
						receiptKey: {
							in: visible.map((row) => row.receiptKey),
						},
					},
					_count: { _all: true },
				})
			: [];
		return {
			items: visible.map((row) => ({
				id: row.id,
				capturedAt: row.createdAt,
				expiresAt: row.expiresAt,
				change: "UPSERT" as const,
				hasConflict:
					(variants.find((item) => item.receiptKey === row.receiptKey)
						?._count._all ?? 0) > 1,
				coverage: "ROOT_MESSAGES_ONLY" as const,
			})),
			hasMore: rows.length > input.limit,
		};
	});
}
export function getOwnedDeliverySourceObservation(
	scope: DeliverySourceScope,
	input: { watchId: string; observationId: string },
) {
	if (!validId(input.observationId)) {
		fail("INVALID_INPUT");
	}
	return transaction(scope, false, async (tx) => {
		const where = await observationWhere(
			tx,
			scope,
			input.watchId,
			new Date(),
		);
		const row = await tx.deliverySignalObservation.findFirst({
			where: { ...where, id: input.observationId },
		});
		if (!row) {
			return null;
		}
		const variants = await tx.deliverySignalObservation.count({
			where: { ...where, receiptKey: row.receiptKey },
		});
		return {
			...row,
			capturedAt: row.createdAt,
			change: "UPSERT" as const,
			coverage: "ROOT_MESSAGES_ONLY" as const,
			hasConflict: variants > 1,
		};
	});
}
/** Read-only actual connection identity check; never infers worker authority from a configured label. */
export async function isDeliverySourceRetentionWorkerQualified(
	connection: Pick<Prisma.TransactionClient, "$queryRaw"> = db,
): Promise<boolean> {
	const workers = await connection.$queryRaw<Array<{ allowed: boolean }>>`
			 SELECT current_user='fabric_worker' AND to_regclass('public.delivery_signal_observation') IS NOT NULL AND (r.rolbypassrls OR r.rolsuper OR EXISTS (
			  SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('public.delivery_signal_observation')
			   AND p.polname='worker_bypass' AND p.polcmd='*' AND p.polpermissive
			   AND r.oid=ANY(p.polroles) AND pg_get_expr(p.polqual,p.polrelid)='true'
			   AND pg_get_expr(p.polwithcheck,p.polrelid)='true'
			 )) AS allowed FROM pg_roles r WHERE r.rolname=current_user`;
	return workers[0]?.allowed === true;
}

/** Worker-only bounded retention maintenance. API readers enforce expiry before this runs. */
export async function purgeExpiredDeliverySourceObservations(input: {
	batchSize: number;
}): Promise<number> {
	if (
		!Number.isSafeInteger(input.batchSize) ||
		input.batchSize < 1 ||
		input.batchSize > 500
	) {
		fail("INVALID_INPUT");
	}
	return db.$transaction(
		async (tx) => {
			if (!(await isDeliverySourceRetentionWorkerQualified(tx))) {
				fail("INSUFFICIENT_PERMISSION");
			}
			const rows = await tx.$queryRaw<
				Array<{ id: string }>
			>`SELECT id FROM delivery_signal_observation WHERE "expiresAt" <= clock_timestamp() ORDER BY "expiresAt", id LIMIT ${input.batchSize} FOR UPDATE SKIP LOCKED`;
			if (!rows.length) {
				return 0;
			}
			const result = await tx.deliverySignalObservation.deleteMany({
				where: {
					id: { in: rows.map((row) => row.id) },
					expiresAt: { lte: new Date() },
				},
			});
			return result.count;
		},
		{ timeout: 15_000 },
	);
}
