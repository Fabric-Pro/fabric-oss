import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	mCPServer: { findUnique: vi.fn() },
	mCPConfig: { findUnique: vi.fn() },
	userStory: { findMany: vi.fn(), updateMany: vi.fn() },
	project: { findMany: vi.fn(), findUnique: vi.fn() },
	$transaction: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db,
	Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

import { planProjectStamps, resolveTrusted } from "../pm-server-provenance";

beforeEach(() => {
	vi.clearAllMocks();
	db.userStory.findMany.mockResolvedValue([]);
});

const project = {
	id: "proj1",
	projectManagementMcpServerId: "srv-ado",
	projectManagementMcpConfigId: "cfg1",
};

describe("resolveTrusted", () => {
	it("returns no-config when the project has no server", async () => {
		const res = await resolveTrusted(db as never, {
			id: "p",
			projectManagementMcpServerId: null,
			projectManagementMcpConfigId: null,
		});
		expect(res).toEqual({ ok: false, reason: "no-config" });
	});

	it("returns unsupported-tooltype for a non-PM server key", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "slack-remote",
			defaultUrl: null,
		});
		const res = await resolveTrusted(db as never, project);
		expect(res).toEqual({ ok: false, reason: "unsupported-tooltype" });
	});

	it("derives the trusted key from ADO config commandArgs", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "azure-devops",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: null,
			commandArgs: ["Contoso"],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				externalMcpServerId: null,
			},
		]);
		const res = await resolveTrusted(db as never, project);
		expect(res).toMatchObject({
			ok: true,
			activeServerId: "srv-ado",
			toolType: "azure-devops",
			trusted: { kind: "trusted", key: "contoso" },
		});
	});

	it("derives fallback trust from an already-stamped active-server row", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "fizzy",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: "https://fizzy.fabric.pro",
			commandArgs: [],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl: "https://app.fizzy.do/000000/cards/1",
				externalMcpServerId: null,
			},
			{
				id: "s2",
				externalId: "2",
				externalUrl: "https://app.fizzy.do/000000/cards/2",
				externalMcpServerId: "srv-fizzy",
			},
		]);
		const res = await resolveTrusted(db as never, {
			...project,
			projectManagementMcpServerId: "srv-fizzy",
		});
		expect(res).toMatchObject({
			ok: true,
			trusted: { kind: "trusted", key: "000000" },
		});
	});

	it("fallback fails closed when a current-tool link has a null/unparseable URL", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "fizzy",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: "https://fizzy.fabric.pro",
			commandArgs: [],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl: "https://app.fizzy.do/000000/cards/1",
				externalMcpServerId: null,
			},
			{
				id: "s2",
				externalId: "2",
				externalUrl: null,
				externalMcpServerId: "srv-fizzy",
			}, // unverifiable → fail closed
		]);
		const res = await resolveTrusted(db as never, {
			...project,
			projectManagementMcpServerId: "srv-fizzy",
		});
		expect(res).toMatchObject({
			ok: true,
			trusted: { kind: "ambiguous", reason: "fallback-unparseable" },
		});
	});

	it("handles the GitLab REST sentinel (key:gitlab-official) with no catalog row", async () => {
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s0",
				externalId: "0",
				externalUrl: "https://gitlab.com/acme/app/-/issues/0",
				externalMcpServerId: "key:gitlab-official",
			},
			{
				id: "s1",
				externalId: "1",
				externalUrl: "https://gitlab.com/acme/app/-/issues/1",
				externalMcpServerId: null,
			},
		]);
		const res = await resolveTrusted(db as never, {
			id: "p",
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
		});
		expect(res).toMatchObject({
			ok: true,
			activeServerId: "key:gitlab-official", // sentinel is the stamp value
			toolType: "gitlab",
			trusted: { kind: "trusted", key: "acme" }, // derives fallback trust from already-stamped active-server row
		});
		expect(db.mCPServer.findUnique).not.toHaveBeenCalled();
	});

	it("returns none (no baseline) for a proxied project with only unstamped links", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "fizzy",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: "https://fizzy.fabric.pro",
			commandArgs: [],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl: "https://app.fizzy.do/000000/cards/1",
				externalMcpServerId: null,
			},
			{
				id: "s2",
				externalId: "2",
				externalUrl: "https://app.fizzy.do/000000/cards/2",
				externalMcpServerId: null,
			},
		]);
		const res = await resolveTrusted(db as never, {
			...project,
			projectManagementMcpServerId: "srv-fizzy",
		});
		expect(res).toMatchObject({ ok: true, trusted: { kind: "none" } });
	});
});

