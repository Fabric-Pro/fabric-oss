import {
	computeReportReadiness,
	type ReadinessInput,
} from "@saas/reports/lib/report-readiness";
import { describe, expect, it } from "vitest";

const base: ReadinessInput = {
	templateNeedsDataSource: true,
	requiredDataSources: [{ key: "fizzy", name: "Fizzy", required: true }],
	bindings: {},
	diagnostics: undefined,
	requiredParams: [{ key: "projectName", label: "Project Name", value: "" }],
	skillsCount: 2,
	outputFormat: "HTML",
	dataSourceLabel: "MCP → task-board",
};

describe("computeReportReadiness", () => {
	it("does not block a report whose sources are all optional and unconnected", () => {
		const r = computeReportReadiness({
			...base,
			requiredDataSources: [
				{
					key: "project-management",
					name: "Project management tool",
					required: false,
				},
				{ key: "repository", name: "Repository", required: false },
			],
			bindings: {},
			diagnostics: [],
			requiredParams: [],
		});
		expect(r.hardBlocked).toBe(false);
	});

	it("blocks when a required data source is unbound", () => {
		const r = computeReportReadiness({
			...base,
			bindings: {},
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("not_configured");
		expect(r.hardBlocked).toBe(true);
		expect(r.verdict.tone).toBe("destructive");
		expect(r.checks.find((c) => c.key === "connection")?.status).toBe(
			"fail",
		);
	});

	it("treats a bound-but-untested source as connected (not a fabricated error)", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("connected");
		expect(r.connectionTested).toBe(false);
		expect(r.hardBlocked).toBe(false);
		expect(r.verdict.tone).toBe("success");
	});

	it("reports auth_expired (warn, not blocking) from diagnostics", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [{ outcome: "auth_failed", serverName: "Fizzy" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("auth_expired");
		expect(r.connectionTone).toBe("warning");
		expect(r.hardBlocked).toBe(false);
		expect(r.warns).toBeGreaterThan(0);
	});

	it("prioritises unreachable/error over auth in mixed diagnostics", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [
				{ outcome: "auth_failed" },
				{ outcome: "unreachable" },
			],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("unreachable");
		expect(r.connectionTone).toBe("destructive");
	});

	it("maps zero_tools/error outcomes to the 'error' state", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [{ outcome: "zero_tools" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("error");
	});

	it("flags missing required params (no value, no default) and blocks", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			requiredParams: [
				{ key: "projectName", label: "Project Name", value: "" },
			],
		});
		expect(r.missingRequiredParams).toEqual(["Project Name"]);
		expect(r.hardBlocked).toBe(true);
		expect(r.checks.find((c) => c.key === "params")?.status).toBe("fail");
		expect(r.blockReason).toContain("Project Name");
	});

	it("does NOT flag a required param that has a schema default", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			requiredParams: [
				{ key: "projectName", value: "", hasDefault: true },
			],
		});
		expect(r.missingRequiredParams).toEqual([]);
		expect(r.hardBlocked).toBe(false);
	});

	it("is fully ready when bound, tested-clean, and params set", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [{ outcome: "connected" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("connected");
		expect(r.hardBlocked).toBe(false);
		expect(r.fails).toBe(0);
		expect(r.warns).toBe(0);
		expect(r.verdict.tone).toBe("success");
	});

	it("treats a template with no data-source requirement as not_required (ok)", () => {
		const r = computeReportReadiness({
			...base,
			templateNeedsDataSource: false,
			requiredDataSources: [],
			bindings: {},
			requiredParams: [],
		});
		expect(r.connection).toBe("not_required");
		expect(r.hardBlocked).toBe(false);
		expect(r.checks.find((c) => c.key === "connection")?.status).toBe("ok");
	});

	it("does not block on optional (non-required) data sources being unbound", () => {
		const r = computeReportReadiness({
			...base,
			requiredDataSources: [
				{ key: "fizzy", name: "Fizzy", required: false },
			],
			bindings: {},
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.hardBlocked).toBe(false);
		expect(r.connection).toBe("connected");
	});

	it("surfaces project_not_selected (step 2) when bound & healthy but no project picked", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [{ outcome: "connected" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
			dataSourcesMissingProject: ["Fizzy"],
		});
		expect(r.connection).toBe("project_not_selected");
		expect(r.connectionTone).toBe("warning");
		// Step 2 is a warning, not a hard block — Generate stays enabled.
		expect(r.hardBlocked).toBe(false);
		expect(r.recovery.needsReconnect).toBe(false);
		expect(r.recovery.needsProjectSelect).toBe(true);
		expect(r.missingProjects).toEqual(["Fizzy"]);
	});

	it("keeps step 1 (reconnect) when auth is dead, even if a project is also unpicked", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [{ outcome: "auth_failed" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
			dataSourcesMissingProject: ["Fizzy"],
		});
		// auth_expired (step 1) takes precedence; step 2 is implied to follow it.
		expect(r.connection).toBe("auth_expired");
		expect(r.recovery.needsReconnect).toBe(true);
		expect(r.recovery.needsProjectSelect).toBe(true);
	});

	it("derives recovery flags: not_configured needs both reconnect and project select", () => {
		const r = computeReportReadiness({
			...base,
			bindings: {},
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("not_configured");
		expect(r.recovery.needsReconnect).toBe(true);
		expect(r.recovery.needsProjectSelect).toBe(true);
	});

	it("a fully-healthy connection needs no recovery", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-1" } },
			diagnostics: [{ outcome: "connected" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.recovery.needsReconnect).toBe(false);
		expect(r.recovery.needsProjectSelect).toBe(false);
		expect(r.missingProjects).toEqual([]);
	});

	it("flags connection_unavailable when a required binding cannot resolve (no config + no fallback)", () => {
		// The prod bug: instance binds `fizzy → cfg-gone`, the config no longer
		// resolves AND the user has no other config for that server, so even the
		// self-heal fallback finds nothing. It must NOT show as "connected".
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-gone" } },
			unresolvableDataSources: ["fizzy"],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("connection_unavailable");
		expect(r.connectionTone).toBe("destructive");
		expect(r.connectionLabel).toBe("Reconnect required");
		expect(r.hardBlocked).toBe(true);
		expect(r.checks.find((c) => c.key === "connection")?.status).toBe(
			"fail",
		);
		expect(r.recovery.needsReconnect).toBe(true);
		expect(r.recovery.needsProjectSelect).toBe(true);
		expect(r.blockReason).toContain("re-select");
	});

	it("self-heals: a stale stored id stays connected when a server fallback exists (not in unresolvableDataSources)", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-gone" } },
			// caller resolved a fallback → NOT listed as unresolvable
			unresolvableDataSources: [],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("connected");
		expect(r.hardBlocked).toBe(false);
	});

	it("does NOT run the resolvability check when unresolvableDataSources is omitted (back-compat)", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-gone" } },
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("connected");
	});

	it("does not flag an UNBOUND required source as unavailable (that's not_configured)", () => {
		const r = computeReportReadiness({
			...base,
			bindings: {},
			unresolvableDataSources: ["fizzy"],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("not_configured");
	});

	it("unavailable takes precedence over a stale passing diagnostic", () => {
		const r = computeReportReadiness({
			...base,
			bindings: { fizzy: { id: "cfg-gone" } },
			unresolvableDataSources: ["fizzy"],
			diagnostics: [{ outcome: "connected" }],
			requiredParams: [{ key: "projectName", value: "Fabric" }],
		});
		expect(r.connection).toBe("connection_unavailable");
	});
});

