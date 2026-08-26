/**
 * Publish / unpublish / rollback lifecycle.
 *
 * These three procedures were the only workflow mutations that did not go
 * through `hasWorkflowAccess`. They hand-rolled their own check, and that
 * check accepted *organization membership alone* — while every read path
 * (`get`, `versions.list`, `executions.start`) additionally requires
 * ownership, because a workflow stays user-owned inside an organization.
 *
 * The gap was reachable, not theoretical: `requirePermission` short-circuits
 * in personal context, so a colleague acting from their personal workspace
 * passed the middleware untouched and then satisfied a membership-only test
 * against a workflow they could not even open. They could publish someone
 * else's unfinished draft, stop a live one, or roll one back over its
 * author's current graph.
 *
 * Each authorization case therefore asserts *no write happened*, not merely
 * that something was thrown — a procedure that mutates and then throws would
 * still have done the damage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	accessMock,
	workflowFindUniqueMock,
	workflowUpdateMock,
	versionCreateMock,
	versionFindUniqueMock,
	versionFindFirstMock,
	memberFindFirstMock,
	syncScheduleMock,
	findScheduleCronMock,
} = vi.hoisted(() => ({
	accessMock: vi.fn(),
	workflowFindUniqueMock: vi.fn(),
	workflowUpdateMock: vi.fn(),
	versionCreateMock: vi.fn(),
	versionFindUniqueMock: vi.fn(),
	versionFindFirstMock: vi.fn(),
	memberFindFirstMock: vi.fn(),
	syncScheduleMock: vi.fn(),
	findScheduleCronMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflow: {
			findUnique: workflowFindUniqueMock,
			update: workflowUpdateMock,
		},
		workflowVersion: {
			create: versionCreateMock,
			findUnique: versionFindUniqueMock,
			findFirst: versionFindFirstMock,
		},
		member: { findFirst: memberFindFirstMock },
	},
	hasWorkflowAccess: accessMock,
}));

vi.mock("@repo/temporal", () => ({
	findScheduleCron: findScheduleCronMock,
}));

// Encryption is modelled as a reversible wrapper rather than stubbed to
// identity: an identity `decryptApiKeyMaybe` would make "the secret came back
// in plaintext" and "the ciphertext leaked to the client" look identical.
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `enc(${value})`,
	decryptApiKeyMaybe: (value: string | null) =>
		typeof value === "string" && value.startsWith("enc(")
			? value.slice(4, -1)
			: value,
}));

vi.mock("../../../lib/sync-workflow-schedule", () => ({
	syncWorkflowSchedule: syncScheduleMock,
}));

vi.mock("../../../../../orpc/procedures", () => ({
	Permissions: { WORKSPACE_UPDATE: "workspace:update" },
	requirePermission: () => (next: unknown) => next,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { publishWorkflow } from "../publish-workflow";
import { rollbackWorkflow } from "../rollback-workflow";
import { unpublishWorkflow } from "../unpublish-workflow";

// The procedure builder is stubbed above, so each export is its bare handler.
const publish = publishWorkflow as any;
const unpublish = unpublishWorkflow as any;
const rollback = rollbackWorkflow as any;

const OWNER = "user-owner";
const COLLEAGUE = "user-colleague";
const ORG = "org-1";

/** The graph stored on version 1 — carries a Schedule trigger. */
const RESTORED_NODES = [
	{
		id: "n1",
		type: "trigger",
		data: {
			config: { triggerType: "schedule", scheduleCron: "0 9 * * *" },
		},
	},
];

/** A published, org-owned workflow belonging to OWNER. */
function orgWorkflow(overrides: Record<string, unknown> = {}) {
	return {
		id: "wf-1",
		name: "Nightly sync",
		userId: OWNER,
		organizationId: ORG,
		projectId: "proj-1",
		status: "PUBLISHED",
		version: 3,
		nodes: [{ id: "n1", type: "trigger", data: { config: {} } }],
		edges: [],
		variables: null,
		settings: null,
		triggerConfig: null,
		triggerType: "MANUAL",
		webhookSecret: null,
		versions: [{ version: 3 }],
		...overrides,
	};
}

function ctx(userId: string) {
	return { user: { id: userId }, session: {} };
}

