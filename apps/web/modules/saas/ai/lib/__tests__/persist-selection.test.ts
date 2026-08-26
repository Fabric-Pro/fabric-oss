/**
 * Tests for the persist-selection projection helper. Pure function — no
 * mocks needed. Exercises the field allowlist (Decision §"AC #1 dropped"
 * notwithstanding, instructions and enabledIntegrationProviders are
 * runtime-only and must not be persisted; spec §4.2 / §6.2).
 */

import { describe, expect, it } from "vitest";
import { persistSelectionShape } from "../persist-selection";

describe("persistSelectionShape", () => {
	it("returns an empty array for an empty input", () => {
		expect(persistSelectionShape([])).toEqual([]);
	});

	it("strips runtime-only fields (`instructions`, `enabledIntegrationProviders`)", () => {
		const out = persistSelectionShape([
			{
				agentId: "agent_a",
				name: "Helper",
				instructions: "secret prompt that should not persist",
				enabledIntegrationProviders: ["GITHUB"],
				enabledIntegrationIds: ["int_1"],
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).not.toHaveProperty("instructions");
		expect(out[0]).not.toHaveProperty("enabledIntegrationProviders");
		// The resolved IDs *do* survive (they are stable references).
		expect(out[0]?.enabledIntegrationIds).toEqual(["int_1"]);
	});

	it("preserves only the optional fields actually set on the input", () => {
		const out = persistSelectionShape([
			{
				agentId: "model:gpt-4o",
				name: "GPT-4o",
				modelOverride: "gpt-4o",
				vendor: "OpenAI",
			},
		]);
		// Output must NOT carry `description`, `workspaceIds`, etc. when
		// the input did not set them — the optional-spread guard is what
		// enables forward-compat schema evolution.
		expect(out[0]).toEqual({
			agentId: "model:gpt-4o",
			name: "GPT-4o",
			modelOverride: "gpt-4o",
			vendor: "OpenAI",
		});
	});

	it("preserves null `description` and null `enabledMcpConfigIds` (the explicit-null sentinel)", () => {
		const out = persistSelectionShape([
			{
				agentId: "agent_a",
				name: "Helper",
				description: null,
				enabledMcpConfigIds: null,
			},
		]);
		expect(out[0]?.description).toBeNull();
		expect(out[0]?.enabledMcpConfigIds).toBeNull();
	});

	it("preserves array order across multiple chips", () => {
		const out = persistSelectionShape([
			{ agentId: "agent_a", name: "A" },
			{ agentId: "model:gpt-4o", name: "GPT-4o", vendor: "OpenAI" },
			{
				agentId: "template-instance:tmpl_1",
				name: "Template",
				instanceId: "tmpl_1",
			},
		]);
		expect(out.map((c) => c.agentId)).toEqual([
			"agent_a",
			"model:gpt-4o",
			"template-instance:tmpl_1",
		]);
	});

	it("treats the input as readonly (no in-place mutation, returns new objects)", () => {
		const input = [
			{
				agentId: "agent_a",
				name: "Helper",
				instructions: "prompt",
			},
		];
		const out = persistSelectionShape(input);
		// Caller's original object retains its `instructions` field —
		// the projection only affects the returned value.
		expect(input[0]).toHaveProperty("instructions");
		expect(out[0]).not.toBe(input[0]);
	});
});