describe("planProjectStamps", () => {
	it("marks only the matching-org candidate; categorizes the rest", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "azure-devops",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: null,
			commandArgs: ["Contoso"],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				externalMcpServerId: null,
			}, // stamp
			{
				id: "s2",
				externalId: "2",
				externalUrl: "https://dev.azure.com/OldOrg/p/_workitems/edit/2",
				externalMcpServerId: null,
			}, // org-mismatch
			{
				id: "s3",
				externalId: "3",
				externalUrl: "https://acme.atlassian.net/browse/X-3",
				externalMcpServerId: null,
			}, // tool-mismatch
			{
				id: "s4",
				externalId: "4",
				externalUrl: null,
				externalMcpServerId: null,
			}, // no-url
		]);
		const plan = await planProjectStamps(db as never, project);
		expect(plan.ok && plan.marks).toEqual([
			{
				table: "userStory",
				id: "s1",
				projectId: "proj1",
				externalId: "1",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
			},
		]);
		expect(plan.ok && plan.counts).toMatchObject({
			"skip:org-mismatch": 1,
			"skip:tool-mismatch": 1,
			"skip:no-url": 1,
		});
	});

	it("returns the resolve failure reason", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "slack-remote",
			defaultUrl: null,
		});
		const plan = await planProjectStamps(db as never, project);
		expect(plan).toEqual({ ok: false, reason: "unsupported-tooltype" });
	});

	it("does not re-mark already-stamped rows (idempotency)", async () => {
		db.mCPServer.findUnique.mockResolvedValue({
			key: "azure-devops",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: null,
			commandArgs: ["Contoso"],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				externalMcpServerId: null,
			}, // candidate — should be in marks
			{
				id: "s2",
				externalId: "2",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/2",
				externalMcpServerId: "srv-ado",
			}, // already stamped — must NOT be in marks
		]);
		const plan = await planProjectStamps(db as never, project);
		expect(plan.ok && plan.marks.map((m) => m.id)).toEqual(["s1"]);
		expect(
			plan.ok && plan.marks.find((m) => m.id === "s2"),
		).toBeUndefined();
	});
});

import { applyProjectStamps } from "../pm-server-provenance";

function adoServer() {
	db.mCPServer.findUnique.mockResolvedValue({
		key: "azure-devops",
		defaultUrl: null,
	});
}
function adoConfig(org: string) {
	db.mCPConfig.findUnique.mockResolvedValue({
		baseUrl: null,
		commandArgs: [org],
		atlassianCloudSiteUrl: null,
		mcpServer: { defaultUrl: null },
	});
}
const planFixture = {
	ok: true as const,
	activeServerId: "srv-ado",
	toolType: "azure-devops" as const,
	trusted: { kind: "trusted" as const, key: "contoso" },
	marks: [
		{
			table: "userStory" as const,
			id: "s1",
			projectId: "proj1",
			externalId: "1",
			externalUrl: "https://dev.azure.com/Contoso/p/_workitems/edit/1",
		},
	],
	counts: {},
};

