/**
 * Success metrics (plan Slice 8) — authorization and secret handling.
 *
 *  1. Each procedure declares the expected project permission; rotate is
 *     governance-only and the real middleware denies an EDITOR (FORBIDDEN).
 *  2. Creating a WEBHOOK metric returns the plaintext secret exactly once and
 *     stores only its sha256; the DTO never carries the hash.
 *  3. recordObservation shifts lastValue → previousValue.
 *
 * Run with: pnpm --filter @repo/api test modules/projects/procedures/__tests__/metrics.test.ts
 */
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	declaredPermissions: [] as string[],
	db: {
		project: { findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
		member: { findFirst: vi.fn() },
		projectSuccessMetric: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			updateMany: vi.fn(),
			deleteMany: vi.fn(),
		},
	},
	grantProjectAccess: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: mocks.db,
	grantProjectAccess: mocks.grantProjectAccess,
}));

vi.mock("../../../../orpc/procedures", () => {
	let idx = 0;
	const names = [
		"list",
		"create",
		"update",
		"delete",
		"recordObservation",
		"rotate",
	];
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.handlers[names[idx] ?? `handler_${idx}`] = fn;
			idx++;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: (permission: string) => {
			mocks.declaredPermissions.push(permission);
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

import "../metrics/list";
import "../metrics/create";
import "../metrics/update";
import "../metrics/delete";
import "../metrics/record-observation";
import "../metrics/rotate-webhook-secret";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const ORG_PROJECT = {
	id: PROJECT_ID,
	userId: "user-owner",
	organizationId: ORG_ID,
};

const metricRow = {
	id: "metric-1",
	projectId: PROJECT_ID,
	name: "Activation rate",
	description: null,
	direction: "UP" as const,
	target: 50,
	sourceKind: "WEBHOOK" as const,
	webhookSecretHash: "deadbeef",
	lastValue: 41,
	previousValue: 38,
	lastObservedAt: new Date("2026-09-01T00:00:00Z"),
	createdAt: new Date("2026-08-01T00:00:00Z"),
	updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const context = {
	user: { id: "user-editor", name: "Editor", email: "editor@example.com" },
	session: { activeOrganizationId: ORG_ID },
};

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

beforeEach(() => {
	for (const model of Object.values(mocks.db)) {
		for (const fn of Object.values(model)) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.grantProjectAccess.mockReset();
	mocks.db.project.findUnique.mockResolvedValue(ORG_PROJECT);
});

describe("metrics procedures declare their permissions", () => {
	it("list=PROJECT_READ, create/update/delete/recordObservation=PROJECT_UPDATE, rotate=PROJECT_GOVERNANCE_MANAGE", () => {
		expect(mocks.declaredPermissions).toEqual([
			"PROJECT_READ",
			"PROJECT_UPDATE",
			"PROJECT_UPDATE",
			"PROJECT_UPDATE",
			"PROJECT_UPDATE",
			"PROJECT_GOVERNANCE_MANAGE",
		]);
	});
});

describe("create", () => {
	it("returns a WEBHOOK secret once and stores only its sha256", async () => {
		mocks.db.projectSuccessMetric.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				...metricRow,
				...data,
				id: "metric-new",
			}),
		);

		const result = (await mocks.handlers.create({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				name: "Activation rate",
				direction: "UP",
				target: 50,
				sourceKind: "WEBHOOK",
			},
			context,
		})) as {
			metric: Record<string, unknown>;
			webhookSecret?: { value: string; shownOnce: true };
		};

		expect(result.webhookSecret).toBeDefined();
		expect(result.webhookSecret?.shownOnce).toBe(true);
		const secret = result.webhookSecret?.value ?? "";
		expect(secret.length).toBeGreaterThanOrEqual(40);

		const createArgs = mocks.db.projectSuccessMetric.create.mock
			.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(createArgs.data.webhookSecretHash).toBe(sha256(secret));
		expect(createArgs.data.webhookSecretHash).not.toBe(secret);
		// Tenant identity: org project → actor + org id.
		expect(createArgs.data).toMatchObject({
			projectId: PROJECT_ID,
			userId: "user-editor",
			organizationId: ORG_ID,
		});

		// The DTO never exposes the hash, only that a secret exists.
		expect(result.metric).not.toHaveProperty("webhookSecretHash");
		expect(result.metric.hasWebhookSecret).toBe(true);
		expect(JSON.stringify(result.metric)).not.toContain(sha256(secret));
	});

	it("MANUAL metrics get no secret and a null hash", async () => {
		mocks.db.projectSuccessMetric.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				...metricRow,
				...data,
				sourceKind: "MANUAL",
				webhookSecretHash: null,
			}),
		);
		const result = (await mocks.handlers.create({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				name: "NPS",
				direction: "UP",
				sourceKind: "MANUAL",
			},
			context,
		})) as { metric: Record<string, unknown>; webhookSecret?: unknown };
		expect(result.webhookSecret).toBeUndefined();
		expect(
			(
				mocks.db.projectSuccessMetric.create.mock.calls[0]?.[0] as {
					data: Record<string, unknown>;
				}
			).data.webhookSecretHash,
		).toBeNull();
		expect(result.metric.hasWebhookSecret).toBe(false);
	});

	it("personal project rows carry the owner and organizationId null", async () => {
		mocks.db.project.findUnique.mockResolvedValue({
			id: PROJECT_ID,
			userId: "user-owner",
			organizationId: null,
		});
		mocks.db.projectSuccessMetric.create.mockResolvedValue({
			...metricRow,
			sourceKind: "MANUAL",
			webhookSecretHash: null,
		});
		await mocks.handlers.create({
			input: {
				projectId: PROJECT_ID,
				name: "NPS",
				direction: "UP",
				sourceKind: "MANUAL",
			},
			context,
		});
		expect(
			(
				mocks.db.projectSuccessMetric.create.mock.calls[0]?.[0] as {
					data: Record<string, unknown>;
				}
			).data,
		).toMatchObject({ userId: "user-owner", organizationId: null });
	});
});

