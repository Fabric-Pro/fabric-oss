import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, approvals, member, actor, calls, db } = await vi.hoisted(
	async () => {
		const { createWorkflowIntegrationStore } = await import(
			"../../integrations/__tests__/procedures/workflow-integration-store"
		);
		const store = createWorkflowIntegrationStore();
		const approvals: Array<Record<string, any>> = [];
		const member = vi.fn(
			async (_args?: any) =>
				({ id: "membership-example" }) as { id: string } | null,
		);
		const actor = { userId: "requester", organizationId: "org-example" };
		const calls: string[] = [];
		const db = {
			workflowIntegration: store.delegate,
			member: { findFirst: member },
			integrationApproval: {
				findMany: vi.fn(
					async ({ where, orderBy, take, cursor, skip = 0 }: any) => {
						const ordering = Array.isArray(orderBy)
							? orderBy
							: [orderBy];
						const ordered = approvals
							.filter((row) =>
								Object.entries(where).every(
									([key, value]) =>
										value === undefined ||
										row[key] === value,
								),
							)
							.sort((left, right) => {
								for (const clause of ordering) {
									const [key, direction] =
										Object.entries(clause)[0];
									const a =
										left[key] instanceof Date
											? left[key].getTime()
											: left[key];
									const b =
										right[key] instanceof Date
											? right[key].getTime()
											: right[key];
									if (a !== b) {
										return (
											(a < b ? -1 : 1) *
											(direction === "desc" ? -1 : 1)
										);
									}
								}
								return 0;
							});
						const anchor = cursor
							? ordered.findIndex((row) => row.id === cursor.id)
							: 0;
						if (anchor < 0) {
							return [];
						}
						return ordered
							.slice(
								anchor + skip,
								take === undefined
									? undefined
									: anchor + skip + take,
							)
							.map((row) => ({ ...row }));
					},
				),

				create: async ({ data }: any) => {
					const row = {
						id: `approval-${approvals.length}`,
						status: "pending",
						createdAt: new Date(),
						...data,
					};
					approvals.push(row);
					return { ...row };
				},
				findFirst: async ({ where }: any) =>
					approvals.find((row) =>
						Object.entries(where).every(
							([key, value]) =>
								value === undefined || row[key] === value,
						),
					) ?? null,
				findUnique: async ({ where }: any) => {
					const row = approvals.find((row) => row.id === where.id);
					return row ? { ...row } : null;
				},
				update: async ({ where, data }: any) => {
					const row = approvals.find((row) => row.id === where.id);
					if (!row) {
						throw new Error("missing");
					}
					Object.assign(row, data);
					return { ...row };
				},
			},
		};
		return { store, approvals, member, actor, calls, db };
	},
);
vi.mock("@repo/database/prisma/client", () => ({ db }));
vi.mock("@repo/database", async () => ({
	db,
	...(await import(
		"@repo/database/prisma/queries/workflows/integration-access"
	)),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
}));
vi.mock("../helpers", () => ({
	resolveV1Context: async () => ({ ...actor }),
	ok: (data: unknown) => ({ data }),
	badRequest: (message: string) => ({ error: { message } }),
	notFound: (message: string) => ({ error: { message } }),
}));
vi.mock("@fabricorg/integrations-gmail", async () => {
	const { defineIntegration, endpoint } = await import(
		"@fabricorg/integrations-runtime"
	);
	const execute = async (ctx: any) => {
		calls.push(ctx.credentials.access_token);
		return { used: ctx.credentials.access_token };
	};
	return {
		gmailPlugin: defineIntegration({
			slug: "gmail",
			name: "Gmail",
			endpoints: {
				read: endpoint(execute, {
					riskLevel: "read",
					description: "Read",
				}),
				destroy: endpoint(execute, {
					riskLevel: "destructive",
					description: "Delete",
				}),
			},
			permissions: { mode: "cautious" },
		}),
	};
});

import { registerIntegrationRoutes } from "../integrations";