describe("applyProjectStamps", () => {
	beforeEach(() => {
		db.$transaction.mockImplementation(
			async (fn: (tx: typeof db) => unknown) => fn(db),
		);
		db.project.findUnique.mockResolvedValue(project); // live reload returns the same project by default
	});

	it("stamps when live trustedKey matches and the row is unchanged", async () => {
		adoServer();
		adoConfig("Contoso"); // recompute yields contoso === plan
		db.userStory.updateMany.mockResolvedValue({ count: 1 });
		const out = await applyProjectStamps(db as never, project, planFixture);
		expect(out).toEqual({ stamped: 1, changedSinceSnapshot: 0 });
		expect(db.userStory.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s1",
				projectId: "proj1",
				externalId: "1",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				externalMcpServerId: null,
			},
			data: { externalMcpServerId: "srv-ado" },
		});
		expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
		});
	});

	it("aborts when the LIVE project row was reconfigured to a different tenant (project-config-changed)", async () => {
		adoServer();
		// The live project row now points at a different config that resolves to a different org.
		db.project.findUnique.mockResolvedValue({
			id: "proj1",
			projectManagementMcpServerId: "srv-ado",
			projectManagementMcpConfigId: "cfg2",
		});
		db.mCPConfig.findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === "cfg2"
					? {
							baseUrl: null,
							commandArgs: ["NewOrg"],
							atlassianCloudSiteUrl: null,
							mcpServer: { defaultUrl: null },
						}
					: {
							baseUrl: null,
							commandArgs: ["Contoso"],
							atlassianCloudSiteUrl: null,
							mcpServer: { defaultUrl: null },
						},
		);
		db.userStory.updateMany.mockResolvedValue({ count: 1 });
		const out = await applyProjectStamps(db as never, project, planFixture);
		expect(out).toEqual({
			stamped: 0,
			changedSinceSnapshot: 0,
			projectSkipped: "project-config-changed",
		});
		expect(db.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("counts a row whose link changed since snapshot (count 0)", async () => {
		adoServer();
		adoConfig("Contoso");
		db.userStory.updateMany.mockResolvedValue({ count: 0 });
		const out = await applyProjectStamps(db as never, project, planFixture);
		expect(out).toEqual({ stamped: 0, changedSinceSnapshot: 1 });
	});

	it("retries on serialization failure then skips after the cap", async () => {
		adoServer();
		adoConfig("Contoso");
		db.$transaction.mockRejectedValue({ code: "P2034" });
		const out = await applyProjectStamps(db as never, project, planFixture);
		expect(out).toEqual({
			stamped: 0,
			changedSinceSnapshot: 0,
			projectSkipped: "serialization-conflict",
		});
		expect(db.$transaction).toHaveBeenCalledTimes(3);
	});

	it("routes EVERY mark (including a legacy feature-table mark) to the userStory delegate — the folder tables were dropped", async () => {
		adoServer();
		adoConfig("Contoso");
		db.userStory.updateMany.mockResolvedValue({ count: 1 });
		const multiTablePlan = {
			ok: true as const,
			activeServerId: "srv-ado",
			toolType: "azure-devops" as const,
			trusted: { kind: "trusted" as const, key: "contoso" },
			marks: [
				{
					// Legacy persisted mark — still typed "feature" on the wire;
					// the apply routine sends it to the userStory table (where a
					// non-story id simply matches 0 rows in production).
					table: "feature" as const,
					id: "f1",
					projectId: "proj1",
					externalId: "1",
					externalUrl:
						"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				},
				{
					table: "userStory" as const,
					id: "u1",
					projectId: "proj1",
					externalId: "2",
					externalUrl:
						"https://dev.azure.com/Contoso/p/_workitems/edit/2",
				},
			],
			counts: {},
		};
		const out = await applyProjectStamps(
			db as never,
			project,
			multiTablePlan,
		);
		expect(out).toEqual({ stamped: 2, changedSinceSnapshot: 0 });
		expect(db.userStory.updateMany).toHaveBeenCalledTimes(2);
	});
});

import { runBackfill } from "../pm-server-provenance";

describe("runBackfill", () => {
	beforeEach(() => {
		db.$transaction.mockImplementation(
			async (fn: (tx: typeof db) => unknown) => fn(db),
		);
		db.mCPServer.findUnique.mockResolvedValue({
			key: "azure-devops",
			defaultUrl: null,
		});
		db.mCPConfig.findUnique.mockResolvedValue({
			baseUrl: null,
			commandArgs: ["Contoso"],
			atlassianCloudSiteUrl: null,
			mcpServer: { defaultUrl: null },
		});
		db.project.findMany.mockResolvedValue([
			{
				id: "proj1",
				projectManagementMcpServerId: "srv-ado",
				projectManagementMcpConfigId: "cfg1",
			},
		]);
		db.project.findUnique.mockResolvedValue({
			id: "proj1",
			projectManagementMcpServerId: "srv-ado",
			projectManagementMcpConfigId: "cfg1",
		});
		db.userStory.findMany.mockResolvedValue([
			{
				id: "s1",
				externalId: "1",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				externalMcpServerId: null,
			},
		]);
	});

	it("dry-run reports would-stamp and writes nothing", async () => {
		const report = await runBackfill(
			db as never,
			{ apply: false },
			() => {},
		);
		expect(report).toMatchObject({
			projects: 1,
			wouldStamp: 1,
			stamped: 0,
		});
		expect(db.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("apply stamps and reports the count", async () => {
		db.userStory.updateMany.mockResolvedValue({ count: 1 });
		const report = await runBackfill(
			db as never,
			{ apply: true },
			() => {},
		);
		expect(report).toMatchObject({ projects: 1, stamped: 1 });
		expect(db.userStory.updateMany).toHaveBeenCalledTimes(1);
	});
});
