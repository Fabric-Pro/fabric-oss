/**
 * `updateProject` and PM → Fabric status sync (Fizzy #2304, spec D1.1–D1.7).
 *
 * Covers what the settings save must do for the status-sync switch to work:
 *   - D1.1 the disconnect rule — a REST GitLab re-save is not a disconnect;
 *   - D1.2 the attachment opt-in gate follows the new disconnect rule;
 *   - D1.3 enrolment in the hourly state poll;
 *   - D1.4 the switch is scoped to one PM source, and GitLab over MCP is
 *     refused;
 *   - D1.5 off → on starts a fresh session in ONE transaction;
 *   - D1.6 the switch, and a label-map change while it is on, need
 *     PROJECT_SETTINGS_EDIT.
 *
 * Harness copied from update-project-sync-attachments.test.ts (the pinned
 * disconnect tests, which must stay green unmodified), with one change: the
 * project read is a SELECT-HONOURING fake. It returns only the fields the
 * procedure's `select` names and throws on a selected field the fixture lacks,
 * so a decision that reads a stored field the select forgot fails here instead
 * of silently reading `undefined` (spec §6 rule 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
	updateProject: vi.fn(),
	buildUpdateProjectOperation: vi.fn(),
	projectUpdate: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	projectActivityCreate: vi.fn(),
	transaction: vi.fn(),
	resolveAccess: vi.fn(),
	governanceAllowed: vi.fn(),
	recordAudit: vi.fn(),
	JSON_NULL: Symbol("JsonNull"),
	DB_NULL: Symbol("DbNull"),
	tables: { project: [] as Row[], mCPServer: [] as Row[] },
}));

/**
 * A `findUnique({ where: { id }, select })` that behaves like Prisma for the
 * shapes this procedure uses: only keys selected as exactly `true` come back,
 * and a selected key missing from the fixture row is a fixture defect.
 */
function selectHonouringFindUnique(table: "project" | "mCPServer") {
	return async (args: {
		where: { id: string };
		select?: Record<string, unknown>;
	}) => {
		const row = mocks.tables[table].find((r) => r.id === args.where.id);
		if (!row) {
			return null;
		}
		if (!args.select) {
			return { ...row };
		}
		const projected: Row = {};
		for (const [key, wanted] of Object.entries(args.select)) {
			if (wanted !== true) {
				continue;
			}
			if (!(key in row)) {
				throw new Error(
					`fake db: ${table} fixture row has no field "${key}"`,
				);
			}
			projected[key] = row[key];
		}
		return projected;
	};
}

vi.mock("@repo/database", async () => ({
	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),
	db: {
		project: {
			findUnique: selectHonouringFindUnique("project"),
			update: (args: unknown) => mocks.projectUpdate(args),
		},
		mCPServer: { findUnique: selectHonouringFindUnique("mCPServer") },
		userStory: {
			updateMany: (args: unknown) => mocks.userStoryUpdateMany(args),
		},
		projectActivity: {
			create: (args: unknown) => mocks.projectActivityCreate(args),
		},
		$transaction: (ops: unknown[]) => mocks.transaction(ops),
	},
	updateProject: (...a: unknown[]) => mocks.updateProject(...a),
	buildUpdateProjectOperation: (...a: unknown[]) =>
		mocks.buildUpdateProjectOperation(...a),
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
	seedTerminalStatusesIfEmpty: vi.fn(),
	Prisma: { JsonNull: mocks.JSON_NULL, DbNull: mocks.DB_NULL },
	cleanupCodeSearchOnRepoUnlink: vi.fn(async () => ({
		deletedContextQdrantIds: [],
		organizationId: null,
	})),
	moveWizardTempContextsToProject: vi.fn(async () => ({
		movedCount: 0,
		contextIds: [],
		contextIdMapping: {},
		sessionId: "s",
	})),
	syncLegacyProjectRepoOnDisconnect: vi.fn(async () => {}),
	setAiUsageRecorder: vi.fn(),
	GATEWAY_PROVIDERS: new Set(["OPENAI", "ANTHROPIC"]),
	DB_GATEWAY_PROVIDERS: ["OPENAI", "ANTHROPIC"],
	AI_PROVIDER_METADATA: {},
}));

vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveAccess(...a),
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mocks.recordAudit(...a),
}));

vi.mock("../../lib/governance", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/governance")>()),
	userHasProjectPermissionStrict: (...a: unknown[]) =>
		mocks.governanceAllowed(...a),
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: (perms: string[], p: string) => perms.includes(p),
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; name?: string }; session: { id: string } };
}) => Promise<unknown>;

async function call(input: Record<string, unknown>, userId = "owner-1") {
	const mod = await import("../update-project");
	const { handler } = mod.updateProjectProcedure as unknown as {
		handler: Handler;
	};
	return handler({
		input: { organizationId: "org-1", ...input },
		context: { user: { id: userId, name: "Actor" }, session: { id: "s" } },
	});
}

const NOW = new Date("2026-09-21T09:00:00.000Z");

const LABEL_MAP_CONTEXT = {
	labelStatusMap: {
		"workflow::in-review": "status-in-progress",
		"workflow::done": "status-done",
	},
};

/** Every field the procedure's project read selects, realistic values. */
const BASE_ROW: Row = {
	userId: "owner-1",
	organizationId: "org-1",
	name: "Widgets",
	repositoryUrl: null,
	pmTerminalStatuses: ["Closed"],
	attachmentRetentionDays: null,
	engagementProfile: "GOVERNED",
	enforceSpecifyGate: false,
	enforceSpikeGate: false,
	enforceDiscoveryGate: false,
	documentTiersAdvisory: true,
	quotedPhases: [],
	status: "ACTIVE",
};

/** GitLab over REST: no MCP config; numeric container from the OAuth auto-wire. */
function restGitLabRow(overrides: Row = {}): Row {
	return {
		...BASE_ROW,
		id: "proj-rest",
		projectManagementMcpServerId: "srv-gitlab-official",
		projectManagementMcpConfigId: null,
		projectManagementContainerId: "4242",
		projectManagementAdditionalContext: LABEL_MAP_CONTEXT,
		adoStatePollActive: true,
		pmStatusSyncEnabled: false,
		...overrides,
	};
}

/** Jira over MCP. */
function jiraMcpRow(overrides: Row = {}): Row {
	return {
		...BASE_ROW,
		id: "proj-jira",
		projectManagementMcpServerId: "srv-atlassian",
		projectManagementMcpConfigId: "cfg-jira-1",
		projectManagementContainerId: "EXAMPLE",
		projectManagementAdditionalContext: null,
		adoStatePollActive: false,
		pmStatusSyncEnabled: false,
		...overrides,
	};
}

/** GitLab over MCP: a pinned MCP config on the GitLab server. */
function gitLabMcpRow(overrides: Row = {}): Row {
	return {
		...restGitLabRow(),
		id: "proj-gitlab-mcp",
		projectManagementMcpConfigId: "cfg-gitlab-mcp",
		...overrides,
	};
}

/** A project with no PM tool configured yet. */
function unconnectedRow(overrides: Row = {}): Row {
	return {
		...BASE_ROW,
		id: "proj-new",
		projectManagementMcpServerId: null,
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
		projectManagementAdditionalContext: null,
		adoStatePollActive: false,
		pmStatusSyncEnabled: false,
		...overrides,
	};
}

/** The PATCH the settings card sends for a REST GitLab save. */
function restSave(containerId: string, extra: Row = {}): Row {
	return {
		projectManagementMcpServerId: "srv-gitlab-official",
		projectManagementMcpConfigId: null,
		projectManagementContainerId: containerId,
		projectManagementContainerName: containerId,
		projectManagementAdditionalContext: LABEL_MAP_CONTEXT,
		...extra,
	};
}

const OWNER = { source: "owner", permissions: [] };
const EDITOR = { source: "org-role", permissions: ["PROJECT_UPDATE"] };
const ADMIN = {
	source: "org-role",
	permissions: ["PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT"],
};

const UPDATED = {
	id: "proj-rest",
	name: "Widgets",
	projectTypes: [],
	codeAnalysisStatus: "IDLE",
};

