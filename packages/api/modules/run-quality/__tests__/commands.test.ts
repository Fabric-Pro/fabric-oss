import { gradeResultQuality } from "@repo/utils/result-quality";
import { RunQualityError } from "@repo/utils/run-quality-contracts";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	load: vi.fn(),
	source: vi.fn(),
	snapshot: vi.fn(),
	policy: vi.fn(),
	find: vi.fn(),
	list: vi.fn(),
	update: vi.fn(),
	policyUpdate: vi.fn(),
	create: vi.fn(),
	audit: vi.fn(),
	lock: vi.fn(),
	client: vi.fn(),
	handle: vi.fn(),
	describe: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		runQualityPolicy: { findFirst: m.policy },
		runQualityAssessment: { findFirst: m.find, findMany: m.list },
		$transaction: async (run: (tx: unknown) => unknown) =>
			run({
				$queryRaw: m.lock,
				runQualityPolicy: {
					findFirst: m.policy,
					updateMany: m.policyUpdate,
					create: m.create,
				},
				runQualityAssessment: { updateMany: m.update },
			}),
	},
	loadRunQualityTarget: m.load,
	qualityTargetWhere: (target: { targetType: string; targetId: string }) =>
		target.targetType === "AGENT"
			? { instanceId: target.targetId, workflowId: null }
			: { workflowId: target.targetId, instanceId: null },
	qualityDigest: (value: unknown) => JSON.stringify(value),
	recordAuditTx: m.audit,
}));
vi.mock("@repo/temporal/client", () => ({ getTemporalClient: m.client }));
vi.mock("@repo/temporal/run-quality-source-access", () => ({
	assertRunQualitySourceAccess: m.source,
	snapshotRunQualitySources: m.snapshot,
}));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	WorkspaceDocumentContentError: class extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	},
}));

import {
	cancelRunQualityAssessment,
	compareRunQualityAssessments,
	configureRunQualityPolicy,
	getRunQualityAssessment,
	getRunQualityPolicy,
	listRunQualityAssessments,
} from "../lib/commands";

