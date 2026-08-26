/**
 * `hasWorkflowAccess` and `getWorkflowById` — the tenancy rule every workflow
 * path resolves through.
 *
 * The rule is easy to state and easy to get wrong: a workflow is **user-owned
 * even inside an organization**, so membership alone is never sufficient. The
 * publish, unpublish and rollback procedures used to accept membership on its
 * own, which let a colleague act on a workflow they could not open.
 *
 * Those procedures now call `hasWorkflowAccess`, and their own tests mock it —
 * which proves they consult the gate but says nothing about whether the gate
 * is right. This file exercises the real function, so the two halves together
 * cover the claim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowFindFirstMock = vi.fn();
const workflowFindManyMock = vi.fn();
const workflowCountMock = vi.fn();
const workflowCreateMock = vi.fn();
const memberFindFirstMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		workflow: {
			findFirst: (args: unknown) => workflowFindFirstMock(args),
			findMany: (args: unknown) => workflowFindManyMock(args),
			count: (args: unknown) => workflowCountMock(args),
			create: (args: unknown) => workflowCreateMock(args),
		},
		member: { findFirst: (args: unknown) => memberFindFirstMock(args) },
	},
}));

import {
	duplicateWorkflow,
	getWorkflowById,
	hasWorkflowAccess,
	listWorkflows,
} from "../prisma/queries/workflows/workflows";

const OWNER = "user-owner";
const COLLEAGUE = "user-colleague";
const ORG = "org-1";

beforeEach(() => {
	vi.clearAllMocks();
	memberFindFirstMock.mockResolvedValue(null);
	workflowFindManyMock.mockResolvedValue([]);
	workflowCountMock.mockResolvedValue(0);
	workflowCreateMock.mockImplementation(async (args: { data: object }) => ({
		id: "wf-copy",
		...args.data,
	}));
});

describe("hasWorkflowAccess", () => {
	it("refuses a workflow that does not exist", async () => {
		workflowFindFirstMock.mockResolvedValue(null);

		expect(await hasWorkflowAccess("missing", OWNER)).toBe(false);
	});

	it("allows the owner of a personal workflow", async () => {
		workflowFindFirstMock.mockResolvedValue({
			id: "wf-1",
			userId: OWNER,
			organizationId: null,
		});

		expect(await hasWorkflowAccess("wf-1", OWNER)).toBe(true);
	});

	it("refuses anyone else on a personal workflow, without consulting membership", async () => {
		workflowFindFirstMock.mockResolvedValue({
			id: "wf-1",
			userId: OWNER,
			organizationId: null,
		});

		expect(await hasWorkflowAccess("wf-1", COLLEAGUE)).toBe(false);
		// A personal workflow has no organization to be a member of; asking
		// would be a bug waiting to become a bypass.
		expect(memberFindFirstMock).not.toHaveBeenCalled();
	});

	it("refuses a non-member on an organization workflow", async () => {
		workflowFindFirstMock.mockResolvedValue({
			id: "wf-1",
			userId: OWNER,
			organizationId: ORG,
		});
		memberFindFirstMock.mockResolvedValue(null);

		expect(await hasWorkflowAccess("wf-1", COLLEAGUE)).toBe(false);
	});

	it("refuses an org member who does not own the workflow", async () => {
		// The case the publish lifecycle used to allow. Membership is
		// necessary, never sufficient.
		workflowFindFirstMock.mockResolvedValue({
			id: "wf-1",
			userId: OWNER,
			organizationId: ORG,
		});
		memberFindFirstMock.mockResolvedValue({ id: "member-row" });

		expect(await hasWorkflowAccess("wf-1", COLLEAGUE)).toBe(false);
	});

	it("allows an org member who owns the workflow", async () => {
		workflowFindFirstMock.mockResolvedValue({
			id: "wf-1",
			userId: OWNER,
			organizationId: ORG,
		});
		memberFindFirstMock.mockResolvedValue({ id: "member-row" });

		expect(await hasWorkflowAccess("wf-1", OWNER)).toBe(true);
	});

	it("checks membership of the workflow's organization, not one the caller picked", async () => {
		workflowFindFirstMock.mockResolvedValue({
			id: "wf-1",
			userId: OWNER,
			organizationId: ORG,
		});
		memberFindFirstMock.mockResolvedValue({ id: "member-row" });

		await hasWorkflowAccess("wf-1", OWNER);

		expect(memberFindFirstMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: ORG, userId: OWNER },
			}),
		);
	});
});

describe("getWorkflowById tenant filter", () => {
	it("scopes an organization read to that organization and the owner", async () => {
		workflowFindFirstMock.mockResolvedValue(null);

		await getWorkflowById("wf-1", OWNER, ORG);

		const [args] = workflowFindFirstMock.mock.calls[0];
		expect(args.where).toMatchObject({
			id: "wf-1",
			userId: OWNER,
			organizationId: ORG,
		});
	});

	it("pins organizationId to null for a personal read", async () => {
		workflowFindFirstMock.mockResolvedValue(null);

		await getWorkflowById("wf-1", OWNER);

		// The explicit null is the XOR rule: omitting it would let an
		// organization workflow satisfy a personal-context read.
		const [args] = workflowFindFirstMock.mock.calls[0];
		expect(args.where).toMatchObject({
			id: "wf-1",
			userId: OWNER,
			organizationId: null,
		});
	});
});

describe("listWorkflows tenant filter", () => {
	it("scopes an organization listing to that organization", async () => {
		await listWorkflows({ userId: OWNER, organizationId: ORG });

		const [args] = workflowFindManyMock.mock.calls[0];
		expect(args.where).toMatchObject({
			userId: OWNER,
			organizationId: ORG,
		});
	});

	it("pins organizationId to null for a personal listing", async () => {
		await listWorkflows({ userId: OWNER });

		// Without the explicit null this is the classic leak: a personal list
		// would include every organization workflow the user owns.
		const [args] = workflowFindManyMock.mock.calls[0];
		expect(args.where).toMatchObject({
			userId: OWNER,
			organizationId: null,
		});
	});

	it("counts against the same filter it lists with", async () => {
		await listWorkflows({ userId: OWNER });

		// A count computed over a wider filter than the page query is how a
		// list ends up claiming more rows than it can ever show.
		const [listArgs] = workflowFindManyMock.mock.calls[0];
		const [countArgs] = workflowCountMock.mock.calls[0];
		expect(countArgs.where).toEqual(listArgs.where);
	});
});

describe("duplicateWorkflow", () => {
	const source = {
		id: "wf-1",
		name: "Nightly sync",
		description: "d",
		triggerType: "WEBHOOK",
		triggerConfig: null,
		nodes: [{ id: "n1" }],
		edges: [],
		variables: null,
		settings: null,
		isTemplate: false,
		templateId: null,
		projectId: "proj-1",
	};

	it("reads the source through the tenant filter", async () => {
		workflowFindFirstMock.mockResolvedValue(source);

		await duplicateWorkflow("wf-1", OWNER, undefined, ORG);

		const [args] = workflowFindFirstMock.mock.calls[0];
		expect(args.where).toMatchObject({
			id: "wf-1",
			userId: OWNER,
			organizationId: ORG,
		});
	});

	it("refuses to duplicate a workflow the caller cannot see", async () => {
		workflowFindFirstMock.mockResolvedValue(null);

		await expect(
			duplicateWorkflow("wf-1", COLLEAGUE, undefined, ORG),
		).rejects.toThrow(/not found/i);
		expect(workflowCreateMock).not.toHaveBeenCalled();
	});

	it("copies the graph into a fresh DRAFT owned by the caller", async () => {
		workflowFindFirstMock.mockResolvedValue(source);

		await duplicateWorkflow("wf-1", OWNER, undefined, ORG);

		const [args] = workflowCreateMock.mock.calls[0];
		expect(args.data).toMatchObject({
			name: "Nightly sync (Copy)",
			status: "DRAFT",
			userId: OWNER,
			organizationId: ORG,
			nodes: source.nodes,
			isTemplate: false,
		});
	});

	it("never carries the source's published state onto the copy", async () => {
		workflowFindFirstMock.mockResolvedValue({
			...source,
			status: "PUBLISHED",
			publishedVersion: 7,
			webhookSecret: "enc(whsec_original)",
		});

		await duplicateWorkflow("wf-1", OWNER, undefined, ORG);

		// A copy that inherited the webhook secret would let the duplicate be
		// triggered by the original's credentials.
		const [args] = workflowCreateMock.mock.calls[0];
		expect(args.data.status).toBe("DRAFT");
		expect(args.data.webhookSecret).toBeUndefined();
		expect(args.data.publishedVersion).toBeUndefined();
	});

	it("honours an explicit new name", async () => {
		workflowFindFirstMock.mockResolvedValue(source);

		await duplicateWorkflow("wf-1", OWNER, "My copy", ORG);

		const [args] = workflowCreateMock.mock.calls[0];
		expect(args.data.name).toBe("My copy");
	});
});
