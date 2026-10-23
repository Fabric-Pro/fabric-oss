/**
 * The tenant boundary of recurring-error detection: which source a project's
 * scan reads, and whether the organization bound travels with it. Only the
 * deployment-designated operator project may read the shared workspace
 * unscoped; every other project gets its own workspace, its organization's
 * slice of the shared one, or nothing.
 */
import type { LogSourceAdapter } from "@repo/ai/lib/log-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProjectLogSourceBinding = vi.hoisted(() => vi.fn());
vi.mock("@repo/database", () => ({ getProjectLogSourceBinding }));

const createOperatorErrorScanAdapter = vi.hoisted(() => vi.fn());
vi.mock("../../backlog-context/azure-monitor-log-source", () => ({
	createOperatorErrorScanAdapter,
}));

const registry = vi.hoisted(() => ({
	resolveConfiguredLogSource: vi.fn(),
	resolveProjectLogSource: vi.fn(),
}));
vi.mock("../../backlog-context/log-source-registry", () => registry);

import {
	resolveRecurringErrorSource,
	UNUSABLE_BINDING_REASON,
} from "../resolve-error-source";

function adapter(label: string, sharedStore: boolean) {
	const summarizeErrorGroups = vi.fn().mockResolvedValue([]);
	const built: LogSourceAdapter = {
		kind: "azure-monitor",
		label,
		sharedStore,
		fetchLogExcerpts: vi.fn(),
		summarizeErrorGroups,
	};
	return { built, summarizeErrorGroups };
}

const PROJECT = { projectId: "proj_1", organizationId: "org_example" };
const SCOPE = { lookbackMinutes: 60, minOccurrences: 5, maxGroups: 25 };

beforeEach(() => {
	vi.clearAllMocks();
	createOperatorErrorScanAdapter.mockReturnValue(null);
	getProjectLogSourceBinding.mockResolvedValue(null);
	registry.resolveConfiguredLogSource.mockReturnValue(null);
	registry.resolveProjectLogSource.mockReturnValue(null);
});

describe("resolveRecurringErrorSource", () => {
	it("gives the operator project the shared workspace without an organization bound", async () => {
		const { built, summarizeErrorGroups } = adapter("Azure Monitor", true);
		createOperatorErrorScanAdapter.mockReturnValue(built);

		const source = await resolveRecurringErrorSource(PROJECT);
		await source?.summarize(SCOPE);

		expect(createOperatorErrorScanAdapter).toHaveBeenCalledWith("proj_1");
		expect(source?.reach).toBe("operator");
		expect(summarizeErrorGroups).toHaveBeenCalledWith({
			...SCOPE,
			organizationId: undefined,
		});
		expect(getProjectLogSourceBinding).not.toHaveBeenCalled();
	});

	it("scans a project's own workspace when it is bound to one", async () => {
		const { built, summarizeErrorGroups } = adapter("Azure Monitor", false);
		getProjectLogSourceBinding.mockResolvedValue({
			provider: "azure-monitor",
			config: { workspaceId: "ws-own" },
		});
		registry.resolveProjectLogSource.mockReturnValue(built);

		const source = await resolveRecurringErrorSource(PROJECT);
		await source?.summarize(SCOPE);

		expect(source?.reach).toBe("dedicated");
		expect(registry.resolveProjectLogSource).toHaveBeenCalledWith(
			"azure-monitor",
			{ workspaceId: "ws-own" },
		);
		expect(summarizeErrorGroups).toHaveBeenCalledWith({
			...SCOPE,
			organizationId: undefined,
		});
		expect(registry.resolveConfiguredLogSource).not.toHaveBeenCalled();
	});

	it("never falls back to the shared workspace when the binding cannot be used", async () => {
		getProjectLogSourceBinding.mockResolvedValue({
			provider: "azure-monitor",
			config: {},
		});
		registry.resolveProjectLogSource.mockReturnValue(null);
		registry.resolveConfiguredLogSource.mockReturnValue(
			adapter("Azure Monitor", true).built,
		);

		await expect(resolveRecurringErrorSource(PROJECT)).rejects.toThrow(
			UNUSABLE_BINDING_REASON,
		);
		expect(registry.resolveConfiguredLogSource).not.toHaveBeenCalled();
	});

	it("refuses, visibly, a binding that resolves to a shared store", async () => {
		getProjectLogSourceBinding.mockResolvedValue({
			provider: "azure-monitor",
			config: { workspaceId: "ws-shared" },
		});
		registry.resolveProjectLogSource.mockReturnValue(
			adapter("Azure Monitor", true).built,
		);

		await expect(resolveRecurringErrorSource(PROJECT)).rejects.toThrow(
			UNUSABLE_BINDING_REASON,
		);
	});

	it("refuses, visibly, a binding whose source cannot aggregate", async () => {
		getProjectLogSourceBinding.mockResolvedValue({
			provider: "azure-monitor",
			config: { workspaceId: "ws-own" },
		});
		registry.resolveProjectLogSource.mockReturnValue({
			...adapter("Other logs", false).built,
			summarizeErrorGroups: undefined,
		});

		await expect(resolveRecurringErrorSource(PROJECT)).rejects.toThrow(
			UNUSABLE_BINDING_REASON,
		);
	});

	it("scans the deployment workspace only for the project's own organization", async () => {
		const { built, summarizeErrorGroups } = adapter("Azure Monitor", true);
		registry.resolveConfiguredLogSource.mockReturnValue(built);

		const source = await resolveRecurringErrorSource(PROJECT);
		await source?.summarize(SCOPE);

		expect(source?.reach).toBe("organization");
		expect(summarizeErrorGroups).toHaveBeenCalledWith({
			...SCOPE,
			organizationId: "org_example",
		});
	});

	it("does not scan the deployment workspace for a personal project", async () => {
		registry.resolveConfiguredLogSource.mockReturnValue(
			adapter("Azure Monitor", true).built,
		);

		expect(
			await resolveRecurringErrorSource({
				projectId: "proj_1",
				organizationId: null,
			}),
		).toBeNull();
	});

	it("is not configured when the source cannot aggregate", async () => {
		const { built } = adapter("Other logs", false);
		registry.resolveConfiguredLogSource.mockReturnValue({
			...built,
			summarizeErrorGroups: undefined,
		});

		expect(await resolveRecurringErrorSource(PROJECT)).toBeNull();
	});

	it("is not configured, without an error, when the project has no binding and the deployment no default", async () => {
		expect(await resolveRecurringErrorSource(PROJECT)).toBeNull();
	});
});
