import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	edit: vi.fn(),
	project: vi.fn(),
	projectAccess: vi.fn(),
	projectWrite: vi.fn(),
	manage: vi.fn(),
	execution: vi.fn(),
	locked: vi.fn(),
	update: vi.fn(),
	lock: vi.fn(),
	audit: vi.fn(),
	stateWrite: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: m.project },
		workflowExecution: { findFirst: m.execution },
		$transaction: async (callback: any) =>
			callback({
				$queryRaw: m.lock,
				workflow: { findFirst: m.locked, update: m.update },
			}),
	},
	hasProjectAccess: m.projectAccess,
	canUpdateOrganizationWorkflows: m.manage,
	canEditProject: m.manage,
	recordAuditTx: m.audit,
	writeWorkflowRunState: async (tx: any, input: any) => {
		m.stateWrite(tx, input);
		return m.update({
			where: { id: input.workflowId },
			data: { settings: input.settings },
		});
	},
}));
vi.mock("../workflow-command-context", async () => {
	const actual = await vi.importActual<any>("../workflow-command-context");
	return {
		...actual,
		loadReadableWorkflow: m.read,
		loadEditableWorkflow: m.edit,
		requireWritableProject: m.projectWrite,
	};
});

import {
	applyWorkflowCheck,
	inspectWorkflowResult,
	listWorkflowChecks,
	previewWorkflowCheck,
	removeWorkflowCheck,
	saveWorkflowCheck,
} from "../workflow-result-checks";