const actor = { userId: "example-user", organizationId: "example-org" };
const target = { targetType: "AGENT" as const, targetId: "example-agent" };
const now = new Date("2026-01-01T00:00:00Z");
const checks = { requiredPhrases: ["Ready"], forbiddenPhrases: [] };
const rules = [{ id: "check", name: "Delivery", required: true, checks }];
const grade = gradeResultQuality("Ready", checks);
const report = {
	version: 1,
	scorerVersion: "fabric-deterministic-v1",
	rules: [
		{
			id: "check",
			name: "Delivery",
			required: true,
			status: "PASSED",
			grade,
			outputHash: "a".repeat(64),
		},
	],
	coverage: { passed: 1, failed: 0, unavailable: 0, total: 1 },
};
const baseline = {
	id: "example-assessment",
	...actor,
	policyId: "example-policy",
	policyRevision: 1,
	sourceVersion: 2,
	workflowExecutionId: null,
	agentExecutionId: "example-execution",
	nativeWorkflowId: "example-native",
	nativeRunId: "example-native-run",
	assessmentWorkflowId: "example-observer",
	assessmentRunId: "example-observer-run",
	sourceScopeJson: { kind: "AGENT", scope: { instanceId: target.targetId } },
	rulesJson: rules,
	rulesHash: "a".repeat(64),
	status: "COMPLETED",
	verdict: "PASSED",
	reportJson: report,
	errorCode: null,
	createdAt: now,
	completedAt: now,
};
let rows: Map<string, any>;
beforeEach(() => {
	vi.resetAllMocks();
	rows = new Map([[baseline.id, { ...baseline }]]);
	m.load.mockResolvedValue({
		version: 2,
		nodes: [{ id: "draft" }],
		projectId: null,
	});
	m.source.mockResolvedValue(undefined);
	m.snapshot.mockResolvedValue(baseline.sourceScopeJson);
	m.policy.mockResolvedValue({
		id: "example-policy",
		revision: 1,
		enabled: true,
		rulesJson: rules,
		updatedAt: now,
	});
	m.find.mockImplementation(
		async ({ where }: any) => rows.get(where.id) ?? null,
	);
	m.list.mockImplementation(async () => [...rows.values()]);
	m.policyUpdate.mockResolvedValue({ count: 1 });
	m.create.mockResolvedValue({ id: "example-policy", revision: 1 });
	m.update.mockImplementation(async ({ where, data }: any) => {
		const row = rows.get(where.id);
		if (!row || !where.status.in.includes(row.status)) {
			return { count: 0 };
		}
		Object.assign(row, data);
		return { count: 1 };
	});
	m.describe.mockResolvedValue({
		runId: baseline.assessmentRunId,
		type: "recordedRunQualityWorkflow",
		status: { name: "RUNNING" },
		memo: {
			fabricRunQuality: {
				version: 1,
				assessmentId: baseline.id,
				...actor,
			},
		},
	});
	m.handle.mockReturnValue({ describe: m.describe, cancel: m.cancel });
	m.client.mockResolvedValue({ workflow: { getHandle: m.handle } });
});
it("returns strict policy/report DTOs while scoping every retained query to actor and target", async () => {
	expect((await getRunQualityPolicy(actor, target)).policy?.rules).toEqual(
		rules,
	);
	const row = await getRunQualityAssessment(actor, {
		...target,
		assessmentId: baseline.id,
	});
	expect(row.report).toEqual(report);
	expect(row).not.toHaveProperty("nativeRunId");
	expect(m.find).toHaveBeenCalledWith({
		where: {
			id: baseline.id,
			...actor,
			policy: { ...actor, instanceId: target.targetId, workflowId: null },
		},
	});
});
it("refuses arbitrary stored report fields rather than releasing raw output", async () => {
	rows.get(baseline.id).reportJson = {
		...report,
		output: "private recorded answer",
	};
	await expect(
		getRunQualityAssessment(actor, {
			...target,
			assessmentId: baseline.id,
		}),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("does not turn database failures into no-access or empty history", async () => {
	m.source.mockRejectedValue(new Error("Storage unavailable"));
	await expect(listRunQualityAssessments(actor, target)).rejects.toThrow(
		"Storage unavailable",
	);
	m.load.mockImplementation(async (_actor, _target, write) => {
		if (write) {
			throw new Error("Database unavailable");
		}
		return { version: 2 };
	});
	await expect(getRunQualityPolicy(actor, target)).rejects.toThrow(
		"Database unavailable",
	);
});
it("filters only actual revoked source grants, preserving hasMore pagination", async () => {
	m.source.mockRejectedValue(
		new RunQualityError("NOT_FOUND", "Source unavailable"),
	);
	m.list.mockResolvedValue(
		Array.from({ length: 3 }, (_, i) => ({
			...baseline,
			id: `example-${i}`,
		})),
	);
	expect(
		await listRunQualityAssessments(actor, { ...target, limit: 2 }),
	).toEqual({ assessments: [], hasMore: true, unavailableCount: 0 });
});
it("permits an unavailable sentinel only for receipts with no retained report", async () => {
	const row = rows.get(baseline.id);
	row.sourceScopeJson = { kind: "UNAVAILABLE" };
	await expect(
		getRunQualityAssessment(actor, { ...target, assessmentId: row.id }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	Object.assign(row, {
		reportJson: null,
		status: "COMPLETED",
		verdict: "UNAVAILABLE",
		errorCode: "SOURCE_ACCESS_REVOKED",
	});
	expect(
		(
			await getRunQualityAssessment(actor, {
				...target,
				assessmentId: row.id,
			})
		).verdict,
	).toBe("UNAVAILABLE");
	expect(m.source).not.toHaveBeenCalled();
});
it("does not accept a user-defined role without current read permission on writes", async () => {
	m.load.mockImplementation(async (_actor, _target, write) => {
		if (!write) {
			throw new RunQualityError("FORBIDDEN", "Read permission required");
		}
		return { nodes: null };
	});
	await expect(
		configureRunQualityPolicy(actor, {
			...target,
			expectedRevision: 1,
			enabled: true,
			rules,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(m.policyUpdate).not.toHaveBeenCalled();
});
it("keeps revision conflicts and invalid workflow step selection from mutating policy", async () => {
	await expect(
		configureRunQualityPolicy(actor, {
			...target,
			expectedRevision: 0,
			enabled: true,
			rules,
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		configureRunQualityPolicy(actor, {
			targetType: "WORKFLOW",
			targetId: "example-flow",
			expectedRevision: 1,
			enabled: true,
			rules,
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(m.policyUpdate).not.toHaveBeenCalled();
});
it("pins a verified observer identity when cancelling and never touches business execution", async () => {
	Object.assign(rows.get(baseline.id), {
		status: "CHECKING",
		verdict: null,
		reportJson: null,
		completedAt: null,
	});
	const result = await cancelRunQualityAssessment(actor, {
		...target,
		assessmentId: baseline.id,
	});
	expect(result.status).toBe("CANCELLED");
	expect(m.handle).toHaveBeenLastCalledWith(
		baseline.assessmentWorkflowId,
		baseline.assessmentRunId,
		{ followRuns: false },
	);
	expect(m.cancel).toHaveBeenCalledTimes(1);
	expect(m.audit).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ action: "quality.assessment_cancelled" }),
	);
});
it.each([
	{ runId: "different-run" },
	{
		memo: {
			fabricRunQuality: { version: 1, assessmentId: "other", ...actor },
		},
	},
	{ type: "differentWorkflow" },
])(
	"fences cancellation even if the observer identity cannot be confirmed",
	async (patch) => {
		Object.assign(rows.get(baseline.id), {
			status: "CHECKING",
			verdict: null,
			reportJson: null,
			completedAt: null,
		});
		m.describe.mockResolvedValue({ ...(await m.describe()), ...patch });
		const result = await cancelRunQualityAssessment(actor, {
			...target,
			assessmentId: baseline.id,
		});
		expect(result.status).toBe("CANCELLED");
		expect(m.cancel).not.toHaveBeenCalled();
	},
);
it("preserves a committed cancellation fence if Temporal is unavailable", async () => {
	Object.assign(rows.get(baseline.id), {
		status: "CHECKING",
		verdict: null,
		reportJson: null,
		completedAt: null,
	});
	m.client.mockRejectedValue(new Error("Temporal unavailable"));
	expect(
		(
			await cancelRunQualityAssessment(actor, {
				...target,
				assessmentId: baseline.id,
			})
		).status,
	).toBe("CANCELLED");
});
it("compares only distinct completed compatible receipts and reports live source drift", async () => {
	rows.set("right", {
		...baseline,
		id: "right",
		sourceVersion: 3,
		sourceScopeJson: {
			kind: "AGENT",
			scope: {
				instanceId: target.targetId,
				projectId: "example-project",
			},
		},
	});
	const comparison = await compareRunQualityAssessments(actor, {
		...target,
		leftId: baseline.id,
		rightId: "right",
	});
	expect(comparison.changes).toMatchObject({
		sameChecks: true,
		sourceVersionChanged: true,
		sourceScopeChanged: true,
	});
	await expect(
		compareRunQualityAssessments(actor, {
			...target,
			leftId: baseline.id,
			rightId: baseline.id,
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	rows.get("right").status = "CHECKING";
	await expect(
		compareRunQualityAssessments(actor, {
			...target,
			leftId: baseline.id,
			rightId: "right",
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	rows.get("right").status = "COMPLETED";
	rows.get("right").rulesHash = "b".repeat(64);
	await expect(
		compareRunQualityAssessments(actor, {
			...target,
			leftId: baseline.id,
			rightId: "right",
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
});

it("enforces the transport's current and frozen source ceilings before releasing grades or policy", async () => {
	const denied = vi.fn(() => {
		throw new RunQualityError("FORBIDDEN", "Missing source scope");
	});
	await expect(
		getRunQualityPolicy(actor, target, denied),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(m.policy).not.toHaveBeenCalled();
	const row = rows.get(baseline.id);
	row.sourceScopeJson = {
		kind: "AGENT",
		scope: {
			instanceId: target.targetId,
			workspaceIds: ["example-private"],
		},
	};
	await expect(
		getRunQualityAssessment(
			actor,
			{ ...target, assessmentId: row.id },
			denied,
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(denied).toHaveBeenLastCalledWith(
		expect.objectContaining({ workspaceIds: ["example-private"] }),
	);
});
it("applies workspace and skill scope ceilings to workflow selectors", async () => {
	const row = rows.get(baseline.id);
	row.sourceScopeJson = {
		kind: "WORKFLOW",
		projectId: null,
		workspaceIds: ["example-private"],
		skillIds: ["example-skill"],
	};
	const policy = vi.fn();
	await getRunQualityAssessment(
		actor,
		{
			targetType: "WORKFLOW",
			targetId: "example-flow",
			assessmentId: row.id,
		},
		policy,
	);
	expect(policy).toHaveBeenCalledWith({
		workspaceIds: ["example-private"],
		skillIds: ["example-skill"],
	});
});

it("skips only unparsable authorized DTOs with a truthful count and bounded page scan", async () => {
	const drifted = {
		...baseline,
		id: "example-drifted",
		reportJson: { ...report, rawOutput: "private answer" },
	};
	const next = { ...baseline, id: "example-next" };
	m.list.mockResolvedValue([drifted, baseline, next]);
	const page = await listRunQualityAssessments(actor, {
		...target,
		limit: 2,
	});
	expect(page.assessments.map((row) => row.id)).toEqual([baseline.id]);
	expect(page).toMatchObject({ hasMore: true, unavailableCount: 1 });
	expect(JSON.stringify(page)).not.toContain("private answer");
	expect(m.source).toHaveBeenCalledTimes(2);
	expect(m.list.mock.calls[0][0]).toMatchObject({ take: 3, skip: 0 });
	m.list.mockRejectedValue(new Error("Database unavailable"));
	await expect(listRunQualityAssessments(actor, target)).rejects.toThrow(
		"Database unavailable",
	);
});

it("does not let an invalid retained date poison otherwise verified list rows", async () => {
	m.list.mockResolvedValue([
		{
			...baseline,
			id: "example-invalid-date",
			createdAt: new Date(Number.NaN),
		},
		baseline,
	]);
	const page = await listRunQualityAssessments(actor, target);
	expect(page.assessments.map((row) => row.id)).toEqual([baseline.id]);
	expect(page.unavailableCount).toBe(1);
});