/** The data object handed to `updateProject` (the non-transaction path). */
function writtenData(): Row {
	expect(mocks.updateProject).toHaveBeenCalledTimes(1);
	return mocks.updateProject.mock.calls[0][2] as Row;
}

/** The operations handed to the single `$transaction` (the D1.5 path). */
function transactionOps(): unknown[] {
	expect(mocks.transaction).toHaveBeenCalledTimes(1);
	return mocks.transaction.mock.calls[0][0] as unknown[];
}

const STORY_BASE_RESET = {
	op: "userStory.updateMany",
	args: {
		where: { projectId: "proj-rest" },
		data: {
			pmStatusSyncBaseId: null,
			pmStatusSyncBaseAt: null,
			pmStatusSyncBaseLink: null,
			pmStatusSyncBaseFabricId: null,
		},
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	vi.stubEnv("FABRIC_FEATURE_PM_ATTACHMENT_SYNC", "true");
	mocks.tables.project = [
		restGitLabRow(),
		jiraMcpRow(),
		gitLabMcpRow(),
		unconnectedRow(),
	];
	mocks.tables.mCPServer = [
		{ id: "srv-gitlab-official", key: "gitlab-official" },
		{ id: "srv-atlassian", key: "atlassian" },
	];
	mocks.resolveAccess.mockResolvedValue(OWNER);
	mocks.governanceAllowed.mockResolvedValue(true);
	mocks.updateProject.mockResolvedValue(UPDATED);
	mocks.buildUpdateProjectOperation.mockImplementation(
		(projectId: string, data: Row, organizationId: string | null) => ({
			op: "project.update",
			projectId,
			organizationId,
			data,
		}),
	);
	mocks.projectUpdate.mockImplementation((args: unknown) => ({
		op: "project.update.raw",
		args,
	}));
	mocks.userStoryUpdateMany.mockImplementation((args: unknown) => ({
		op: "userStory.updateMany",
		args,
	}));
	mocks.projectActivityCreate.mockImplementation((args: unknown) => ({
		op: "projectActivity.create",
		args,
	}));
	mocks.transaction.mockImplementation(async (ops: Array<{ op: string }>) =>
		ops.map((o) => (o.op.startsWith("project.update") ? UPDATED : o)),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("D1.1 — the disconnect rule", () => {
	it("a same-container REST re-save keeps the poll, attachment sync and the switch", async () => {
		mocks.tables.project = [
			restGitLabRow({
				projectManagementContainerId: "example-group/widgets",
			}),
		];
		await call({ id: "proj-rest", ...restSave("example-group/widgets") });

		const data = writtenData();
		expect(data.projectManagementContainerId).toBe("example-group/widgets");
		expect(data).not.toHaveProperty("adoStatePollActive");
		expect(data).not.toHaveProperty("syncAttachments");
		expect(data).not.toHaveProperty("pmStatusSyncEnabled");
	});

	it("the picker keeping a saved numeric container is a re-save too", async () => {
		await call({ id: "proj-rest", ...restSave("4242") });

		const data = writtenData();
		expect(data.projectManagementContainerId).toBe("4242");
		expect(data).not.toHaveProperty("adoStatePollActive");
		expect(data).not.toHaveProperty("syncAttachments");
	});

	it("a container change still disconnects", async () => {
		await call({ id: "proj-rest", ...restSave("example-group/other") });

		expect(writtenData()).toMatchObject({
			projectManagementContainerId: "example-group/other",
			adoStatePollActive: false,
			syncAttachments: false,
			pmStatusSyncEnabled: false,
		});
	});

	it("a first REST connect still disconnects", async () => {
		await call({ id: "proj-new", ...restSave("example-group/widgets") });

		expect(writtenData()).toMatchObject({
			projectManagementMcpServerId: "srv-gitlab-official",
			adoStatePollActive: false,
			syncAttachments: false,
		});
	});

	it("an MCP → REST switch still disconnects", async () => {
		await call({ id: "proj-gitlab-mcp", ...restSave("4242") });

		expect(writtenData()).toMatchObject({
			projectManagementMcpConfigId: null,
			adoStatePollActive: false,
			syncAttachments: false,
			pmStatusSyncEnabled: false,
		});
	});

	it("{ projectManagementMcpConfigId: null } on its own still disconnects", async () => {
		await call({ id: "proj-rest", projectManagementMcpConfigId: null });

		expect(writtenData()).toMatchObject({
			adoStatePollActive: false,
			syncAttachments: false,
			pmStatusSyncEnabled: false,
		});
	});

	it('"None" disconnects', async () => {
		await call({
			id: "proj-rest",
			projectManagementMcpServerId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		expect(writtenData()).toMatchObject({
			projectManagementContainerId: null,
			adoStatePollActive: false,
			syncAttachments: false,
			pmStatusSyncEnabled: false,
		});
	});

	it("archive deactivates the poll and switches status sync off", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		await call({ id: "proj-rest", status: "ARCHIVED" });

		expect(writtenData()).toMatchObject({
			status: "ARCHIVED",
			adoStatePollActive: false,
			syncAttachments: false,
			pmStatusSyncEnabled: false,
		});
	});
});

describe("D1.2 — attachment opt-in gate", () => {
	it("persists syncAttachments:true on a REST re-save while the feature is on", async () => {
		await call({
			id: "proj-rest",
			...restSave("4242", { syncAttachments: true }),
		});

		expect(writtenData().syncAttachments).toBe(true);
	});

	it("refuses syncAttachments:true on a REST re-save while the feature is off", async () => {
		vi.stubEnv("FABRIC_FEATURE_PM_ATTACHMENT_SYNC", "false");
		// Positive control: the same re-save without the opt-in goes through.
		await call({ id: "proj-rest", ...restSave("4242") });
		expect(mocks.updateProject).toHaveBeenCalledTimes(1);

		await expect(
			call({
				id: "proj-rest",
				...restSave("4242", { syncAttachments: true }),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateProject).toHaveBeenCalledTimes(1);
	});

	it("lets a real disconnect carrying syncAttachments:true through with the feature off, forced false", async () => {
		vi.stubEnv("FABRIC_FEATURE_PM_ATTACHMENT_SYNC", "false");
		await call({
			id: "proj-rest",
			...restSave("example-group/other", { syncAttachments: true }),
		});

		expect(writtenData().syncAttachments).toBe(false);
	});
});

describe("D1.3 — enrolment in the state poll", () => {
	it("turning the switch on for REST GitLab enrols the project", async () => {
		mocks.tables.project = [restGitLabRow({ adoStatePollActive: false })];
		await call({ id: "proj-rest", pmStatusSyncEnabled: true });

		expect(transactionOps()[0]).toMatchObject({
			op: "project.update",
			data: { pmStatusSyncEnabled: true, adoStatePollActive: true },
		});
	});

	it("turning the switch on for an MCP tool enrols the project", async () => {
		await call({ id: "proj-jira", pmStatusSyncEnabled: true });

		expect(transactionOps()[0]).toMatchObject({
			op: "project.update",
			projectId: "proj-jira",
			data: { pmStatusSyncEnabled: true, adoStatePollActive: true },
		});
	});

	it("a PM connection re-save while the switch is on enrols the project", async () => {
		mocks.tables.project = [
			restGitLabRow({
				pmStatusSyncEnabled: true,
				adoStatePollActive: false,
			}),
		];
		await call({ id: "proj-rest", ...restSave("4242") });

		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(writtenData().adoStatePollActive).toBe(true);
	});

	it("a rename while the switch is on does not enrol the project", async () => {
		mocks.tables.project = [
			restGitLabRow({
				pmStatusSyncEnabled: true,
				adoStatePollActive: false,
			}),
		];
		await call({ id: "proj-rest", name: "Renamed" });

		const data = writtenData();
		expect(data.name).toBe("Renamed");
		expect(data).not.toHaveProperty("adoStatePollActive");
	});

	it("turning the switch off never de-enrols", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		await call({ id: "proj-rest", pmStatusSyncEnabled: false });

		const data = writtenData();
		expect(data.pmStatusSyncEnabled).toBe(false);
		expect(data).not.toHaveProperty("adoStatePollActive");
	});

	it("does not re-enrol a project already polling", async () => {
		await call({ id: "proj-rest", pmStatusSyncEnabled: true });

		const [projectOp] = transactionOps() as Array<{ data: Row }>;
		expect(projectOp.data.pmStatusSyncEnabled).toBe(true);
		expect(projectOp.data).not.toHaveProperty("adoStatePollActive");
	});

	it("does not enrol an archived project", async () => {
		mocks.tables.project = [
			restGitLabRow({ status: "ARCHIVED", adoStatePollActive: false }),
		];
		await call({ id: "proj-rest", pmStatusSyncEnabled: true });

		const [projectOp] = transactionOps() as Array<{ data: Row }>;
		expect(projectOp.data.pmStatusSyncEnabled).toBe(true);
		expect(projectOp.data).not.toHaveProperty("adoStatePollActive");
	});

	it("does not enrol a project with no PM container", async () => {
		await call({ id: "proj-new", pmStatusSyncEnabled: true });

		const [projectOp] = transactionOps() as Array<{ data: Row }>;
		expect(projectOp.data.pmStatusSyncEnabled).toBe(true);
		expect(projectOp.data).not.toHaveProperty("adoStatePollActive");
	});
});

describe("D1.4 — scoped to one PM source", () => {
	it("a server change switches status sync off", async () => {
		mocks.tables.project = [jiraMcpRow({ pmStatusSyncEnabled: true })];
		await call({
			id: "proj-jira",
			projectManagementMcpServerId: "srv-gitlab-official",
			projectManagementMcpConfigId: "cfg-gitlab-mcp",
			projectManagementContainerId: "EXAMPLE",
		});

		expect(writtenData()).toMatchObject({
			projectManagementMcpServerId: "srv-gitlab-official",
			pmStatusSyncEnabled: false,
		});
	});

	it("a config change switches status sync off without disconnecting", async () => {
		mocks.tables.project = [
			jiraMcpRow({ pmStatusSyncEnabled: true, adoStatePollActive: true }),
		];
		await call({
			id: "proj-jira",
			projectManagementMcpServerId: "srv-atlassian",
			projectManagementMcpConfigId: "cfg-jira-2",
			projectManagementContainerId: "EXAMPLE",
		});

		const data = writtenData();
		expect(data.projectManagementMcpConfigId).toBe("cfg-jira-2");
		expect(data.pmStatusSyncEnabled).toBe(false);
		expect(data).not.toHaveProperty("adoStatePollActive");
	});

	it("a container change switches status sync off", async () => {
		mocks.tables.project = [jiraMcpRow({ pmStatusSyncEnabled: true })];
		await call({
			id: "proj-jira",
			projectManagementMcpServerId: "srv-atlassian",
			projectManagementMcpConfigId: "cfg-jira-1",
			projectManagementContainerId: "OTHER",
		});

		expect(writtenData().pmStatusSyncEnabled).toBe(false);
	});

	it("turning the switch on in the same request as a container change still leaves it off", async () => {
		await call({
			id: "proj-jira",
			projectManagementMcpServerId: "srv-atlassian",
			projectManagementMcpConfigId: "cfg-jira-1",
			projectManagementContainerId: "OTHER",
			pmStatusSyncEnabled: true,
		});

		expect(mocks.transaction).not.toHaveBeenCalled();
		const data = writtenData();
		expect(data.pmStatusSyncEnabled).toBe(false);
		expect(data).not.toHaveProperty("pmStatusSyncSessionAt");
	});

	it("refuses to turn status sync on for GitLab over MCP", async () => {
		// Positive control: the same request on the REST GitLab project succeeds.
		await call({ id: "proj-rest", pmStatusSyncEnabled: true });
		expect(mocks.transaction).toHaveBeenCalledTimes(1);

		await expect(
			call({ id: "proj-gitlab-mcp", pmStatusSyncEnabled: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.updateProject).not.toHaveBeenCalled();
	});

	it("resolves a key: sentinel server id when refusing GitLab over MCP", async () => {
		mocks.tables.project = [
			gitLabMcpRow({
				projectManagementMcpServerId: "key:gitlab-official",
			}),
		];
		await expect(
			call({ id: "proj-gitlab-mcp", pmStatusSyncEnabled: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("a re-save that makes the source GitLab over MCP switches status sync off", async () => {
		// The switch is stored ON for a GitLab-over-MCP source (set before
		// the refusal existed, or by another writer), and the save re-sends
		// that SAME server, config and container. So it is neither a
		// disconnect nor a PM-source change: only the GitLab-over-MCP check,
		// which reads the server's key, can force the switch off here.
		const gitLabMcpResave = {
			projectManagementMcpServerId: "srv-gitlab-official",
			projectManagementMcpConfigId: "cfg-gitlab-mcp",
			projectManagementContainerId: "4242",
			projectManagementContainerName: "4242",
			projectManagementAdditionalContext: LABEL_MAP_CONTEXT,
		};

		// Positive control: the identical re-save of a Jira-over-MCP source
		// with the switch on leaves the switch alone.
		mocks.tables.project = [jiraMcpRow({ pmStatusSyncEnabled: true })];
		await call({
			id: "proj-jira",
			projectManagementMcpServerId: "srv-atlassian",
			projectManagementMcpConfigId: "cfg-jira-1",
			projectManagementContainerId: "EXAMPLE",
		});
		expect(mocks.updateProject).toHaveBeenCalledTimes(1);
		expect(mocks.updateProject.mock.calls[0][2]).not.toHaveProperty(
			"pmStatusSyncEnabled",
		);
		mocks.updateProject.mockClear();

		mocks.tables.project = [gitLabMcpRow({ pmStatusSyncEnabled: true })];
		await call({ id: "proj-gitlab-mcp", ...gitLabMcpResave });

		const data = writtenData();
		expect(data).toMatchObject({
			projectManagementMcpConfigId: "cfg-gitlab-mcp",
			pmStatusSyncEnabled: false,
		});
		// Not the disconnect path: the poll and attachment sync are untouched.
		expect(data).not.toHaveProperty("adoStatePollActive");
		expect(data).not.toHaveProperty("syncAttachments");
	});
});

describe("D1.5 — off → on starts a fresh session in one transaction", () => {
	it("saves the switch, stamps the session, clears the summary and resets every story's base", async () => {
		mocks.tables.project = [restGitLabRow({ adoStatePollActive: false })];
		await call({ id: "proj-rest", pmStatusSyncEnabled: true });

		expect(transactionOps()).toEqual([
			{
				op: "project.update",
				projectId: "proj-rest",
				organizationId: "org-1",
				data: {
					adoStatePollActive: true,
					pmStatusSyncEnabled: true,
					pmStatusSyncSessionAt: NOW,
					pmStatusSyncLastRun: mocks.DB_NULL,
				},
			},
			STORY_BASE_RESET,
		]);
		expect(mocks.updateProject).not.toHaveBeenCalled();
		expect(mocks.projectUpdate).not.toHaveBeenCalled();
	});

	it("carries a governance change in the same transaction", async () => {
		await call({
			id: "proj-rest",
			pmStatusSyncEnabled: true,
			enforceSpecifyGate: true,
		});

		expect(transactionOps()).toEqual([
			{
				op: "project.update",
				projectId: "proj-rest",
				organizationId: "org-1",
				data: {
					enforceSpecifyGate: true,
					pmStatusSyncEnabled: true,
					pmStatusSyncSessionAt: NOW,
					pmStatusSyncLastRun: mocks.DB_NULL,
				},
			},
			STORY_BASE_RESET,
			{
				op: "projectActivity.create",
				args: {
					data: {
						projectId: "proj-rest",
						userId: "owner-1",
						userName: "Actor",
						activityType: "governance_changed",
						resourceType: "project",
						resourceId: "proj-rest",
						resourceName: "Widgets",
						organizationId: "org-1",
						metadata: {
							changed: {
								enforceSpecifyGate: {
									before: false,
									after: true,
								},
							},
						},
					},
				},
			},
		]);
		expect(mocks.projectUpdate).not.toHaveBeenCalled();
	});

	it("re-sending true while the switch is on starts no new session", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		await call({ id: "proj-rest", pmStatusSyncEnabled: true });

		const data = writtenData();
		expect(data.pmStatusSyncEnabled).toBe(true);
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(data).not.toHaveProperty("pmStatusSyncSessionAt");
		expect(data).not.toHaveProperty("pmStatusSyncLastRun");
	});
});

describe("D1.6 — permissions", () => {
	it("refuses an editor turning status sync on, and allows an admin", async () => {
		mocks.resolveAccess.mockResolvedValue(ADMIN);
		await call({ id: "proj-rest", pmStatusSyncEnabled: true }, "admin-1");
		expect(mocks.transaction).toHaveBeenCalledTimes(1);

		mocks.resolveAccess.mockResolvedValue(EDITOR);
		await expect(
			call({ id: "proj-rest", pmStatusSyncEnabled: true }, "editor-1"),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message:
				"Only project admins or owners can change status sync with the PM tool.",
		});
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
	});

	it("refuses an editor turning status sync off", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		mocks.resolveAccess.mockResolvedValue(EDITOR);
		await expect(
			call({ id: "proj-rest", pmStatusSyncEnabled: false }, "editor-1"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateProject).not.toHaveBeenCalled();
	});

	it("refuses an editor changing the label map while status sync is on, but not re-saving it unchanged", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		mocks.resolveAccess.mockResolvedValue(EDITOR);

		// Positive control: the identical map, keys in a different order.
		await call(
			{
				id: "proj-rest",
				...restSave("4242", {
					projectManagementAdditionalContext: {
						labelStatusMap: {
							"workflow::done": "status-done",
							"workflow::in-review": "status-in-progress",
						},
					},
				}),
			},
			"editor-1",
		);
		expect(mocks.updateProject).toHaveBeenCalledTimes(1);
		expect(mocks.resolveAccess).not.toHaveBeenCalled();

		await expect(
			call(
				{
					id: "proj-rest",
					...restSave("4242", {
						projectManagementAdditionalContext: {
							labelStatusMap: {
								"workflow::in-review": "status-done",
							},
						},
					}),
				},
				"editor-1",
			),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message:
				"Only project admins or owners can change the label → status map while status sync is on.",
		});
		expect(mocks.updateProject).toHaveBeenCalledTimes(1);
	});

	it("lets an editor disconnect the PM tool while status sync is on — the switch is forced off, so the cleared map moves nothing", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		mocks.resolveAccess.mockResolvedValue(EDITOR);

		// Positive control: on the same stored row, a map change that keeps the
		// PM source IS refused for this editor.
		await expect(
			call(
				{
					id: "proj-rest",
					...restSave("4242", {
						projectManagementAdditionalContext: {
							labelStatusMap: {
								"workflow::in-review": "status-done",
							},
						},
					}),
				},
				"editor-1",
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.resolveAccess).toHaveBeenCalledTimes(1);

		// "None": the disconnect clears the map, and D1.4 forces the switch off.
		await call(
			{
				id: "proj-rest",
				projectManagementMcpServerId: null,
				projectManagementMcpConfigId: null,
				projectManagementContainerId: null,
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			},
			"editor-1",
		);

		expect(writtenData()).toMatchObject({
			projectManagementContainerId: null,
			projectManagementAdditionalContext: null,
			adoStatePollActive: false,
			pmStatusSyncEnabled: false,
		});
		// No admin check ran for the disconnect.
		expect(mocks.resolveAccess).toHaveBeenCalledTimes(1);
	});

	it("lets an editor change the label map while status sync is off", async () => {
		mocks.resolveAccess.mockResolvedValue(EDITOR);
		await call(
			{
				id: "proj-rest",
				...restSave("4242", {
					projectManagementAdditionalContext: {
						labelStatusMap: {
							"workflow::in-review": "status-done",
						},
					},
				}),
			},
			"editor-1",
		);

		expect(writtenData().projectManagementAdditionalContext).toEqual({
			labelStatusMap: { "workflow::in-review": "status-done" },
		});
		expect(mocks.resolveAccess).not.toHaveBeenCalled();
	});

	it("resolves no permissions for an unrelated edit", async () => {
		mocks.tables.project = [restGitLabRow({ pmStatusSyncEnabled: true })];
		await call({ id: "proj-rest", name: "Renamed" });

		expect(writtenData().name).toBe("Renamed");
		expect(mocks.resolveAccess).not.toHaveBeenCalled();
	});
});