beforeEach(() => {
	vi.clearAllMocks();
	accessMock.mockResolvedValue(true);
	workflowFindUniqueMock.mockResolvedValue(orgWorkflow());
	workflowUpdateMock.mockImplementation(
		async ({ data }: { data: object }) => ({ ...orgWorkflow(), ...data }),
	);
	versionCreateMock.mockResolvedValue({ id: "ver-new" });
	versionFindFirstMock.mockResolvedValue({ version: 3 });
	versionFindUniqueMock.mockResolvedValue({
		workflowId: "wf-1",
		version: 1,
		nodes: RESTORED_NODES,
		edges: [],
		variables: null,
		settings: null,
		triggerConfig: null,
	});
	// The colleague IS a member of the org — that used to be enough on its own.
	memberFindFirstMock.mockResolvedValue({ id: "member-1" });
	syncScheduleMock.mockResolvedValue({ outcome: "none", reason: "test" });
	findScheduleCronMock.mockReturnValue(null);
});

/** No write of any kind reached the database. */
function expectNoMutation() {
	expect(workflowUpdateMock).not.toHaveBeenCalled();
	expect(versionCreateMock).not.toHaveBeenCalled();
}

describe("ownership is required, not just org membership", () => {
	beforeEach(() => {
		// The shared gate: an org member who does not own the workflow gets
		// false, exactly as `get` and `executions.start` already see it.
		accessMock.mockResolvedValue(false);
	});

	it("publish refuses a non-owner org member and writes nothing", async () => {
		await expect(
			publish({ input: { workflowId: "wf-1" }, context: ctx(COLLEAGUE) }),
		).rejects.toThrow();

		expect(accessMock).toHaveBeenCalledWith("wf-1", COLLEAGUE);
		expectNoMutation();
	});

	it("unpublish refuses a non-owner org member and writes nothing", async () => {
		await expect(
			unpublish({
				input: { workflowId: "wf-1" },
				context: ctx(COLLEAGUE),
			}),
		).rejects.toThrow();

		expect(accessMock).toHaveBeenCalledWith("wf-1", COLLEAGUE);
		expectNoMutation();
		// Nor may it quietly stop the schedule on the way out.
		expect(syncScheduleMock).not.toHaveBeenCalled();
	});

	it("rollback refuses a non-owner org member and writes nothing", async () => {
		await expect(
			rollback({
				input: { workflowId: "wf-1", targetVersion: 1 },
				context: ctx(COLLEAGUE),
			}),
		).rejects.toThrow();

		expect(accessMock).toHaveBeenCalledWith("wf-1", COLLEAGUE);
		expectNoMutation();
	});

	it("the owner is still allowed through", async () => {
		accessMock.mockResolvedValue(true);

		const result = await unpublish({
			input: { workflowId: "wf-1" },
			context: ctx(OWNER),
		});

		expect(result.success).toBe(true);
		expect(workflowUpdateMock).toHaveBeenCalled();
	});
});

describe("rollback", () => {
	it("stamps the parent workflow's tenant onto the new version row", async () => {
		await rollback({
			input: { workflowId: "wf-1", targetVersion: 1 },
			context: ctx(OWNER),
		});

		// `workflow_version` carries a `user_owned` RLS policy keyed on these
		// two columns. A row with both NULL matches neither the organization
		// branch nor the personal branch, so the version history that is
		// supposed to list it cannot see it.
		expect(versionCreateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: OWNER,
					organizationId: ORG,
				}),
			}),
		);
	});

	it("re-syncs the schedule against the graph it restored", async () => {
		await rollback({
			input: { workflowId: "wf-1", targetVersion: 1 },
			context: ctx(OWNER),
		});

		expect(syncScheduleMock).toHaveBeenCalledTimes(1);

		const [args] = syncScheduleMock.mock.calls[0];
		expect(args.workflowId).toBe("wf-1");
		expect(args.active).toBe(true);
		// The restored graph, not the one that was live before the rollback —
		// the cron is read off this graph's trigger node, so passing the old
		// one would leave the previous schedule firing.
		expect(args.nodes).toEqual(RESTORED_NODES);
	});

	it("does not make a draft's schedule live", async () => {
		workflowFindUniqueMock.mockResolvedValue(
			orgWorkflow({ status: "DRAFT" }),
		);

		await rollback({
			input: { workflowId: "wf-1", targetVersion: 1 },
			context: ctx(OWNER),
		});

		expect(syncScheduleMock).toHaveBeenCalledWith(
			expect.objectContaining({ active: false }),
		);
	});

	it("reports a missing target version rather than mutating", async () => {
		versionFindUniqueMock.mockResolvedValue(null);

		await expect(
			rollback({
				input: { workflowId: "wf-1", targetVersion: 99 },
				context: ctx(OWNER),
			}),
		).rejects.toThrow(/99/);

		expectNoMutation();
	});
});