function seed(
	id: string,
	userId: string,
	usageScope: "OWNER_ONLY" | "ORGANIZATION_SHARED" = "OWNER_ONLY",
	organizationId = "org-example",
) {
	store.rows.push({
		id,
		userId,
		organizationId,
		provider: "GMAIL",
		name: "Gmail",
		isActive: true,
		usageScope,
		credentials: JSON.stringify({ access_token: `${id}-token` }),
	});
}
function app() {
	const app = new Hono();
	registerIntegrationRoutes(app as never);
	return app;
}
function post(path: string) {
	return app().request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
}
beforeEach(() => {
	store.reset();
	db.integrationApproval.findMany.mockClear();
	approvals.length = 0;
	calls.length = 0;
	actor.userId = "requester";
	member.mockReset().mockResolvedValue({ id: "member-example" });
});
describe("v1 connection identity", () => {
	it("does not execute or advertise another member's private Gmail grant", async () => {
		seed("private", "teammate");
		expect((await post("/integrations/gmail/read")).status).toBe(404);
		const body = await (await app().request("/integrations")).json();
		expect(body.data).toEqual([]);
		expect(calls).toEqual([]);
	});
	it("keeps the original actor and selected connection during approval even if the approver has another connection", async () => {
		seed("teammate", "teammate");
		seed("requester-connection", "requester", "ORGANIZATION_SHARED");
		const pending = await (
			await post("/integrations/gmail/destroy")
		).json();
		expect(approvals[0]).toMatchObject({
			userId: "requester",
			integrationId: "requester-connection",
		});
		actor.userId = "approver";
		seed("approver-connection", "approver");
		expect(
			(
				await post(
					`/integrations/approvals/${pending.data.approvalId}/approve`,
				)
			).status,
		).toBe(200);
		expect(calls).toEqual(["requester-connection-token"]);
	});
	it.each(["approve", "list", "deny"])(
		"forbids teammate %s of a private connection request without side effects",
		async (operation) => {
			seed("private-requester", "requester");
			const pending = await (
				await post("/integrations/gmail/destroy")
			).json();
			actor.userId = "approver";
			if (operation === "list") {
				expect(
					(
						await app()
							.request("/integrations/approvals")
							.then((res) => res.json())
					).data,
				).toEqual([]);
			} else {
				expect(
					(
						await post(
							`/integrations/approvals/${pending.data.approvalId}/${operation}`,
						)
					).status,
				).toBe(403);
			}
			expect(approvals[0].status).toBe("pending");
			expect(calls).toEqual([]);
		},
	);

	it("allows a teammate to list and deny an intentionally shared connection request", async () => {
		seed("shared", "requester", "ORGANIZATION_SHARED");
		const pending = await (
			await post("/integrations/gmail/destroy")
		).json();
		actor.userId = "approver";
		expect(
			(
				await app()
					.request("/integrations/approvals")
					.then((res) => res.json())
			).data,
		).toHaveLength(1);
		expect(
			(
				await post(
					`/integrations/approvals/${pending.data.approvalId}/deny`,
				)
			).status,
		).toBe(200);
		expect(approvals[0].status).toBe("denied");
		expect(calls).toEqual([]);
	});
	it.each(["sharing", "approver membership", "requester membership"])(
		"blocks approval, visibility and denial after revoked %s without side effects",
		async (revoked) => {
			seed("shared", "requester", "ORGANIZATION_SHARED");
			const pending = await (
				await post("/integrations/gmail/destroy")
			).json();
			actor.userId = "approver";
			if (revoked === "sharing") {
				store.row("shared").usageScope = "OWNER_ONLY";
			} else {
				member.mockImplementation(async ({ where }: any) =>
					where.userId ===
					(revoked === "approver membership"
						? "approver"
						: "requester")
						? null
						: { id: "example-member" },
				);
			}
			expect(
				(
					await app()
						.request("/integrations/approvals")
						.then((res) => res.json())
				).data,
			).toEqual([]);
			for (const decision of ["approve", "deny"]) {
				expect(
					(
						await post(
							`/integrations/approvals/${pending.data.approvalId}/${decision}`,
						)
					).status,
				).toBe(403);
			}
			expect(approvals[0].status).toBe("pending");
			expect(calls).toEqual([]);
		},
	);

	it("allows expressly shared credentials but denies approval after sharing is revoked", async () => {
		seed("shared", "teammate", "ORGANIZATION_SHARED");
		const pending = await (
			await post("/integrations/gmail/destroy")
		).json();
		store.row("shared").usageScope = "OWNER_ONLY";
		expect(
			(
				await post(
					`/integrations/approvals/${pending.data.approvalId}/approve`,
				)
			).status,
		).toBe(403);
		expect(calls).toEqual([]);
	});
	it("denies approval when the original requester loses membership", async () => {
		seed("own", "requester");
		const pending = await (
			await post("/integrations/gmail/destroy")
		).json();
		actor.userId = "approver";
		member.mockImplementation(async (args: any) =>
			args.where.userId === "requester" ? null : { id: "member-example" },
		);
		expect(
			(
				await post(
					`/integrations/approvals/${pending.data.approvalId}/approve`,
				)
			).status,
		).toBe(403);
		expect(calls).toEqual([]);
	});
	it("never substitutes another credential after the originally selected row is disconnected", async () => {
		seed("own", "requester");
		const pending = await (
			await post("/integrations/gmail/destroy")
		).json();
		store.row("own").isActive = false;
		seed("replacement", "requester");
		expect(
			(
				await post(
					`/integrations/approvals/${pending.data.approvalId}/approve`,
				)
			).status,
		).toBe(403);
		expect(calls).toEqual([]);
	});
	it("fails closed for legacy approvals that have no selected connection", async () => {
		seed("own", "requester");
		approvals.push({
			id: "legacy",
			userId: "system",
			organizationId: "org-example",
			pluginSlug: "gmail",
			endpoint: "destroy",
			args: {},
			riskLevel: "destructive",
			status: "pending",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60000),
		});
		expect(
			(await post("/integrations/approvals/legacy/approve")).status,
		).toBe(400);
		expect(calls).toEqual([]);
	});
	it("does not execute a shared connection in a different organization", async () => {
		seed("foreign", "teammate", "ORGANIZATION_SHARED", "org-other");
		expect((await post("/integrations/gmail/read")).status).toBe(404);
		expect(calls).toEqual([]);
	});
});