describe("recordObservation", () => {
	it("shifts lastValue into previousValue and stores the new value", async () => {
		mocks.db.projectSuccessMetric.findFirst
			.mockResolvedValueOnce(metricRow)
			.mockResolvedValueOnce({
				...metricRow,
				lastValue: 33,
				previousValue: 41,
			});
		mocks.db.projectSuccessMetric.updateMany.mockResolvedValue({
			count: 1,
		});
		const observedAt = new Date("2026-09-10T00:00:00Z");

		const result = (await mocks.handlers.recordObservation({
			input: {
				projectId: PROJECT_ID,
				metricId: "metric-1",
				organizationId: ORG_ID,
				value: 33,
				observedAt,
			},
			context,
		})) as { metric: { lastValue: number; previousValue: number } };

		expect(mocks.db.projectSuccessMetric.updateMany).toHaveBeenCalledWith({
			where: {
				id: "metric-1",
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			},
			data: {
				previousValue: 41,
				lastValue: 33,
				lastObservedAt: observedAt,
			},
		});
		expect(result.metric.lastValue).toBe(33);
		expect(result.metric.previousValue).toBe(41);
	});

	it("rejects a metric outside the project's tenant scope with NOT_FOUND", async () => {
		mocks.db.projectSuccessMetric.findFirst.mockResolvedValue(null);
		await expect(
			mocks.handlers.recordObservation({
				input: {
					projectId: PROJECT_ID,
					metricId: "other",
					organizationId: ORG_ID,
					value: 1,
				},
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.db.projectSuccessMetric.updateMany).not.toHaveBeenCalled();
	});
});

describe("rotateWebhookSecret", () => {
	it("replaces the hash and returns a fresh secret once", async () => {
		mocks.db.projectSuccessMetric.findFirst
			.mockResolvedValueOnce(metricRow)
			.mockResolvedValueOnce({
				...metricRow,
				webhookSecretHash: "rotated",
			});
		mocks.db.projectSuccessMetric.updateMany.mockResolvedValue({
			count: 1,
		});

		const result = (await mocks.handlers.rotate({
			input: {
				projectId: PROJECT_ID,
				metricId: "metric-1",
				organizationId: ORG_ID,
			},
			context,
		})) as { webhookSecret: { value: string; shownOnce: true } };

		const updateArgs = mocks.db.projectSuccessMetric.updateMany.mock
			.calls[0]?.[0] as {
			data: { webhookSecretHash: string };
		};
		expect(updateArgs.data.webhookSecretHash).toBe(
			sha256(result.webhookSecret.value),
		);
		expect(updateArgs.data.webhookSecretHash).not.toBe("deadbeef");
	});

	it("refuses to rotate a MANUAL metric", async () => {
		mocks.db.projectSuccessMetric.findFirst.mockResolvedValue({
			...metricRow,
			sourceKind: "MANUAL",
			webhookSecretHash: null,
		});
		await expect(
			mocks.handlers.rotate({
				input: {
					projectId: PROJECT_ID,
					metricId: "metric-1",
					organizationId: ORG_ID,
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("requireProjectPermission(PROJECT_GOVERNANCE_MANAGE) — real middleware", () => {
	async function invoke(role: "EDITOR" | "PROJECT_ADMIN" | "OWNER") {
		const { requireProjectPermission } = await import(
			"../../../../orpc/middleware/require-permission"
		);
		mocks.db.project.findUnique.mockResolvedValue(ORG_PROJECT);
		mocks.db.member.findFirst.mockResolvedValue(null);
		mocks.db.projectMember.findUnique.mockResolvedValue({
			role,
			acceptedAt: new Date(),
			expiresAt: null,
		});
		const mw = requireProjectPermission(
			Permissions.PROJECT_GOVERNANCE_MANAGE,
		);
		const next = vi.fn().mockResolvedValue({ output: "ok" });
		const ctx = {
			user: { id: "user-member" },
			tenantContext: {
				userId: "user-member",
				type: "organization" as const,
				organizationId: ORG_ID,
			},
			activeOrganizationRole: null,
			allowedProjectIds: [] as string[],
		};
		const run = (
			mw as unknown as (
				arg: { context: typeof ctx; next: typeof next },
				input: unknown,
			) => Promise<unknown>
		)(
			{ context: ctx, next },
			{ projectId: PROJECT_ID, metricId: "metric-1" },
		);
		return { run, next };
	}

	it("denies an EDITOR with FORBIDDEN before the rotate handler runs", async () => {
		const { run, next } = await invoke("EDITOR");
		await expect(run).rejects.toThrow(
			/FORBIDDEN|Missing required permission/,
		);
		const error = await run.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ORPCError);
		expect(next).not.toHaveBeenCalled();
		expect(mocks.db.projectSuccessMetric.updateMany).not.toHaveBeenCalled();
	});

	it("denies a PROJECT_ADMIN too (governance is owner / org admin only)", async () => {
		const { run, next } = await invoke("PROJECT_ADMIN");
		await expect(run).rejects.toThrow(
			/FORBIDDEN|Missing required permission/,
		);
		expect(next).not.toHaveBeenCalled();
	});
});
