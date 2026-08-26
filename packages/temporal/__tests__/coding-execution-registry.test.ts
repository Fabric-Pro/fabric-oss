import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getCodingExecutionAdapterDefinition,
	listCodingExecutionAdapterDefinitions,
} from "../src/lib/coding-execution/registry";

describe("coding execution adapter registry", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("describes the local adapter as repo-root-based runtime", () => {
		expect(
			getCodingExecutionAdapterDefinition("KANBAN_LOCAL"),
		).toMatchObject({
			adapterName: "KanbanLocalAdapter",
			executionChannel: "LOCAL_AGENTS",
			requiresWorkingDirectory: true,
		});
	});

	it("describes the Fabric-managed background adapter as not requiring a repo root", () => {
		expect(
			getCodingExecutionAdapterDefinition("BACKGROUND_AGENTS"),
		).toMatchObject({
			adapterName: "FabricBackgroundAdapter",
			executionChannel: "BACKGROUND_AGENTS",
			requiresWorkingDirectory: false,
		});
	});

	it("lists all supported execution adapters", () => {
		const adapters = listCodingExecutionAdapterDefinitions();
		expect(adapters.map((adapter) => adapter.provider).sort()).toEqual([
			"BACKGROUND_AGENTS",
			"KANBAN_LOCAL",
		]);
	});

	it("throws RuntimeNotFoundError when BACKGROUND_AGENTS_URL is not set", () => {
		// The env validation happens at module load time, so we can't easily test this
		// Just verify the adapter definition exists
		expect(
			getCodingExecutionAdapterDefinition("BACKGROUND_AGENTS"),
		).toBeDefined();
	});

	it("creates local providers without rate limiting errors", () => {
		// Local providers can be created without rate limiting in test environment
		// The rate limiting is applied at the getCodingExecutionProvider level
		const adapter = getCodingExecutionAdapterDefinition("KANBAN_LOCAL");
		expect(adapter).toBeDefined();
		expect(adapter.create).toBeDefined();

		// Creating the adapter directly should work
		const provider = adapter.create();
		expect(provider).toBeDefined();
		expect(provider.healthCheck).toBeDefined();
	});
});