describe("publish", () => {
	/** The `data` object the workflow row was updated with. */
	function updatedWith() {
		return workflowUpdateMock.mock.calls[0][0].data;
	}

	it("refuses a graph that fails validation, without writing a version", async () => {
		workflowFindUniqueMock.mockResolvedValue(orgWorkflow({ nodes: [] }));

		const result = await publish({
			input: { workflowId: "wf-1" },
			context: ctx(OWNER),
		});

		expect(result.success).toBe(false);
		expect(result.validation.errors.join(" ")).toContain("no nodes");
		expectNoMutation();
	});

	it("encrypts a freshly minted webhook secret at rest, and returns it once in plaintext", async () => {
		const result = await publish({
			input: { workflowId: "wf-1", enableWebhook: true },
			context: ctx(OWNER),
		});

		// Stored encrypted (SOC 2 CC6.1); handed back once so the author can
		// copy it, because nothing can recover it afterwards.
		expect(updatedWith().webhookSecret).toMatch(/^enc\(whsec_/);
		expect(result.webhookSecret).toMatch(/^whsec_/);
		expect(result.webhookUrl).toContain("/api/workflows/trigger/wf-1");
	});

	it("does not re-encrypt a secret that already exists", async () => {
		// `existingSecret` is already ciphertext. Re-encrypting on republish
		// would double-wrap it and every previously-issued signature would
		// start failing verification.
		workflowFindUniqueMock.mockResolvedValue(
			orgWorkflow({ webhookSecret: "enc(whsec_original)" }),
		);

		const result = await publish({
			input: { workflowId: "wf-1", enableWebhook: true },
			context: ctx(OWNER),
		});

		expect(updatedWith().webhookSecret).toBe("enc(whsec_original)");
		// Decrypted for the response, never handed back as ciphertext.
		expect(result.webhookSecret).toBe("whsec_original");
	});

	it("leaves the stored secret alone when webhooks are not requested", async () => {
		workflowFindUniqueMock.mockResolvedValue(
			orgWorkflow({ webhookSecret: "enc(whsec_original)" }),
		);

		const result = await publish({
			input: { workflowId: "wf-1" },
			context: ctx(OWNER),
		});

		expect(updatedWith().webhookSecret).toBe("enc(whsec_original)");
		// Not echoed back on a publish that did not ask for a webhook.
		expect(result.webhookSecret).toBeUndefined();
		expect(result.webhookUrl).toBeUndefined();
	});

	it("switches the trigger to WEBHOOK when a webhook is requested", async () => {
		await publish({
			input: { workflowId: "wf-1", enableWebhook: true },
			context: ctx(OWNER),
		});

		expect(updatedWith().triggerType).toBe("WEBHOOK");
		expect(updatedWith().status).toBe("PUBLISHED");
	});

	it("switches the trigger to SCHEDULE when the graph carries a cron", async () => {
		findScheduleCronMock.mockReturnValue("0 9 * * *");

		await publish({
			input: { workflowId: "wf-1" },
			context: ctx(OWNER),
		});

		expect(updatedWith().triggerType).toBe("SCHEDULE");
	});

	it("lets an explicit webhook request win over a leftover cron", async () => {
		// A cron still sitting on the trigger node is not a deliberate act;
		// asking for a webhook is.
		findScheduleCronMock.mockReturnValue("0 9 * * *");

		await publish({
			input: { workflowId: "wf-1", enableWebhook: true },
			context: ctx(OWNER),
		});

		expect(updatedWith().triggerType).toBe("WEBHOOK");
	});

	it("stamps the parent tenant onto the published version row", async () => {
		await publish({
			input: { workflowId: "wf-1" },
			context: ctx(OWNER),
		});

		expect(versionCreateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: OWNER,
					organizationId: ORG,
					isPublished: true,
				}),
			}),
		);
	});
});
