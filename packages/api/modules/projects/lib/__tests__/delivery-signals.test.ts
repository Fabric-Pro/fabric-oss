import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	visible: vi.fn(),
	access: vi.fn(),
	deleted: vi.fn(),
	rows: vi.fn(),
	one: vi.fn(),
	project: vi.fn(),
	member: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: m.visible,
	isProjectSoftDeleted: m.deleted,
	db: {
		userStory: { findMany: m.rows, findFirst: m.one },
		project: { findFirst: m.project },
		member: { findUnique: m.member },
	},
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));

import { ORPCError } from "@orpc/server";
import {
	deliverySignalErrorCode,
	deliverySignalProviderWhere,
	deliverySignalSelect,
	getDeliverySignal,
	listDeliverySignals,
	recordedDeliverySignalProvider,
	requireDeliverySignalIntegrationRead,
	requireDeliverySignalProjectAccess,
	requireDeliverySignalScopes,
} from "../delivery-signals";

const actor = { userId: "example-user" };
const projectId = "example-project";
const organizationId = "example-org";
const time = new Date("2026-11-01T00:00:00Z");
const row = {
	id: "example-2",
	identifier: "US-2",
	title: "Saved work",
	source: "JIRA",
	reporterSource: null,
	draftingStage: "DRAFT",
	createdAt: time,
};
beforeEach(() => {
	vi.clearAllMocks();
	m.visible.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.access.mockResolvedValue({
		organizationId,
		organizationDeleted: false,
		source: "project-member",
		permissions: [Permissions.PROJECT_READ, Permissions.STORY_READ],
	});
	m.rows.mockResolvedValue([row]);
	m.one.mockResolvedValue(row);
	m.project.mockResolvedValue({ organization: { slug: "example-team" } });
	m.member.mockResolvedValue({ role: "owner" });
});