function pendingRow(
	id: string,
	integrationId: string,
	userId: string,
	createdAt: Date,
) {
	return {
		id,
		integrationId,
		userId,
		organizationId: "org-example",
		pluginSlug: "gmail",
		endpoint: "destroy",
		args: {},
		riskLevel: "destructive",
		status: "pending",
		createdAt,
		expiresAt: new Date(Date.now() + 60000),
	};
}
describe("approval visibility before limiting", () => {
	it("finds older accessible approvals behind more than one batch of newer private approvals", async () => {
		seed("teammate-private", "teammate");
		seed("own", "requester");
		seed("shared", "teammate", "ORGANIZATION_SHARED");
		for (let index = 0; index < 205; index++) {
			approvals.push(
				pendingRow(
					`private-${index}`,
					"teammate-private",
					"teammate",
					new Date("2026-01-03"),
				),
			);
		}
		approvals.push(
			pendingRow("visible-c", "own", "requester", new Date("2026-01-02")),
			pendingRow(
				"visible-b",
				"shared",
				"teammate",
				new Date("2026-01-02"),
			),
			pendingRow("visible-a", "own", "requester", new Date("2026-01-02")),
		);
		const body = await (
			await app().request("/integrations/approvals?limit=2")
		).json();
		expect(body.data.map((row: any) => row.id)).toEqual([
			"visible-c",
			"visible-b",
		]);
		expect(db.integrationApproval.findMany).toHaveBeenCalledTimes(3);
		expect(db.integrationApproval.findMany.mock.calls[1][0]).toMatchObject({
			take: 100,
			skip: 1,
			cursor: { id: expect.any(String) },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		});
		expect(approvals.every((row) => row.status === "pending")).toBe(true);
		expect(calls).toEqual([]);
	});
	it("terminates at database exhaustion when all full batches are inaccessible", async () => {
		seed("private", "teammate");
		for (let index = 0; index < 200; index++) {
			approvals.push(
				pendingRow(
					`private-${index}`,
					"private",
					"teammate",
					new Date("2026-01-03"),
				),
			);
		}
		const body = await (
			await app().request("/integrations/approvals")
		).json();
		expect(body.data).toEqual([]);
		expect(db.integrationApproval.findMany).toHaveBeenCalledTimes(3);
	});
	it.each(["0", "-1", "NaN", "abc", "1.5"])(
		"rejects invalid limit %s before querying or mutation",
		async (limit) => {
			expect(
				(await app().request(`/integrations/approvals?limit=${limit}`))
					.status,
			).toBe(400);
			expect(db.integrationApproval.findMany).not.toHaveBeenCalled();
			expect(calls).toEqual([]);
		},
	);
	it("retains the maximum result limit of 100", async () => {
		seed("own", "requester");
		for (let index = 0; index < 101; index++) {
			approvals.push(
				pendingRow(
					`own-${index}`,
					"own",
					"requester",
					new Date("2026-01-03"),
				),
			);
		}
		expect(
			(
				await app()
					.request("/integrations/approvals?limit=1000")
					.then((res) => res.json())
			).data,
		).toHaveLength(100);
		expect(db.integrationApproval.findMany).toHaveBeenCalledTimes(1);
	});
});
