import { MODELS, TASK_DEFAULTS } from "@repo/database/prisma/ai-model-catalog";
import { describe, expect, it } from "vitest";

/**
 * Cross-layer preflight (Codex pass #3 — concern B3).
 *
 * The "reasoning surfacing" spec PR 5 will smoke production gateways
 * against four catalog canonical names: `gpt-5-2`, `o3-mini`,
 * `claude-sonnet-4-6`, and `gpt-4o`. If the catalog drifts away from any
 * of these names between PR 1 and PR 5, smokes will fail with a confusing
 * "model not found" error rather than the actual gateway-shape issue we
 * want to test.
 *
 * This preflight pins the catalog shape so a drift fails loudly here
 * instead of in a flaky smoke run. It is intentionally lightweight — pure
 * data-shape assertions, no DB or runtime calls.
 *
 * Not in scope: asserting that `TASK_DEFAULTS.REASONING.VERCEL_GATEWAY`
 * points at the "right" model. That's PR 5 (Fallback A) territory.
 */

type CatalogModel = (typeof MODELS)[number];

const findCanonical = (name: string): CatalogModel | undefined =>
	MODELS.find((m) => m.canonicalName === name);

const findProviderMapping = (model: CatalogModel, provider: string) =>
	model.providerMappings.find((p) => p.provider === provider);

describe("cross-layer preflight — production smoke models exist in catalog", () => {
	it("gpt-5-2 is present with VERCEL_GATEWAY mapping and REASONING capability (PR 5 smoke #1)", () => {
		const model = findCanonical("gpt-5-2");
		expect(model).toBeDefined();
		expect(model?.capabilities).toContain("REASONING");
		const mapping = findProviderMapping(model!, "VERCEL_GATEWAY");
		expect(mapping).toBeDefined();
		expect(mapping?.providerModelId).toBe("openai/gpt-5.2");
	});

	it("o3-mini is present with OPENAI_DIRECT mapping and REASONING capability (Fallback A — PR 5 smoke #2 follow-up)", () => {
		const model = findCanonical("o3-mini");
		expect(model).toBeDefined();
		expect(model?.capabilities).toContain("REASONING");
		// Fallback A pin: o3-mini USED to be reachable via VERCEL_GATEWAY too,
		// but Smoke #2 (PR 5) showed the gateway response never carries
		// reasoning summary text on this path (works on the wire — 30+ s
		// latency, tool calls, quality output — but no `reasoning` /
		// `reasoning_content` field). The user-facing "Thinking" affordance
		// stayed empty, so we removed the gateway mapping. The picker now
		// shows o3-mini as OPENAI_DIRECT only (where the Responses API does
		// surface reasoning), plus OPENROUTER for redundancy.
		const gateway = findProviderMapping(model!, "VERCEL_GATEWAY");
		expect(gateway).toBeUndefined();
		const direct = findProviderMapping(model!, "OPENAI_DIRECT");
		expect(direct).toBeDefined();
		expect(direct?.providerModelId).toBe("o3-mini");
	});

	it("claude-sonnet-4-6 is present with VERCEL_GATEWAY mapping (PR 5 regression smoke)", () => {
		const model = findCanonical("claude-sonnet-4-6");
		expect(model).toBeDefined();
		const mapping = findProviderMapping(model!, "VERCEL_GATEWAY");
		expect(mapping).toBeDefined();
		expect(mapping?.providerModelId).toBe("anthropic/claude-sonnet-4-6");
	});

	it("gpt-4o is present with VERCEL_GATEWAY mapping (PR 5 negative smoke)", () => {
		// Negative regression: gpt-4o is exposed via gateway but must NOT
		// be reasoning-capable for PR 5 to assert correctly. Today the
		// catalog flags it with REASONING capability — that's a separate
		// drift Codex B6 flagged; PR 5 will pick a different negative
		// example at implementation time if this still holds. For PR 1's
		// preflight we just assert the mapping exists.
		const model = findCanonical("gpt-4o");
		expect(model).toBeDefined();
		const mapping = findProviderMapping(model!, "VERCEL_GATEWAY");
		expect(mapping).toBeDefined();
		expect(mapping?.providerModelId).toBe("openai/gpt-4o");
	});
});

describe("cross-layer preflight — TASK_DEFAULTS resolution paths are sane", () => {
	it("REASONING task has at least one VERCEL_GATEWAY default entry", () => {
		const reasoningDefaults = TASK_DEFAULTS.filter(
			(d) =>
				d.taskType === "REASONING" && d.provider === "VERCEL_GATEWAY",
		);
		expect(reasoningDefaults.length).toBeGreaterThanOrEqual(1);
		// We deliberately do NOT assert which canonical name it points at —
		// Codex B8 flags `o1` as a stale choice and PR 5 will revisit. The
		// only requirement here is that SOME entry exists so the resolution
		// path doesn't return undefined.
		for (const d of reasoningDefaults) {
			expect(typeof d.canonicalName).toBe("string");
			expect(d.canonicalName.length).toBeGreaterThan(0);
		}
	});

	it("CHAT task has a VERCEL_GATEWAY default entry", () => {
		const chatDefaults = TASK_DEFAULTS.filter(
			(d) => d.taskType === "CHAT" && d.provider === "VERCEL_GATEWAY",
		);
		expect(chatDefaults.length).toBeGreaterThanOrEqual(1);
	});

	it("SIMPLE task has a VERCEL_GATEWAY default entry", () => {
		const simpleDefaults = TASK_DEFAULTS.filter(
			(d) => d.taskType === "SIMPLE" && d.provider === "VERCEL_GATEWAY",
		);
		expect(simpleDefaults.length).toBeGreaterThanOrEqual(1);
	});

	it("REASONING task defaults reference catalog canonical names that exist", () => {
		const reasoningDefaults = TASK_DEFAULTS.filter(
			(d) => d.taskType === "REASONING",
		);
		for (const d of reasoningDefaults) {
			const found = findCanonical(d.canonicalName);
			expect(
				found,
				`REASONING default ${d.provider}=${d.canonicalName} missing from MODELS`,
			).toBeDefined();
		}
	});
});