describe("delivery source eligibility", () => {
	it.each(["JIRA", "AZURE_DEVOPS", "FIZZY", "SLACK"])(
		"direct %s wins over a different reporter",
		(source) => {
			expect(
				recordedDeliverySignalProvider({
					source,
					reporterSource: "TEAMS",
				}),
			).toBe(source);
		},
	);
	it.each(["MANUAL", "CUSTOM_AGENT", "APPROVED_PROPOSAL", "AI_UPDATE"])(
		"only admitted fallback %s uses its reporter",
		(source) => {
			expect(
				recordedDeliverySignalProvider({
					source,
					reporterSource: "TEAMS",
				}),
			).toBe("TEAMS");
			expect(
				recordedDeliverySignalProvider({
					source,
					reporterSource: "SLACK",
				}),
			).toBe("SLACK");
			expect(
				recordedDeliverySignalProvider({
					source,
					reporterSource: null,
				}),
			).toBeNull();
		},
	);
	it.each([
		"AI_RECOMMENDED",
		"GITHUB",
		"GITLAB",
		"LINEAR",
		"SECURITY_SCAN",
		"PIPELINE_FAILURE",
		"UNKNOWN",
	])("excludes %s even with a supported reporter", (source) => {
		expect(
			recordedDeliverySignalProvider({ source, reporterSource: "TEAMS" }),
		).toBeNull();
	});
	it("keeps Teams source predicates positive rather than reporter-only", () => {
		expect(deliverySignalProviderWhere("TEAMS")).toEqual({
			source: {
				in: [
					"MANUAL",
					"CUSTOM_AGENT",
					"APPROVED_PROPOSAL",
					"AI_UPDATE",
				],
			},
			reporterSource: "TEAMS",
		});
	});
});
describe("delivery history disclosure", () => {
	it("projects exactly the permitted fields, including code-point title bounds", async () => {
		m.rows.mockResolvedValue([
			{
				...row,
				title: "😀".repeat(241),
				sourceMetadata: { secret: "not-public" },
				description: "private source text",
				externalUrl: "https://example.com/private",
			},
		]);
		const result = await listDeliverySignals(actor, { projectId });
		expect(Object.keys(result.items[0]).sort()).toEqual(
			[
				"id",
				"identifier",
				"title",
				"source",
				"kind",
				"draftingStage",
				"createdAt",
				"href",
			].sort(),
		);
		expect(Array.from(result.items[0].title)).toHaveLength(240);
		expect(JSON.stringify(result)).not.toMatch(
			/secret|private|sourceMetadata|description|externalUrl/,
		);
		expect(result.items[0].href).toBe(
			"/app/example-team/projects/example-project/stories/example-2",
		);
		expect(m.rows.mock.calls[0][0].select).toEqual(deliverySignalSelect);
		expect(Object.keys(deliverySignalSelect).sort()).toEqual(
			[
				"id",
				"identifier",
				"title",
				"source",
				"reporterSource",
				"draftingStage",
				"createdAt",
			].sort(),
		);
	});
	it("applies project, organization, soft-delete, source and search before the bounded take", async () => {
		await listDeliverySignals(actor, {
			projectId,
			source: "TEAMS",
			search: " action ",
			limit: 5,
		});
		expect(m.rows).toHaveBeenCalledWith(
			expect.objectContaining({
				take: 6,
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				where: expect.objectContaining({
					projectId,
					project: { organizationId, deletedAt: null },
					draftingStage: { not: "DECLINED" },
					AND: [
						deliverySignalProviderWhere("TEAMS"),
						{
							OR: [
								{
									title: {
										contains: "action",
										mode: "insensitive",
									},
								},
								{
									identifier: {
										contains: "action",
										mode: "insensitive",
									},
								},
							],
						},
					],
				}),
			}),
		);
	});
	it("uses the same minimized select and eligibility for detail", async () => {
		expect(
			await getDeliverySignal(actor, { projectId, id: row.id }),
		).toMatchObject({
			source: "JIRA",
			kind: "PROJECT_WORK_ITEM",
			draftingStage: "DRAFT",
		});
		expect(m.one.mock.calls[0][0]).toMatchObject({
			select: deliverySignalSelect,
			where: {
				AND: [
					expect.objectContaining({
						projectId,
						project: { organizationId, deletedAt: null },
						draftingStage: { not: "DECLINED" },
					}),
					{ id: row.id },
				],
			},
		});
		m.one.mockResolvedValue(null);
		await expect(
			getDeliverySignal(actor, { projectId, id: "missing" }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	});
	it("supports a project guest without any active or member organization", async () => {
		m.member.mockResolvedValue(null);
		expect(
			(await listDeliverySignals(actor, { projectId })).items,
		).toHaveLength(1);
		expect(m.member).not.toHaveBeenCalled();
		await expect(
			requireDeliverySignalIntegrationRead({
				projectId,
				organizationId,
				userId: actor.userId,
			}),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
	});
	it("refuses invisible and trashed projects before querying history", async () => {
		m.visible.mockResolvedValue(false);
		await expect(
			listDeliverySignals(actor, { projectId }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		m.visible.mockResolvedValue(true);
		m.deleted.mockResolvedValue(true);
		await expect(
			listDeliverySignals(actor, { projectId }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(m.rows).not.toHaveBeenCalled();
	});
	it.each([null, "", "   "])(
		"refuses invalid resolved organization %s",
		async (invalid) => {
			m.access.mockResolvedValue({
				organizationId: invalid,
				permissions: Object.values(Permissions),
			});
			await expect(
				listDeliverySignals(actor, { projectId }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.rows).not.toHaveBeenCalled();
		},
	);
	it("checks issued tenant and project guards even for an otherwise permitted actor", async () => {
		for (const extra of [
			{ organizationBinding: { organizationId: "other-org" } },
			{ organizationBinding: { organizationId: null } },
			{ boundProjectId: "other-project" },
		]) {
			await expect(
				listDeliverySignals({ ...actor, ...extra }, { projectId }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
		}
		expect(m.rows).not.toHaveBeenCalled();
	});
	it("retains target organization deletion cause before permission evaluation", async () => {
		m.access.mockResolvedValue({
			organizationId,
			organizationDeleted: true,
			permissions: [],
		});
		await expect(
			listDeliverySignals(actor, { projectId }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: "ORGANIZATION_DELETED" },
		});
		expect(m.rows).not.toHaveBeenCalled();
	});
	it.each([Permissions.PROJECT_READ, Permissions.STORY_READ])(
		"rechecks effective project permission %s",
		async (missing) => {
			m.access.mockResolvedValue({
				organizationId,
				organizationDeleted: false,
				permissions: [
					Permissions.PROJECT_READ,
					Permissions.STORY_READ,
				].filter((permission) => permission !== missing),
			});
			await expect(
				listDeliverySignals(actor, { projectId }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "INSUFFICIENT_PERMISSION" },
			});
			expect(m.rows).not.toHaveBeenCalled();
		},
	);
	it("rejects injected actor/tenant fields", async () => {
		await expect(
			listDeliverySignals(actor, {
				projectId,
				userId: "other-user",
				organizationId,
			}),
		).rejects.toThrow();
		expect(m.rows).not.toHaveBeenCalled();
	});
});
describe("stable bounded history cursors", () => {
	async function firstCursor() {
		m.rows.mockResolvedValue([row, { ...row, id: "example-1" }]);
		const page = await listDeliverySignals(actor, { projectId, limit: 1 });
		if (!page.nextCursor) {
			throw Error("Expected continuation");
		}
		return page.nextCursor;
	}
	it("uses timestamp/id tie-breaker and rechecks the anchor in its complete eligible query", async () => {
		const cursor = await firstCursor();
		m.rows.mockResolvedValue([{ ...row, id: "example-1" }]);
		const page = await listDeliverySignals(actor, {
			projectId,
			cursor,
			limit: 5,
		});
		expect(page.nextCursor).toBeNull();
		expect(m.one.mock.calls.at(-1)[0]).toMatchObject({
			where: {
				AND: [
					expect.objectContaining({
						projectId,
						project: { organizationId, deletedAt: null },
					}),
					{ id: row.id, createdAt: time },
				],
			},
			select: { id: true },
		});
		expect(m.rows.mock.calls.at(-1)[0]).toMatchObject({
			take: 6,
			where: {
				AND: [
					expect.objectContaining({
						projectId,
						project: { organizationId, deletedAt: null },
					}),
					{
						OR: [
							{ createdAt: { lt: time } },
							{ createdAt: time, id: { lt: row.id } },
						],
					},
				],
			},
		});
	});
	it("returns the same generic error for malformed, foreign-query, foreign-actor and missing anchors", async () => {
		const cursor = await firstCursor();
		const expected = {
			code: "BAD_REQUEST",
			message: "Invalid cursor. Reload project history.",
		};
		for (const invalid of [
			"",
			"!bad",
			"x".repeat(2049),
			{},
			null,
			Buffer.from('{"v":2}').toString("base64url"),
		]) {
			await expect(
				listDeliverySignals(actor, { projectId, cursor: invalid }),
			).rejects.toMatchObject(expected);
		}
		for (const change of [
			{ source: "SLACK" },
			{ search: "other" },
			{ projectId: "other-project" },
		]) {
			await expect(
				listDeliverySignals(actor, { projectId, cursor, ...change }),
			).rejects.toMatchObject(expected);
		}
		await expect(
			listDeliverySignals(
				{ userId: "other-user" },
				{ projectId, cursor },
			),
		).rejects.toMatchObject(expected);
		m.one.mockResolvedValue(null);
		await expect(
			listDeliverySignals(actor, { projectId, cursor }),
		).rejects.toMatchObject(expected);
	});
	it("checks live project access before rejecting a malformed cursor", async () => {
		m.visible.mockResolvedValue(false);
		await expect(
			listDeliverySignals(actor, { projectId, cursor: {} }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
describe("scope and native error envelopes", () => {
	it("requires both exact read scopes, plus integrations for saved settings", () => {
		expect(() => requireDeliverySignalScopes(["projects:read"])).toThrow();
		expect(() => requireDeliverySignalScopes(["mcp:read"])).toThrow();
		expect(() =>
			requireDeliverySignalScopes(["projects:read", "features:read"]),
		).not.toThrow();
		expect(() =>
			requireDeliverySignalScopes(
				["projects:read", "features:read"],
				true,
			),
		).toThrow();
		expect(() => requireDeliverySignalScopes(["*"], true)).not.toThrow();
	});
	it("keeps scope, actor and restoration causes distinct", () => {
		for (const code of ["INSUFFICIENT_SCOPE", "INSUFFICIENT_PERMISSION"]) {
			expect(
				deliverySignalErrorCode(
					new ORPCError("FORBIDDEN", { data: { code } }),
				),
			).toBe(code);
		}
		expect(
			deliverySignalErrorCode(
				new ORPCError("FORBIDDEN", {
					data: { errorCode: "ORGANIZATION_DELETED" },
				}),
			),
		).toBe("ORGANIZATION_DELETED");
	});
	it("uses the live org member grant only for configuration", async () => {
		const scope = await requireDeliverySignalProjectAccess(
			actor,
			projectId,
		);
		await requireDeliverySignalIntegrationRead(scope);
		expect(m.member).toHaveBeenCalledWith({
			where: {
				organizationId_userId: { organizationId, userId: actor.userId },
			},
			select: { role: true },
		});
	});
});
