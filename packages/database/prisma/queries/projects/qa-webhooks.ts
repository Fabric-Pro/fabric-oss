import { db, Prisma } from "../../client";

const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ProjectQaWebhookConfiguration {
	id: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	encryptedSecret: string;
	secretHint: string;
	previousEncryptedSecret: string | null;
	previousSecretRetiresAt: Date | null;
	expiresAt: Date | null;
	lastDeliveryAt: Date | null;
	deliveryCount: number;
	lastError: string | null;
	lastErrorAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

const webhookSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	encryptedSecret: true,
	secretHint: true,
	previousEncryptedSecret: true,
	previousSecretRetiresAt: true,
	expiresAt: true,
	lastDeliveryAt: true,
	deliveryCount: true,
	lastError: true,
	lastErrorAt: true,
	createdAt: true,
	updatedAt: true,
} as const;

export async function getProjectQaWebhookConfiguration(
	projectId: string,
): Promise<ProjectQaWebhookConfiguration | null> {
	return db.projectQaWebhook.findUnique({
		where: { projectId },
		select: webhookSelect,
	});
}

/**
 * The branches this project's QA sync watches, one per connected repository.
 *
 * The scheduled sweep asks each provider only for runs on the watched branch
 * (`qaBranch`, falling back to the repository's default). A webhook cannot ask
 * for anything — the provider sends every `workflow_run` on every branch — so
 * the endpoint has to apply the same filter itself. Without it a webhook
 * delivers what the sweep would have excluded, which is both noise and a
 * contradiction of the rule the ingestion design rests on.
 *
 * Returns an empty array when the project has no connected repository. The
 * caller treats that as "cannot judge" and ingests, rather than newly dropping
 * data on a project whose wiring it cannot see.
 */
export async function getProjectQaWatchedBranches(
	projectId: string,
): Promise<string[]> {
	const rows = await db.projectRepositoryIntegration.findMany({
		where: { projectId },
		select: { qaBranch: true, defaultBranch: true },
	});
	return rows
		.map((r) => (r.qaBranch?.trim() || r.defaultBranch)?.trim())
		.filter((b): b is string => Boolean(b));
}

export async function createProjectQaWebhookConfiguration(input: {
	projectId: string;
	encryptedSecret: string;
	secretHint: string;
	expiresAt: Date | null;
}): Promise<ProjectQaWebhookConfiguration> {
	return db.$transaction(async (tx) => {
		const project = await tx.project.findUnique({
			where: { id: input.projectId },
			select: { userId: true, organizationId: true },
		});
		if (!project) {
			throw new Error("Project not found");
		}
		return tx.projectQaWebhook.create({
			data: {
				projectId: input.projectId,
				encryptedSecret: input.encryptedSecret,
				secretHint: input.secretHint,
				expiresAt: input.expiresAt,
				userId: project.organizationId ? null : project.userId,
				organizationId: project.organizationId,
			},
			select: webhookSelect,
		});
	});
}

export async function rotateProjectQaWebhookSecret(input: {
	projectId: string;
	encryptedSecret: string;
	secretHint: string;
	previousSecretRetiresAt: Date;
}): Promise<
	| { status: "rotated"; row: ProjectQaWebhookConfiguration }
	| { status: "missing" }
	| { status: "overlap_active_or_conflict" }
> {
	return db.$transaction(async (tx) => {
		const existing = await tx.projectQaWebhook.findUnique({
			where: { projectId: input.projectId },
			select: {
				encryptedSecret: true,
				previousSecretRetiresAt: true,
			},
		});
		if (!existing) {
			return { status: "missing" as const };
		}
		const now = new Date();
		if (
			existing.previousSecretRetiresAt &&
			existing.previousSecretRetiresAt > now
		) {
			return { status: "overlap_active_or_conflict" as const };
		}
		const { count } = await tx.projectQaWebhook.updateMany({
			where: {
				projectId: input.projectId,
				encryptedSecret: existing.encryptedSecret,
				OR: [
					{ previousSecretRetiresAt: null },
					{ previousSecretRetiresAt: { lte: now } },
				],
			},
			data: {
				previousEncryptedSecret: existing.encryptedSecret,
				previousSecretRetiresAt: input.previousSecretRetiresAt,
				encryptedSecret: input.encryptedSecret,
				secretHint: input.secretHint,
			},
		});
		if (count !== 1) {
			return { status: "overlap_active_or_conflict" as const };
		}
		const row = await tx.projectQaWebhook.findUniqueOrThrow({
			where: { projectId: input.projectId },
			select: webhookSelect,
		});
		return { status: "rotated" as const, row };
	});
}

export async function updateProjectQaWebhookExpiry(input: {
	projectId: string;
	expiresAt: Date | null;
}): Promise<boolean> {
	const { count } = await db.projectQaWebhook.updateMany({
		where: { projectId: input.projectId },
		data: { expiresAt: input.expiresAt },
	});
	return count > 0;
}

export async function revokeProjectQaWebhook(
	projectId: string,
): Promise<boolean> {
	const { count } = await db.projectQaWebhook.deleteMany({
		where: { projectId },
	});
	return count > 0;
}

export async function claimProjectQaWebhookDelivery(input: {
	webhookId: string;
	provider: string;
	deliveryId: string;
	bodyDigest: string;
}): Promise<boolean> {
	try {
		await db.projectQaWebhookDelivery.create({ data: input });
		return true;
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			return false;
		}
		throw error;
	}
}

export async function releaseProjectQaWebhookDelivery(input: {
	webhookId: string;
	provider: string;
	deliveryId: string;
	bodyDigest: string;
}): Promise<void> {
	await db.projectQaWebhookDelivery.deleteMany({ where: input });
}

export async function completeProjectQaWebhookDelivery(input: {
	webhookId: string;
	receivedAt: Date;
}): Promise<void> {
	await db.$transaction([
		db.projectQaWebhook.update({
			where: { id: input.webhookId },
			data: {
				lastDeliveryAt: input.receivedAt,
				deliveryCount: { increment: 1 },
				lastError: null,
				lastErrorAt: null,
			},
		}),
		db.projectQaWebhookDelivery.deleteMany({
			where: {
				webhookId: input.webhookId,
				receivedAt: {
					lt: new Date(
						input.receivedAt.getTime() - DELIVERY_RETENTION_MS,
					),
				},
			},
		}),
	]);
}

export async function recordProjectQaWebhookError(input: {
	webhookId: string;
	occurredAt: Date;
	message: string;
}): Promise<void> {
	await db.projectQaWebhook.updateMany({
		where: { id: input.webhookId },
		data: {
			lastError: input.message.slice(0, 1_000),
			lastErrorAt: input.occurredAt,
		},
	});
}
