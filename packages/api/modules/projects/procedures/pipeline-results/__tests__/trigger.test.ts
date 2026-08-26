/**
 * `projects.pipelineResults.trigger` — start a run in the customer's existing CI.
 *
 * Locks the external contract the UI is built on:
 *   - a PROVIDER refusal is returned as data, so its remedy can be rendered
 *     persistently; only Fabric-side faults throw.
 *   - an integration belonging to another project is not triggerable.
 *   - the owning org comes from the project row, never from the caller.
 *   - a definition provider cannot be triggered without choosing one.
 *   - the ref falls back to the branch QA already watches.
 *   - the outward action is audited whether it succeeded or was refused, and the
 *     audit never carries the values of user-supplied inputs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListTargets = vi.fn();
const mockResolveToken = vi.fn();
const mockRecordAudit = vi.fn();
const mockFindProject = vi.fn();
const mockDerivePlan = vi.fn();
const capturedPermissions: unknown[] = [];

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: (...a: unknown[]) => mockFindProject(...a) } },
	listProjectQaTriggerTargets: (...a: unknown[]) => mockListTargets(...a),
	recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
}));

vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: (...a: unknown[]) => mockResolveToken(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../lib/ci-trigger-dispatch", () => ({
	deriveCiTriggerPlan: (...a: unknown[]) => mockDerivePlan(...a),
}));

vi.mock("../../../lib/pipeline-results-feature", () => ({
	assertPipelineResultsEnabled: () => undefined,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: (permission: unknown) => {
			capturedPermissions.push(permission);
			return (c: unknown) => c;
		},
	};
});

const { triggerPipelineProcedure } = await import("../trigger");

const context = { user: { id: "user-1" } };

const githubTarget = {
	integrationId: "int-1",
	provider: "GITHUB",
	owner: "acme",
	repo: "store",
	repositoryUrl: "https://github.com/acme/store",
	azureOrganization: null,
	defaultBranch: "main",
	qaBranch: "qa",
	effectiveBranch: "qa",
};

function callTrigger(input: Record<string, unknown>) {
	return (
		triggerPipelineProcedure as unknown as {
			handler: (a: {
				input: unknown;
				context: unknown;
			}) => Promise<unknown>;
		}
	).handler({ input, context });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFindProject.mockResolvedValue({ organizationId: "org-1" });
	mockListTargets.mockResolvedValue([githubTarget]);
	mockResolveToken.mockResolvedValue({ token: "tok" });
});

describe("triggerPipelineProcedure", () => {
	it("is write-gated by TEST_CASE_UPDATE, the same bar as Sync now", () => {
		expect(capturedPermissions).toContain("TEST_CASE_UPDATE");
	});

	it("returns a provider refusal as data instead of throwing", async () => {
		// The UI renders NOT_DISPATCHABLE as a persistent panel with the exact
		// remedy. Throwing would reduce it to a toast that vanishes.
		const refusal = {
			ok: false,
			failure: "NOT_DISPATCHABLE",
			message: "no workflow_dispatch",
		};
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "definition",
			listPipelines: vi.fn(),
			trigger: vi.fn().mockResolvedValue(refusal),
		});

		await expect(
			callTrigger({
				projectId: "p1",
				integrationId: "int-1",
				pipelineId: "77",
			}),
		).resolves.toEqual(refusal);
	});

	it("falls back to the branch QA already watches when no ref is given", async () => {
		const trigger = vi
			.fn()
			.mockResolvedValue({ ok: true, runId: null, runUrl: null });
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "definition",
			listPipelines: vi.fn(),
			trigger,
		});

		await callTrigger({
			projectId: "p1",
			integrationId: "int-1",
			pipelineId: "77",
		});

		expect(trigger).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ ref: "qa" }),
		);
	});

	it("refuses to start a definition provider without a chosen pipeline", async () => {
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "definition",
			listPipelines: vi.fn(),
			trigger: vi.fn(),
		});

		await expect(
			callTrigger({ projectId: "p1", integrationId: "int-1" }),
		).rejects.toThrow(/Choose which workflow/);
	});

	it("starts a ref provider with no pipeline at all", async () => {
		const trigger = vi
			.fn()
			.mockResolvedValue({ ok: true, runId: "9", runUrl: "u" });
		mockDerivePlan.mockReturnValue({ ok: true, kind: "ref", trigger });

		await expect(
			callTrigger({ projectId: "p1", integrationId: "int-1" }),
		).resolves.toEqual({ ok: true, runId: "9", runUrl: "u" });
		expect(trigger).toHaveBeenCalledWith("tok", {
			ref: "qa",
			inputs: undefined,
		});
	});

	it("404s an integration that is not connected to this project", async () => {
		// The query is projectId-scoped, so a foreign integration id yields no
		// row rather than being retargeted.
		mockListTargets.mockResolvedValue([]);

		await expect(
			callTrigger({
				projectId: "p1",
				integrationId: "other-project-int",
			}),
		).rejects.toThrow(/not connected to this project/);
	});

	it("leaves a trail when someone probes a foreign integration id", async () => {
		// This is the most investigation-worthy refusal of the lot and it used to
		// leave nothing behind: a bare 404 and no ledger entry that anyone asked.
		mockListTargets.mockResolvedValue([]);

		await expect(
			callTrigger({
				projectId: "p1",
				integrationId: "other-project-int",
			}),
		).rejects.toThrow();

		const row = mockRecordAudit.mock.calls[0][0];
		expect(row.action).toBe("project.ci_run.triggered");
		expect(row.outcome).toBe("failure");
		expect(row.metadata.failure).toBe("NOT_CONNECTED");
		// The id they probed is what makes the row worth having.
		expect(row.resource.id).toBe("other-project-int");
	});

	it("records a refusal when no credential can be resolved", async () => {
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "ref",
			trigger: vi.fn(),
		});
		mockResolveToken.mockResolvedValue({ token: null });

		await expect(
			callTrigger({ projectId: "p1", integrationId: "int-1" }),
		).rejects.toThrow();

		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				metadata: expect.objectContaining({
					failure: "NO_CREDENTIAL",
				}),
			}),
		);
	});

	it("takes the owning org from the project row, not from the caller", async () => {
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "ref",
			trigger: vi
				.fn()
				.mockResolvedValue({ ok: true, runId: null, runUrl: null }),
		});

		await callTrigger({
			projectId: "p1",
			integrationId: "int-1",
			// A caller-supplied org must not reach credential resolution.
			organizationId: "org-attacker",
		});

		expect(mockResolveToken).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});

	it("fails clearly when no usable credential can be resolved", async () => {
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "ref",
			trigger: vi.fn(),
		});
		mockResolveToken.mockResolvedValue({ token: null });

		await expect(
			callTrigger({ projectId: "p1", integrationId: "int-1" }),
		).rejects.toThrow(/reconnect the repository/i);
	});

	it("turns an unreachable provider into a readable outcome, not a 500", async () => {
		// The clients answer bad STATUSES with a rejection object, so a throw here
		// means the request never completed — a timeout (AbortSignal fires at 20s),
		// DNS, a dropped connection. Unhandled it became an opaque 500 that also
		// skipped the audit row for an attempt that may have reached the provider.
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "ref",
			trigger: vi
				.fn()
				.mockRejectedValue(
					new DOMException(
						"The operation was aborted",
						"TimeoutError",
					),
				),
		});

		const result = (await callTrigger({
			projectId: "p1",
			integrationId: "int-1",
		})) as { ok: boolean; failure: string; message: string };

		expect(result.ok).toBe(false);
		expect(result.failure).toBe("PROVIDER_ERROR");
		expect(result.message).toMatch(/timed out/i);
		// The attempt is still audited — that is the point of catching it here.
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failure" }),
		);
	});

	it("still surfaces a caller mistake as a 4xx, not as an unreachable provider", async () => {
		// The "choose a pipeline" guard now lives INSIDE the try/catch, so it must
		// be re-thrown rather than folded into a PROVIDER_ERROR that would tell the
		// user their CI is down when they simply picked nothing.
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "definition",
			listPipelines: vi.fn(),
			trigger: vi.fn(),
		});

		await expect(
			callTrigger({ projectId: "p1", integrationId: "int-1" }),
		).rejects.toThrow(/Choose which workflow/);
		expect(mockRecordAudit).not.toHaveBeenCalled();
	});

	it("audits a refusal as deliberately as a success, without input values", async () => {
		mockDerivePlan.mockReturnValue({
			ok: true,
			kind: "ref",
			trigger: vi.fn().mockResolvedValue({
				ok: false,
				failure: "INSUFFICIENT_SCOPE",
				message: "needs api scope",
			}),
		});

		await callTrigger({
			projectId: "p1",
			integrationId: "int-1",
			inputs: { SUITE: "secret-value" },
		});

		const row = mockRecordAudit.mock.calls[0][0];
		expect(row.action).toBe("project.ci_run.triggered");
		expect(row.outcome).toBe("failure");
		expect(row.metadata.failure).toBe("INSUFFICIENT_SCOPE");
		expect(row.metadata.inputKeys).toEqual(["SUITE"]);
		expect(JSON.stringify(row)).not.toContain("secret-value");
	});
});