describe("computeReportReadiness — required provider context fields", () => {
	const connected = {
		...base,
		bindings: { fizzy: { id: "cfg-1" } },
		requiredParams: [{ key: "projectName", value: "Fabric" }],
	};

	it("fails the parameters check and names an empty required context field", () => {
		const r = computeReportReadiness({
			...connected,
			requiredContextFields: [
				{ key: "accountSlug", label: "Account Slug", value: "" },
				{ key: "boardId", label: "Board", value: "42" },
			],
		});
		const params = r.checks.find((c) => c.key === "params");
		expect(params?.status).toBe("fail");
		expect(params?.note).toBe("Fill in: Account Slug");
		expect(r.missingRequiredParams).toEqual(["Account Slug"]);
		expect(r.hardBlocked).toBe(true);
		expect(r.blockReason).toContain("Account Slug");
	});

	it("treats a whitespace-only context value as empty", () => {
		const r = computeReportReadiness({
			...connected,
			requiredContextFields: [
				{ key: "accountSlug", label: "Account Slug", value: "   " },
			],
		});
		expect(r.missingRequiredParams).toEqual(["Account Slug"]);
	});

	it("passes when every required context field is filled", () => {
		const r = computeReportReadiness({
			...connected,
			requiredContextFields: [
				{ key: "accountSlug", label: "Account Slug", value: "123" },
				{ key: "boardId", label: "Board", value: "42" },
			],
		});
		expect(r.checks.find((c) => c.key === "params")?.status).toBe("ok");
		expect(r.hardBlocked).toBe(false);
	});

	it("lists missing template parameters and context fields together", () => {
		const r = computeReportReadiness({
			...connected,
			requiredParams: [{ key: "projectName", label: "Project Name" }],
			requiredContextFields: [{ key: "boardId", label: "Board" }],
		});
		expect(r.missingRequiredParams).toEqual(["Project Name", "Board"]);
		expect(r.checks.find((c) => c.key === "params")?.label).toBe(
			"2 required parameters missing",
		);
	});

	it("leaves readiness unchanged when no context fields are passed (flag off)", () => {
		const withField = computeReportReadiness({
			...connected,
			requiredContextFields: [],
		});
		const without = computeReportReadiness(connected);
		expect(withField.checks).toEqual(without.checks);
		expect(without.hardBlocked).toBe(false);
	});
});

it("labels supported Project knowledge without claiming an external connection test", () => {
	const r = computeReportReadiness({
		...base,
		templateNeedsDataSource: false,
		requiredDataSources: [],
		requiredParams: [],
		projectKnowledge: true,
	});
	expect(r.hardBlocked).toBe(false);
	expect(r.connectionTested).toBe(false);
	expect(r.connectionLabel).toBe("Project knowledge selected");
	expect(r.checks[0]?.note).toContain(
		"project access is checked when this report runs",
	);
	expect(r.verdict.subtitle).not.toBe("All checks passed");
});

it("never lets a Project knowledge display hint bypass missing external bindings", () => {
	const r = computeReportReadiness({ ...base, projectKnowledge: true });
	expect(r.hardBlocked).toBe(true);
	expect(r.connection).toBe("not_configured");
	expect(r.connectionLabel).not.toBe("Project knowledge selected");
});