const actor = { userId: "example-user", organizationId: "example-org" };
const identity = {
	workflowId: "example-workflow",
	executionId: "example-baseline",
	nodeId: "draft",
};
let workflow: any;
beforeEach(() => {
	vi.clearAllMocks();
	workflow = {
		id: identity.workflowId,
		...actor,
		projectId: null,
		settings: {
			publishFrameIds: { publish: "example-frame" },
			consecutiveFailures: 3,
		},
	};
	m.read.mockImplementation(async () => workflow);
	m.edit.mockImplementation(async () => workflow);
	m.locked.mockImplementation(async () => workflow);
	m.manage.mockResolvedValue(true);
	m.project.mockResolvedValue({ id: "example-project" });
	m.projectAccess.mockResolvedValue(true);
	m.execution.mockImplementation(async ({ where }: any) => ({
		id: where.id,
		status: "COMPLETED",
		version: where.id === "example-baseline" ? 1 : 2,
		completedAt: new Date("2026-01-01"),
		logs: [
			{
				status: "COMPLETED",
				nodeType: "ai-generate-text",
				output: {
					markdown:
						where.id === "example-baseline"
							? "# Next steps\nAccessibility review is pending."
							: "# Update\nNo risks remain.",
					text: "shortened preview",
				},
			},
		],
	}));
	m.update.mockImplementation(async ({ data }: any) => {
		workflow = { ...workflow, ...data };
		return workflow;
	});
});
async function passing() {
	const inspected = await inspectWorkflowResult(actor, identity);
	return {
		...identity,
		expectedRevision: inspected.revision,
		requiredPhrases: ["Next steps", "Accessibility"],
		forbiddenPhrases: ["No risks remain"],
	};
}
it("loads exact markdown from a completed tenant-owned step, never a shortened preview", async () => {
	const result = await inspectWorkflowResult(actor, identity);
	expect(result.recordedAnswer).toContain("Accessibility");
	expect(result.recordedAnswer).not.toBe("shortened preview");
	expect(m.execution).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				id: identity.executionId,
				workflowId: identity.workflowId,
				...actor,
			},
			select: expect.objectContaining({
				logs: expect.objectContaining({
					where: { nodeId: identity.nodeId },
					take: 1,
				}),
			}),
		}),
	);
});
it("fails current authority before loading any evidence", async () => {
	m.read.mockRejectedValueOnce(new Error("Current permission required"));
	await expect(inspectWorkflowResult(actor, identity)).rejects.toThrow(
		"Current permission",
	);
	expect(m.execution).not.toHaveBeenCalled();
});
it("requires current access to the workflow's hosted project", async () => {
	workflow.projectId = "example-project";
	m.projectAccess.mockResolvedValue(false);
	await expect(inspectWorkflowResult(actor, identity)).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	expect(m.execution).not.toHaveBeenCalled();
});
it.each(["RUNNING", "FAILED"])(
	"does not grade an incomplete or failed %s run",
	async (status) => {
		m.execution.mockResolvedValue({
			id: identity.executionId,
			status,
			logs: [],
		});
		await expect(
			inspectWorkflowResult(actor, identity),
		).rejects.toMatchObject({ code: "CONFLICT" });
	},
);
it("never truncates a result to obtain a passing score", async () => {
	m.execution.mockResolvedValue({
		id: identity.executionId,
		status: "COMPLETED",
		version: 1,
		logs: [{ status: "COMPLETED", output: { text: "x".repeat(16385) } }],
	});
	await expect(inspectWorkflowResult(actor, identity)).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
});
it("refuses client answer/authority overrides and changed result revisions", async () => {
	await expect(
		inspectWorkflowResult(actor, {
			...identity,
			recordedAnswer: "pretend",
		}),
	).rejects.toThrow();
	const input = await passing();
	await expect(
		previewWorkflowCheck(actor, {
			...input,
			expectedRevision: "0".repeat(64),
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(m.update).not.toHaveBeenCalled();
});
it("saves a passing baseline under the row lock and preserves the latest runtime state", async () => {
	const input = await passing();
	m.locked.mockResolvedValueOnce({
		...workflow,
		settings: {
			...workflow.settings,
			publishFrameIds: { publish: "example-new-frame" },
			consecutiveFailures: 4,
		},
	});
	const result = await saveWorkflowCheck(actor, {
		...input,
		name: "Delivery evidence",
	});
	expect(result.check.baselineVersion).toBe(1);
	expect(m.lock).toHaveBeenCalled();
	expect(m.update.mock.calls[0][0].data.settings).toMatchObject({
		publishFrameIds: { publish: "example-new-frame" },
		consecutiveFailures: 4,
	});
	expect(
		JSON.stringify(m.update.mock.calls[0][0].data.settings),
	).not.toContain("# Next steps");
	expect(m.audit).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			action: "activity.workflows.checks.created",
			metadata: { checkId: result.check.id },
		}),
	);
});
it("deduplicates a repeated save without another mutation or audit", async () => {
	const input = { ...(await passing()), name: "Delivery evidence" };
	const first = await saveWorkflowCheck(actor, input);
	await saveWorkflowCheck(actor, input);
	expect(m.update).toHaveBeenCalledOnce();
	expect(m.audit).toHaveBeenCalledOnce();
	expect(
		(await listWorkflowChecks(actor, { workflowId: identity.workflowId }))
			.cases[0].id,
	).toBe(first.check.id);
});
it("does not save a failing baseline", async () => {
	const input = await passing();
	await expect(
		saveWorkflowCheck(actor, {
			...input,
			name: "Incorrect baseline",
			requiredPhrases: ["does not exist"],
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(m.update).not.toHaveBeenCalled();
});
it("compares two actual versions using the same saved expectations and detects regression", async () => {
	const { check } = await saveWorkflowCheck(actor, {
		...(await passing()),
		name: "Delivery evidence",
	});
	const result = await applyWorkflowCheck(actor, {
		workflowId: identity.workflowId,
		checkId: check.id,
		expectedCaseRevision: check.revision,
		executionId: "example-candidate",
	});
	expect(result.baseline).toMatchObject({ version: 1, status: "passed" });
	expect(result.candidate).toMatchObject({
		version: 2,
		report: { status: "failed" },
	});
	expect(result.change).toBe("regressed");
	expect(result.targetInvoked).toBe(false);
});
it("requires write permission to persist or remove a check even when reads work", async () => {
	const input = await passing();
	m.edit.mockRejectedValueOnce(
		new Error("Current write permission required"),
	);
	await expect(
		saveWorkflowCheck(actor, { ...input, name: "Delivery evidence" }),
	).rejects.toThrow("Current write");
	expect(m.update).not.toHaveBeenCalled();
});
it("removes only the selected immutable check and leaves the baseline run intact", async () => {
	const { check } = await saveWorkflowCheck(actor, {
		...(await passing()),
		name: "Delivery evidence",
	});
	await expect(
		removeWorkflowCheck(actor, {
			workflowId: identity.workflowId,
			checkId: check.id,
			expectedCaseRevision: "0".repeat(64),
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await removeWorkflowCheck(actor, {
		workflowId: identity.workflowId,
		checkId: check.id,
		expectedCaseRevision: check.revision,
	});
	expect(
		(await listWorkflowChecks(actor, { workflowId: identity.workflowId }))
			.cases,
	).toEqual([]);
	expect(workflow.settings.publishFrameIds.publish).toBe("example-frame");
});
it("fails closed on unknown saved-check data instead of erasing it", async () => {
	workflow.settings.fabricResultChecks = { version: 99, cases: [] };
	await expect(
		listWorkflowChecks(actor, { workflowId: identity.workflowId }),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(m.update).not.toHaveBeenCalled();
});
it("does not import another workflow’s checks when a draft is duplicated", async () => {
	workflow.settings.fabricResultChecks = {
		version: 1,
		workflowId: "example-source-workflow",
		cases: [],
	};
	expect(
		(await listWorkflowChecks(actor, { workflowId: identity.workflowId }))
			.cases,
	).toEqual([]);
});
it("preserves significant whitespace in exact expectations", async () => {
	m.execution.mockResolvedValue({
		id: identity.executionId,
		status: "COMPLETED",
		version: 1,
		completedAt: new Date("2026-01-01"),
		logs: [{ status: "COMPLETED", output: { text: "TODOLIST" } }],
	});
	const inspected = await inspectWorkflowResult(actor, identity);
	expect(
		(
			await previewWorkflowCheck(actor, {
				...identity,
				expectedRevision: inspected.revision,
				requiredPhrases: ["TODO "],
				forbiddenPhrases: [],
			})
		).report.status,
	).toBe("failed");
	expect(
		(
			await previewWorkflowCheck(actor, {
				...identity,
				expectedRevision: inspected.revision,
				requiredPhrases: [],
				forbiddenPhrases: ["TODO "],
			})
		).report.status,
	).toBe("passed");
});
it("reads legacy logs through an owned parent but refuses contradictory nonnull child tenants", async () => {
	const entry = {
		id: identity.executionId,
		status: "COMPLETED",
		version: 1,
		completedAt: new Date("2026-01-01"),
		logs: [
			{
				status: "COMPLETED",
				userId: null,
				organizationId: null,
				output: { text: "Example" },
			},
		],
	};
	m.execution.mockResolvedValueOnce(entry);
	expect((await inspectWorkflowResult(actor, identity)).recordedAnswer).toBe(
		"Example",
	);
	m.execution.mockResolvedValueOnce({
		...entry,
		logs: [{ ...entry.logs[0], organizationId: "other-org" }],
	});
	await expect(inspectWorkflowResult(actor, identity)).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
});
it("uses the non-edit state writer for saved checks", async () => {
	await saveWorkflowCheck(actor, {
		...(await passing()),
		name: "Delivery evidence",
	});
	expect(m.stateWrite).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			workflowId: identity.workflowId,
			organizationId: actor.organizationId,
			settings: expect.anything(),
		}),
	);
});
it("rechecks current authority at both comparison boundaries without loading edit controls", async () => {
	const { check } = await saveWorkflowCheck(actor, {
		...(await passing()),
		name: "Delivery evidence",
	});
	m.read.mockClear();
	m.manage.mockClear();
	await applyWorkflowCheck(actor, {
		workflowId: identity.workflowId,
		checkId: check.id,
		expectedCaseRevision: check.revision,
		executionId: "example-candidate",
	});
	expect(m.read).toHaveBeenCalledTimes(2);
	expect(m.manage).not.toHaveBeenCalled();
});
it("gives a recreated definition a fresh identity so a stale removal cannot erase it", async () => {
	const input = { ...(await passing()), name: "Delivery evidence" };
	const first = (await saveWorkflowCheck(actor, input)).check;
	await removeWorkflowCheck(actor, {
		workflowId: identity.workflowId,
		checkId: first.id,
		expectedCaseRevision: first.revision,
	});
	const recreated = (await saveWorkflowCheck(actor, input)).check;
	expect(recreated.id).not.toBe(first.id);
	expect(recreated.revision).not.toBe(first.revision);
	await expect(
		removeWorkflowCheck(actor, {
			workflowId: identity.workflowId,
			checkId: first.id,
			expectedCaseRevision: first.revision,
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(
		(await listWorkflowChecks(actor, { workflowId: identity.workflowId }))
			.cases[0].id,
	).toBe(recreated.id);
});
it("does not replace an unrelated legacy non-object settings value", async () => {
	const input = { ...(await passing()), name: "Delivery evidence" };
	m.locked.mockResolvedValueOnce({ ...workflow, settings: ["legacy"] });
	await expect(saveWorkflowCheck(actor, input)).rejects.toMatchObject({
		code: "CONFLICT",
	});
	expect(m.update).not.toHaveBeenCalled();
});

it("saves versioned structured checks and applies them only to recorded node results", async () => {
	m.execution.mockImplementation(async ({ where }: any) => ({
		id: where.id,
		status: "COMPLETED",
		version: 1,
		completedAt: new Date("2026-01-01"),
		logs: [
			{
				status: "COMPLETED",
				nodeType: "ai-generate-text",
				output: {
					text:
						where.id === "example-baseline"
							? '{"ready":true}'
							: '{"ready":false}',
				},
			},
		],
	}));
	const current = await inspectWorkflowResult(actor, identity);
	const checks = {
		version: 2,
		jsonSchema: {
			type: "object",
			required: ["ready"],
			properties: { ready: { type: "boolean" } },
		},
		jsonAssertions: [{ pointer: "/ready", equals: true }],
	};
	const preview = await previewWorkflowCheck(actor, {
		...identity,
		expectedRevision: current.revision,
		...checks,
	});
	expect(preview.report.status).toBe("passed");
	expect(preview.quality?.total).toBe(2);
	const saved = await saveWorkflowCheck(actor, {
		...identity,
		expectedRevision: current.revision,
		...checks,
		name: "Ready response",
	});
	expect(saved.check).toMatchObject(checks);
	const applied = await applyWorkflowCheck(actor, {
		workflowId: identity.workflowId,
		checkId: saved.check.id,
		expectedCaseRevision: saved.check.revision,
		executionId: "example-candidate",
	});
	expect(applied.candidate.report.status).toBe("failed");
	expect(applied.targetInvoked).toBe(false);
	expect(applied.change).toBe("regressed");
});
it("does not certify or save a grounding baseline without trusted retrieval receipts", async () => {
	const current = await inspectWorkflowResult(actor, identity);
	const checks = {
		...identity,
		expectedRevision: current.revision,
		version: 2,
		grounding: { requireCitations: true },
	};
	const preview = await previewWorkflowCheck(actor, checks);
	expect(preview.report.status).toBe("not-assessed");
	await expect(
		saveWorkflowCheck(actor, { ...checks, name: "Grounded" }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(m.update).not.toHaveBeenCalled();
});
