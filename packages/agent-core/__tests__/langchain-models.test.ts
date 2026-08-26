import type { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
	hoistRawStopReason,
	isOutputTruncated,
	resolveStopReason,
} from "@repo/agent-core/output-truncation";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProviderConfig } from "../src/services/langchain-models";
import {
	applyReasoningConfig,
	createProviderModel,
	extractProviderConfig,
	getGatewayReasoningConfig,
	getReasoningConfig,
	isGatewayClaudeReasoningModel,
	isGatewayReasoningCapableModel,
	isReasoningCapableModel,
	MODEL_FAMILIES,
	REASONING_OUTPUT_TOKEN_ALLOWANCE,
	reasoningOutputAllowance,
	reasoningOutputAllowanceForConfig,
	resolveOutputTokenBudget,
} from "../src/services/langchain-models";

describe("isReasoningCapableModel", () => {
	// Anthropic — supports `thinking`
	it("returns true for claude-sonnet-4-5", () => {
		expect(
			isReasoningCapableModel("claude-sonnet-4-5", "ANTHROPIC_DIRECT"),
		).toBe(true);
	});
	it("returns true for claude-opus-4-7", () => {
		expect(
			isReasoningCapableModel("claude-opus-4-7", "ANTHROPIC_DIRECT"),
		).toBe(true);
	});
	it("returns true for claude-haiku-4-5", () => {
		expect(
			isReasoningCapableModel("claude-haiku-4-5", "ANTHROPIC_DIRECT"),
		).toBe(true);
	});
	it("returns false for claude-3-5-haiku (3.x family)", () => {
		expect(
			isReasoningCapableModel("claude-3-5-haiku", "ANTHROPIC_DIRECT"),
		).toBe(false);
	});

	// OpenAI — o-series supports `reasoning_effort` natively
	it("returns true for o3-mini", () => {
		expect(isReasoningCapableModel("o3-mini", "OPENAI_DIRECT")).toBe(true);
	});
	it("returns true for o1-preview", () => {
		expect(isReasoningCapableModel("o1-preview", "OPENAI_DIRECT")).toBe(
			true,
		);
	});
	it("returns true for o4-mini", () => {
		expect(isReasoningCapableModel("o4-mini", "OPENAI_DIRECT")).toBe(true);
	});

	// OpenAI — gpt-5 family supports `reasoning_effort` + `reasoning.summary` via Responses API.
	// Per Microsoft Learn + OpenAI Responses API docs, all gpt-5 SKUs EXCEPT `gpt-5-chat*`
	// accept reasoning_effort. The anchored regex enrolls them so the factory routes
	// via Responses API and the model emits reasoning summary text.
	it("returns true for bare gpt-5", () => {
		expect(isReasoningCapableModel("gpt-5", "OPENAI_DIRECT")).toBe(true);
	});
	it("returns true for gpt-5-nano", () => {
		expect(isReasoningCapableModel("gpt-5-nano", "OPENAI_DIRECT")).toBe(
			true,
		);
	});
	it("returns true for gpt-5-mini", () => {
		expect(isReasoningCapableModel("gpt-5-mini", "OPENAI_DIRECT")).toBe(
			true,
		);
	});
	it("returns true for gpt-5-pro", () => {
		expect(isReasoningCapableModel("gpt-5-pro", "OPENAI_DIRECT")).toBe(
			true,
		);
	});
	it("returns true for gpt-5.1", () => {
		expect(isReasoningCapableModel("gpt-5.1", "OPENAI_DIRECT")).toBe(true);
	});
	it("returns true for gpt-5.1-codex", () => {
		expect(isReasoningCapableModel("gpt-5.1-codex", "OPENAI_DIRECT")).toBe(
			true,
		);
	});
	it("returns true for gpt-5.2", () => {
		expect(isReasoningCapableModel("gpt-5.2", "OPENAI_DIRECT")).toBe(true);
	});
	it("returns true for gpt-5.4", () => {
		expect(isReasoningCapableModel("gpt-5.4", "OPENAI_DIRECT")).toBe(true);
	});

	// gpt-5-chat* is the non-reasoning flagship chat variant — explicitly excluded.
	it("returns false for gpt-5-chat", () => {
		expect(isReasoningCapableModel("gpt-5-chat", "OPENAI_DIRECT")).toBe(
			false,
		);
	});
	it("returns false for gpt-5-chat-latest", () => {
		expect(
			isReasoningCapableModel("gpt-5-chat-latest", "OPENAI_DIRECT"),
		).toBe(false);
	});

	// Non-reasoning OpenAI chat models stay excluded.
	it("returns false for gpt-4o (chat-only, no reasoning_effort)", () => {
		expect(isReasoningCapableModel("gpt-4o", "OPENAI_DIRECT")).toBe(false);
	});
	it("returns false for gpt-4.1", () => {
		expect(isReasoningCapableModel("gpt-4.1", "OPENAI_DIRECT")).toBe(false);
	});

	// Azure / Gateway providers — out of scope for THIS PR.
	// AZURE_AI_FOUNDRY Responses API support is per-tenant; deferred to follow-up.
	// Gateway providers tracked separately.
	it("returns false for Azure-hosted gpt-5-nano (out of scope for OPENAI_DIRECT PR)", () => {
		expect(isReasoningCapableModel("gpt-5-nano", "AZURE_AI_FOUNDRY")).toBe(
			false,
		);
	});

	// Other providers — out of scope
	it("returns false for Groq llama", () => {
		expect(isReasoningCapableModel("llama-3.3-70b", "GROQ")).toBe(false);
	});

	// Edge cases
	it("returns false for empty string", () => {
		expect(isReasoningCapableModel("", "ANTHROPIC_DIRECT")).toBe(false);
	});
	it("is case-insensitive at the wrapper level", () => {
		expect(
			isReasoningCapableModel("Claude-Sonnet-4-5", "ANTHROPIC_DIRECT"),
		).toBe(true);
	});
	it("is case-insensitive for gpt-5 family at the wrapper level", () => {
		expect(isReasoningCapableModel("GPT-5-Nano", "OPENAI_DIRECT")).toBe(
			true,
		);
	});

	// Defensive: gpt-5X (no separator) should NOT match — the regex requires
	// `-`, `.`, or end-of-string after `gpt-5` to avoid false positives on
	// hypothetical future names like `gpt-50` or `gpt-5x`.
	it("returns false for gpt-50 (no separator after gpt-5)", () => {
		expect(isReasoningCapableModel("gpt-50", "OPENAI_DIRECT")).toBe(false);
	});
});

describe("getReasoningConfig", () => {
	it("returns Anthropic thinking config for Claude Sonnet 4.5", () => {
		expect(
			getReasoningConfig("claude-sonnet-4-5", "ANTHROPIC_DIRECT"),
		).toEqual({
			thinking: { type: "enabled", budget_tokens: 5000 },
		});
	});

	it("returns OpenAI reasoning config (effort + summary + useResponsesApi) for o3-mini", () => {
		// summary: "detailed" requires the Responses API; setting useResponsesApi: true
		// makes the routing intent explicit (in addition to the auto-route triggered
		// by `reasoning.summary != null` in @langchain/openai's _useResponsesApi).
		expect(getReasoningConfig("o3-mini", "OPENAI_DIRECT")).toEqual({
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		});
	});

	it("returns OpenAI reasoning config for gpt-5-nano", () => {
		expect(getReasoningConfig("gpt-5-nano", "OPENAI_DIRECT")).toEqual({
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		});
	});

	it("returns OpenAI reasoning config for bare gpt-5", () => {
		expect(getReasoningConfig("gpt-5", "OPENAI_DIRECT")).toEqual({
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		});
	});

	it("returns null for non-reasoning-capable models", () => {
		expect(getReasoningConfig("gpt-4o", "OPENAI_DIRECT")).toBeNull();
		expect(
			getReasoningConfig("gpt-5-chat-latest", "OPENAI_DIRECT"),
		).toBeNull();
		expect(
			getReasoningConfig("claude-3-5-haiku", "ANTHROPIC_DIRECT"),
		).toBeNull();
	});

	it("returns null for AZURE_AI_FOUNDRY even with reasoning model (out of scope for OPENAI_DIRECT PR)", () => {
		expect(getReasoningConfig("gpt-5-nano", "AZURE_AI_FOUNDRY")).toBeNull();
		expect(getReasoningConfig("o3-mini", "AZURE_AI_FOUNDRY")).toBeNull();
	});

	it("returns null for unsupported providers", () => {
		expect(getReasoningConfig("llama-3.3-70b", "GROQ")).toBeNull();
	});
});

describe("applyReasoningConfig", () => {
	it("strips temperature/topP/topK when applying Anthropic thinking config", () => {
		const kwargs = {
			temperature: 0.7,
			topP: 0.9,
			topK: 50,
			maxTokens: 4096,
		};
		const reasoningConfig = {
			thinking: { type: "enabled", budget_tokens: 5000 },
		};
		const result = applyReasoningConfig(
			kwargs,
			reasoningConfig,
			"ANTHROPIC_DIRECT",
		);
		expect(result).toEqual({
			maxTokens: 4096,
			thinking: { type: "enabled", budget_tokens: 5000 },
		});
		expect(result).not.toHaveProperty("temperature");
		expect(result).not.toHaveProperty("topP");
		expect(result).not.toHaveProperty("topK");
	});

	it("preserves all kwargs when applying OpenAI reasoning config", () => {
		const kwargs = { temperature: 0.7, maxTokens: 4096 };
		const reasoningConfig = {
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		};
		const result = applyReasoningConfig(
			kwargs,
			reasoningConfig,
			"OPENAI_DIRECT",
		);
		// OpenAI o-series temperature handling is owned by the existing
		// isReasoningModel branch; applyReasoningConfig only adds reasoning kwargs.
		expect(result).toEqual({
			temperature: 0.7,
			maxTokens: 4096,
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		});
	});

	it("is a no-op when reasoningConfig is null", () => {
		const kwargs = { temperature: 0.7 };
		expect(applyReasoningConfig(kwargs, null, "ANTHROPIC_DIRECT")).toEqual(
			kwargs,
		);
	});

	it("does not mutate the input kwargs", () => {
		const kwargs = { temperature: 0.7, topP: 0.9 };
		const original = { ...kwargs };
		applyReasoningConfig(
			kwargs,
			{ thinking: { type: "enabled", budget_tokens: 5000 } },
			"ANTHROPIC_DIRECT",
		);
		expect(kwargs).toEqual(original);
	});
});

describe("isGatewayClaudeReasoningModel", () => {
	it("matches anthropic-prefixed gateway notation", () => {
		expect(
			isGatewayClaudeReasoningModel("anthropic/claude-sonnet-4-5"),
		).toBe(true);
		expect(isGatewayClaudeReasoningModel("anthropic/claude-opus-4.7")).toBe(
			true,
		);
		expect(
			isGatewayClaudeReasoningModel("anthropic/claude-haiku-4-0"),
		).toBe(true);
	});
	it("matches un-prefixed claude-sonnet-4-5 (defensive — some catalogs strip the prefix)", () => {
		expect(isGatewayClaudeReasoningModel("claude-sonnet-4-5")).toBe(true);
		expect(isGatewayClaudeReasoningModel("claude-opus-4.7")).toBe(true);
	});
	it("rejects Claude 3 family", () => {
		expect(isGatewayClaudeReasoningModel("claude-3-5-sonnet")).toBe(false);
		expect(
			isGatewayClaudeReasoningModel("anthropic/claude-3-5-haiku"),
		).toBe(false);
	});
	it("rejects non-Claude models (OpenAI, generic)", () => {
		expect(isGatewayClaudeReasoningModel("openai/gpt-4o")).toBe(false);
		expect(isGatewayClaudeReasoningModel("openai/o3-mini")).toBe(false);
		expect(isGatewayClaudeReasoningModel("")).toBe(false);
	});
});

describe("getGatewayReasoningConfig", () => {
	it("returns config for Vercel gateway providers + Claude 4.x", () => {
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-sonnet-4-5",
				"VERCEL_GATEWAY",
			),
		).toEqual({ reasoning: { enabled: true, max_tokens: 5000 } });
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-opus-4.7",
				"VERCEL_AI_GATEWAY",
			),
		).toEqual({ reasoning: { enabled: true, max_tokens: 5000 } });
	});
	it("returns null for non-Vercel gateways (OpenRouter, Cloudflare) even on Claude 4.x", () => {
		// The `reasoning: { enabled, max_tokens }` shape is a Vercel Gateway
		// extension. Other gateways may 4xx on unknown top-level fields, so
		// we deliberately stay out of their request bodies.
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-sonnet-4-5",
				"OPENROUTER" as RuntimeProviderConfig["provider"],
			),
		).toBeNull();
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-sonnet-4-5",
				"CLOUDFLARE_AI" as RuntimeProviderConfig["provider"],
			),
		).toBeNull();
	});
	it("returns null for Vercel gateway + non-Claude models", () => {
		expect(
			getGatewayReasoningConfig("openai/gpt-4o", "VERCEL_GATEWAY"),
		).toBeNull();
		expect(getGatewayReasoningConfig("", "VERCEL_GATEWAY")).toBeNull();
	});
	it("returns null for direct providers (defensive — caller should not hit this branch)", () => {
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-sonnet-4-5",
				"ANTHROPIC_DIRECT",
			),
		).toBeNull();
	});
});

describe("createProviderModel — OPENAI_DIRECT reasoning integration", () => {
	// Wire-level helper: @langchain/openai's BaseChatOpenAI._getReasoningParams()
	// (base.cjs:233-234) gates `this.reasoning` on `isReasoningModel(this.model)`.
	// If we set the kwargs correctly but pass a model name the wire gate rejects,
	// the request silently omits `reasoning`. Instance-field checks alone are
	// not enough — we must verify the gate emits the expected object too.
	type WireGatedModel = { _getReasoningParams: (opts?: unknown) => unknown };
	function getWireReasoningParams(model: unknown): unknown {
		const fn = (model as Partial<WireGatedModel>)._getReasoningParams;
		if (typeof fn !== "function") {
			throw new Error(
				"@langchain/openai API changed: `_getReasoningParams` is no longer a method on ChatOpenAI instances. " +
					"This wire-level test helper relies on calling it directly. " +
					"Re-verify base.cjs:233-234 for the new reasoning gate entry point.",
			);
		}
		return fn.call(model);
	}

	it("Anthropic + Claude 4.5 → ChatAnthropic with thinking kwarg, no temperature", () => {
		const model = createProviderModel(
			{
				provider: "ANTHROPIC_DIRECT",
				model: "claude-sonnet-4-5",
				apiKey: "test-key",
			},
			{ temperature: 0.7, maxTokens: 4096 },
		) as ChatAnthropic;

		expect((model as unknown as { thinking?: unknown }).thinking).toEqual({
			type: "enabled",
			budget_tokens: 5000,
		});
		expect(
			(model as unknown as { temperature?: number }).temperature,
		).toBeUndefined();
	});

	it("Anthropic + Claude 3.5 Haiku → ChatAnthropic WITHOUT thinking", () => {
		const model = createProviderModel(
			{
				provider: "ANTHROPIC_DIRECT",
				model: "claude-3-5-haiku",
				apiKey: "test-key",
			},
			{ temperature: 0.7 },
		) as ChatAnthropic;

		const thinking = (model as unknown as { thinking?: { type?: string } })
			.thinking;
		expect(thinking?.type).not.toBe("enabled");
		expect((model as unknown as { temperature?: number }).temperature).toBe(
			0.7,
		);
	});

	it("OpenAI + o3-mini → ChatOpenAI with reasoning kwarg + summary + useResponsesApi reaching the wire", () => {
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "o3-mini",
				apiKey: "test-key",
			},
			{},
		) as ChatOpenAI;

		expect((model as unknown as { reasoning?: unknown }).reasoning).toEqual(
			{
				effort: "medium",
				summary: "detailed",
			},
		);
		expect(
			(model as unknown as { useResponsesApi?: boolean }).useResponsesApi,
		).toBe(true);
		expect((model as unknown as { model?: string }).model).toBe("o3-mini");
		// Wire-level gate: reasoning object must reach the actual request shape,
		// not just be set on the instance.
		expect(getWireReasoningParams(model)).toEqual({
			effort: "medium",
			summary: "detailed",
		});
	});

	it("OpenAI + gpt-5-nano → ChatOpenAI with reasoning kwarg reaching the wire", () => {
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "gpt-5-nano",
				apiKey: "test-key",
			},
			{},
		) as ChatOpenAI;

		expect((model as unknown as { reasoning?: unknown }).reasoning).toEqual(
			{
				effort: "medium",
				summary: "detailed",
			},
		);
		expect(
			(model as unknown as { useResponsesApi?: boolean }).useResponsesApi,
		).toBe(true);
		expect((model as unknown as { model?: string }).model).toBe(
			"gpt-5-nano",
		);
		expect(getWireReasoningParams(model)).toEqual({
			effort: "medium",
			summary: "detailed",
		});
	});

	it("OpenAI + bare gpt-5 → ChatOpenAI strips maxTokens/temperature via requiresParamStrip + reasoningConfig OR", () => {
		// Historical context (pre-PR 5 architecture, retained as a
		// regression note for future archaeologists):
		//   The v1 implementation had two parallel lists — REASONING_MODELS
		//   (substring .includes()) and REASONING_CAPABLE_PATTERNS (anchored
		//   regex). Bare "gpt-5" matched the anchored regex but NOT the
		//   substring list (adding it would substring-match
		//   "gpt-5-chat-latest" and incorrectly strip ITS temperature).
		//   The strip gate had to trigger on EITHER signal.
		// PR 5 architecture: both signals now read from MODEL_FAMILIES
		// (`requiresParamStrip` + `directBranchReasoning`). Bare "gpt-5"
		// matches the `openai-gpt-5` family which has BOTH flags. The
		// `stripChatCompletionsParams = isReasoning || reasoningConfig !== null`
		// OR is preserved at the call site for defense-in-depth — if a
		// future family flags one without the other, the strip still fires.
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "gpt-5",
				apiKey: "test-key",
			},
			{ temperature: 0.7, maxTokens: 4096 },
		) as ChatOpenAI;

		expect((model as unknown as { reasoning?: unknown }).reasoning).toEqual(
			{
				effort: "medium",
				summary: "detailed",
			},
		);
		expect(
			(model as unknown as { useResponsesApi?: boolean }).useResponsesApi,
		).toBe(true);
		expect((model as unknown as { model?: string }).model).toBe("gpt-5");
		expect(
			(model as unknown as { maxTokens?: number }).maxTokens,
		).toBeUndefined();
		expect(
			(model as unknown as { temperature?: number }).temperature,
		).toBeUndefined();
		expect(getWireReasoningParams(model)).toEqual({
			effort: "medium",
			summary: "detailed",
		});
	});

	it("OpenAI + mixed-case O1-Mini → lowercased so upstream case-sensitive isReasoningModel accepts it", () => {
		// @langchain/openai's wire-level isReasoningModel (misc.cjs:6-11) is
		// case-SENSITIVE: it uses model.startsWith("gpt-5") and /^o\d/.test(model).
		// Our MODEL_FAMILIES regex uses /i flag, so we'd accept "O1-Mini"
		// but the wire gate would silently reject. Lowercasing the model field
		// closes this divergence.
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "O1-Mini",
				apiKey: "test-key",
			},
			{},
		) as ChatOpenAI;

		expect((model as unknown as { reasoning?: unknown }).reasoning).toEqual(
			{
				effort: "medium",
				summary: "detailed",
			},
		);
		expect(
			(model as unknown as { useResponsesApi?: boolean }).useResponsesApi,
		).toBe(true);
		expect((model as unknown as { model?: string }).model).toBe("o1-mini");
		expect(getWireReasoningParams(model)).toEqual({
			effort: "medium",
			summary: "detailed",
		});
	});

	it("OpenAI + mixed-case non-reasoning model → preserves user case (no spurious lowercasing)", () => {
		// Lowercasing is GATED on reasoningConfig !== null. Non-reasoning paths
		// preserve user case to avoid breaking OpenAI-compatible custom endpoints
		// (vLLM, ollama, LiteLLM proxies) where model names may be case-sensitive.
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "My-Custom-Model-Name",
				apiKey: "test-key",
			},
			{ temperature: 0.7 },
		) as ChatOpenAI;

		expect((model as unknown as { model?: string }).model).toBe(
			"My-Custom-Model-Name",
		);
		expect(
			(model as unknown as { reasoning?: unknown }).reasoning,
		).toBeUndefined();
	});

	it("OpenAI + gpt-4o → ChatOpenAI WITHOUT reasoning kwarg", () => {
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "gpt-4o",
				apiKey: "test-key",
			},
			{ temperature: 0.7 },
		) as ChatOpenAI;

		expect(
			(model as unknown as { reasoning?: unknown }).reasoning,
		).toBeUndefined();
		expect(
			(model as unknown as { useResponsesApi?: boolean }).useResponsesApi,
		).toBe(false);
		// Wire-level negative: even with model set, _getReasoningParams returns
		// undefined because isReasoningModel rejects gpt-4o.
		expect(getWireReasoningParams(model)).toBeUndefined();
	});

	it("OpenAI + gpt-5-chat-latest → ChatOpenAI WITHOUT reasoning kwarg (excluded chat variant)", () => {
		const model = createProviderModel(
			{
				provider: "OPENAI_DIRECT",
				model: "gpt-5-chat-latest",
				apiKey: "test-key",
			},
			{ temperature: 0.7 },
		) as ChatOpenAI;

		expect(
			(model as unknown as { reasoning?: unknown }).reasoning,
		).toBeUndefined();
		expect(
			(model as unknown as { useResponsesApi?: boolean }).useResponsesApi,
		).toBe(false);
		// Wire-level negative: @langchain/openai's isReasoningModel excludes
		// gpt-5-chat* via `startsWith("gpt-5") && !startsWith("gpt-5-chat")`.
		expect(getWireReasoningParams(model)).toBeUndefined();
	});

	it("Vercel Gateway + anthropic/claude-sonnet-4-5 → ChatOpenAI with modelKwargs.reasoning, no temperature, __includeRawResponse=true", () => {
		const model = createProviderModel(
			{
				provider: "VERCEL_GATEWAY",
				model: "anthropic/claude-sonnet-4-5",
				apiKey: "test-key",
				baseUrl: "https://ai-gateway.vercel.sh/v1",
			},
			{ temperature: 0.7, maxTokens: 4096 },
		) as ChatOpenAI;

		// reasoning lives in modelKwargs so it spreads at the body root
		// (completions.cjs:47). NOT in the LangChain native `reasoning` field
		// (which would serialize as `reasoning_effort` for OpenAI's API).
		const kwargs = (
			model as unknown as { modelKwargs?: Record<string, unknown> }
		).modelKwargs;
		expect(kwargs?.reasoning).toEqual({ enabled: true, max_tokens: 5000 });
		// temperature stripped (Anthropic rejects non-default temperature when
		// thinking is enabled; gateway is a thin pass-through).
		expect(
			(model as unknown as { temperature?: number }).temperature,
		).toBeUndefined();
		// maxTokens stripped (Anthropic enforces thinking.budget_tokens < max_tokens
		// strictly — see https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
		// With our budget at 5000 and the agent passing maxTokens=4096, retaining
		// maxTokens would trigger HTTP 400 every call. Omitting it lets
		// Anthropic apply its model-specific default (all > 5000 for Claude 4.x).
		expect(
			(model as unknown as { maxTokens?: number }).maxTokens,
		).toBeUndefined();
		// Raw response capture is required so the agent extractor can recover
		// message.reasoning text (LangChain's converter drops it).
		expect(
			(model as unknown as { __includeRawResponse?: boolean })
				.__includeRawResponse,
		).toBe(true);
	});

	it("Vercel Gateway + openai/gpt-4o → ChatOpenAI WITHOUT reasoning kwarg, temperature + maxTokens preserved", () => {
		const model = createProviderModel(
			{
				provider: "VERCEL_GATEWAY",
				model: "openai/gpt-4o",
				apiKey: "test-key",
				baseUrl: "https://ai-gateway.vercel.sh/v1",
			},
			{ temperature: 0.7, maxTokens: 4096 },
		) as ChatOpenAI;

		const kwargs = (
			model as unknown as { modelKwargs?: Record<string, unknown> }
		).modelKwargs;
		expect(kwargs?.reasoning).toBeUndefined();
		expect((model as unknown as { temperature?: number }).temperature).toBe(
			0.7,
		);
		// maxTokens preserved on the non-enrollment path (no thinking budget conflict).
		expect((model as unknown as { maxTokens?: number }).maxTokens).toBe(
			4096,
		);
		expect(
			(model as unknown as { __includeRawResponse?: boolean })
				.__includeRawResponse,
		).toBeFalsy();
	});

	it("Vercel Gateway + un-prefixed claude-opus-4.7 → reasoning enrolled", () => {
		// Some catalogs may emit canonical names without provider prefix.
		const model = createProviderModel(
			{
				provider: "VERCEL_GATEWAY",
				model: "claude-opus-4.7",
				apiKey: "test-key",
				baseUrl: "https://ai-gateway.vercel.sh/v1",
			},
			{},
		) as ChatOpenAI;
		const kwargs = (
			model as unknown as { modelKwargs?: Record<string, unknown> }
		).modelKwargs;
		expect(kwargs?.reasoning).toEqual({ enabled: true, max_tokens: 5000 });
	});

	it("OpenRouter + claude-sonnet-4-5 → NO reasoning kwarg (Vercel extension is not portable)", () => {
		// OpenRouter is in GATEWAY_PROVIDERS but does not honor Vercel's
		// `reasoning: { enabled, max_tokens }` body extension. Safer to send
		// the un-extended body — if the user wants Claude reasoning through
		// OpenRouter, they should use ANTHROPIC_DIRECT or wait for an
		// OpenRouter-specific enrollment.
		const model = createProviderModel(
			{
				provider: "OPENROUTER",
				model: "anthropic/claude-sonnet-4-5",
				apiKey: "test-key",
				baseUrl: "https://openrouter.ai/api/v1",
			},
			{ temperature: 0.7 },
		) as ChatOpenAI;
		const kwargs = (
			model as unknown as { modelKwargs?: Record<string, unknown> }
		).modelKwargs;
		expect(kwargs?.reasoning).toBeUndefined();
		// temperature preserved (no reasoning enrollment, no strip)
		expect((model as unknown as { temperature?: number }).temperature).toBe(
			0.7,
		);
	});

	it("Cloudflare AI + claude-sonnet-4-5 → NO reasoning kwarg (same rationale as OpenRouter)", () => {
		const model = createProviderModel(
			{
				provider: "CLOUDFLARE_AI",
				model: "anthropic/claude-sonnet-4-5",
				apiKey: "test-key",
				baseUrl:
					"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>",
			},
			{ temperature: 0.5 },
		) as ChatOpenAI;
		const kwargs = (
			model as unknown as { modelKwargs?: Record<string, unknown> }
		).modelKwargs;
		expect(kwargs?.reasoning).toBeUndefined();
		expect((model as unknown as { temperature?: number }).temperature).toBe(
			0.5,
		);
	});
});

describe("createProviderModel — gateway wire body", () => {
	it("emits top-level reasoning: { enabled, max_tokens } in invocationParams for Claude 4.x", () => {
		const model = createProviderModel(
			{
				provider: "VERCEL_GATEWAY",
				model: "anthropic/claude-sonnet-4-5",
				apiKey: "test-key",
				baseUrl: "https://ai-gateway.vercel.sh/v1",
			},
			{},
		) as ChatOpenAI;
		// invocationParams() is the canonical wire-body builder
		// (completions.cjs:17). modelKwargs spreads into it at line 47.
		const params = (
			model as unknown as {
				invocationParams: (
					opts: Record<string, unknown>,
				) => Record<string, unknown>;
			}
		).invocationParams({});
		expect(params.reasoning).toEqual({ enabled: true, max_tokens: 5000 });
		// And confirm we didn't accidentally also set the OpenAI-native
		// reasoning_effort field — that would route through the wrong
		// shape and the gateway would silently ignore it.
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("emits top-level reasoning: { effort: 'medium' } in invocationParams for OpenAI o-series (PR 5 wire-shape regression guard)", () => {
		// Codex pass on PR 5 (Concern 10): the existing Claude wire-body
		// assertion catches drift in how ChatOpenAI's `modelKwargs` spreads
		// into the wire body — but the OpenAI gateway path lacked the same
		// coverage. This locks in the OpenAI-shape contract at the same
		// level. If a future @langchain/openai bump stops spreading
		// modelKwargs into invocationParams, this assertion fails loudly
		// before the model is invoked.
		const model = createProviderModel(
			{
				provider: "VERCEL_GATEWAY",
				model: "openai/o3-mini",
				apiKey: "test-key",
				baseUrl: "https://ai-gateway.vercel.sh/v1",
			},
			{},
		) as ChatOpenAI;
		const params = (
			model as unknown as {
				invocationParams: (
					opts: Record<string, unknown>,
				) => Record<string, unknown>;
			}
		).invocationParams({});
		expect(params.reasoning).toEqual({ effort: "medium" });
		// We must NOT accidentally also set the Vercel-native
		// `reasoning: { enabled, max_tokens }` shape — that would route
		// through the Anthropic mapping branch of the gateway and produce
		// a wire mismatch for an OpenAI model.
		expect(
			(params.reasoning as { enabled?: unknown }).enabled,
		).toBeUndefined();
		expect(
			(params.reasoning as { max_tokens?: unknown }).max_tokens,
		).toBeUndefined();
	});
});

describe("extractProviderConfig — ai_is_reasoning propagation (Bug #1942 review)", () => {
	const base = {
		ai_api_key: "test-key",
		ai_model: "prod-chat",
		ai_provider: "DATABRICKS",
		ai_gateway_url: "https://x.databricks.net",
	};

	it("carries a boolean ai_is_reasoning through to isReasoningModel", () => {
		expect(
			extractProviderConfig({
				configurable: { ...base, ai_is_reasoning: true },
			})?.isReasoningModel,
		).toBe(true);
		expect(
			extractProviderConfig({
				configurable: { ...base, ai_is_reasoning: false },
			})?.isReasoningModel,
		).toBe(false);
	});

	it("leaves isReasoningModel undefined when the flag is absent (name fallback applies downstream)", () => {
		expect(
			extractProviderConfig({ configurable: base })?.isReasoningModel,
		).toBeUndefined();
	});

	it("ignores a non-boolean ai_is_reasoning", () => {
		expect(
			extractProviderConfig({
				// A stray string should not be trusted as a boolean signal.
				configurable: { ...base, ai_is_reasoning: "yes" },
			})?.isReasoningModel,
		).toBeUndefined();
	});
});

describe("createProviderModel — DATABRICKS branch", () => {
	// Codex review (issue #2781 follow-up): __includeRawResponse was set ONLY
	// on the Vercel gateway branch. The Databricks branch never set it, so
	// @langchain/openai's real converter (verified empirically — see the
	// invoke-level test below) omits additional_kwargs.__raw_response, making
	// hoistRawStopReason dead code on system.ai.claude-sonnet-5 — the
	// incident model — since that's the ONLY place a Databricks response's
	// stop reason exists (response_metadata carries none).
	it("passes __includeRawResponse: true so the raw response envelope is retained for hoistRawStopReason", () => {
		const model = createProviderModel(
			{
				provider: "DATABRICKS",
				model: "system.ai.claude-sonnet-5",
				apiKey: "test-key",
				baseUrl: "https://adb-123.4.azuredatabricks.net",
			},
			{},
		) as ChatOpenAI;
		expect(
			(model as unknown as { __includeRawResponse?: boolean })
				.__includeRawResponse,
		).toBe(true);
	});

	it("DATABRICKS branch builds a ChatOpenAI pointed at the verbatim Unity AI Gateway path", () => {
		const model = createProviderModel(
			{
				provider: "DATABRICKS",
				model: "system.ai.claude-sonnet-5",
				apiKey: "test-key",
				baseUrl:
					"https://adb-123.4.azuredatabricks.net/ai-gateway/mlflow/v1",
			},
			{},
		) as ChatOpenAI;
		const baseURL = (
			model as unknown as { clientConfig?: { baseURL?: string } }
		).clientConfig?.baseURL;
		expect(baseURL).toBe(
			"https://adb-123.4.azuredatabricks.net/ai-gateway/mlflow/v1",
		);
	});

	it("DATABRICKS branch appends /serving-endpoints for a bare workspace host", () => {
		const model = createProviderModel(
			{
				provider: "DATABRICKS",
				model: "system.ai.claude-sonnet-5",
				apiKey: "test-key",
				baseUrl: "https://adb-123.4.azuredatabricks.net",
			},
			{},
		) as ChatOpenAI;
		const baseURL = (
			model as unknown as { clientConfig?: { baseURL?: string } }
		).clientConfig?.baseURL;
		expect(baseURL).toBe(
			"https://adb-123.4.azuredatabricks.net/serving-endpoints",
		);
	});

	// Databricks-served Claude models reject `temperature` (HTTP 400), and a
	// custom serving endpoint can front Claude under an arbitrary name that
	// reveals nothing about the model family — so temperature is omitted for
	// ALL Databricks requests (matching the @ai-sdk/Vercel path).
	const databricksInvocationParams = (model: string) => {
		const m = createProviderModel(
			{
				provider: "DATABRICKS",
				model,
				apiKey: "test-key",
				baseUrl:
					"https://adb-123.4.azuredatabricks.net/ai-gateway/mlflow/v1",
			},
			{ temperature: 0.7 },
		) as ChatOpenAI;
		return (
			m as unknown as {
				invocationParams: (
					o: Record<string, unknown>,
				) => Record<string, unknown>;
			}
		).invocationParams({});
	};

	// The key may be present as `undefined`, but an undefined value is dropped
	// from the serialized request body — verified against the wire body — so
	// Databricks never receives the rejected `temperature` field.
	it("omits temperature for a built-in Databricks Claude model id", () => {
		expect(
			databricksInvocationParams("system.ai.claude-sonnet-5").temperature,
		).toBeUndefined();
	});

	it("omits temperature for an arbitrary custom endpoint name (may front Claude)", () => {
		expect(
			databricksInvocationParams("prod-chat").temperature,
		).toBeUndefined();
	});

	it("omits temperature even for an obviously non-Claude Databricks model", () => {
		expect(
			databricksInvocationParams("databricks-meta-llama-3-3-70b-instruct")
				.temperature,
		).toBeUndefined();
	});
});

/**
 * Codex review (issue #2781 follow-up): reaching into
 * `@langchain/openai`'s internal converter file directly is blocked —
 * its `package.json` `exports` map only allows the `.` and `./package.json`
 * subpaths (verified), so a hand-built envelope was the only option for a
 * unit test that stays inside that boundary. This describe block instead
 * drives a REAL `ChatOpenAI.invoke()` call — the same public entry point
 * production code uses — against a stubbed HTTP transport (the same
 * `configuration.fetch` extension point `createProviderModel`'s Databricks
 * branch already uses for `databricksFetch`), so the actual
 * `@langchain/openai` response converter runs, not an assumption about it.
 *
 * The choice object below uses `stop_reason` (Anthropic-native naming), NOT
 * `finish_reason`, and this is load-bearing for the test to mean anything:
 * verified directly against @langchain/openai 1.2.7 that its OWN
 * `_generate()` (chat_models/completions.cjs) unconditionally copies
 * `choices[0].finish_reason` into `response_metadata.finish_reason` via
 * `generationInfo` — independent of `__includeRawResponse` entirely. A
 * response that already carries `finish_reason` would reach
 * `response_metadata` regardless of this fix, making `hoistRawStopReason`
 * a no-op in the test and proving nothing. The real Databricks defect
 * (`response_metadata` holding only `model_provider`/usage fields — see
 * `hoistRawStopReason`'s doc in `output-truncation.ts`) is consistent with
 * a gateway that proxies Anthropic's native `stop_reason` key through its
 * OpenAI-compat choice object untranslated: `_generate()`'s built-in copy
 * only checks `finish_reason` and misses it, so ONLY the raw envelope
 * (gated on `__includeRawResponse`) carries it — which is exactly what
 * `hoistRawStopReason` reads via its `stop_reason` fallback.
 */
describe("ChatOpenAI real converter — __includeRawResponse retention (issue #2781 follow-up)", () => {
	const rawCompletionsResponse = {
		id: "chatcmpl-test",
		object: "chat.completion",
		created: 1700000000,
		model: "system.ai.claude-sonnet-5",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "Hello" },
				// Anthropic-native key, untranslated by the (simulated) gateway —
				// see the describe-block doc above for why this, not
				// `finish_reason`, is what makes this test meaningful.
				stop_reason: "max_tokens",
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	};

	function stubbedFetch() {
		return vi.fn().mockResolvedValue(
			new Response(JSON.stringify(rawCompletionsResponse), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}

	it("retains additional_kwargs.__raw_response (and its stop_reason) end-to-end when __includeRawResponse is set — the exact mechanism the Databricks branch now depends on", async () => {
		const model = new ChatOpenAI({
			model: "system.ai.claude-sonnet-5",
			apiKey: "test-key",
			maxTokens: 4096,
			configuration: {
				baseURL:
					"https://adb-123.4.azuredatabricks.net/serving-endpoints",
				fetch: stubbedFetch(),
			},
			__includeRawResponse: true,
		} as ConstructorParameters<typeof ChatOpenAI>[0]);

		const result = await model.invoke([new HumanMessage("hi")]);

		// Confirms @langchain/openai's own built-in copy does NOT surface this
		// key (only `finish_reason` is checked) — without this assertion the
		// test could pass even if hoistRawStopReason contributed nothing.
		expect(resolveStopReason(result)).toBeUndefined();

		hoistRawStopReason(result);
		expect(resolveStopReason(result)).toBe("max_tokens");
		expect(isOutputTruncated(result)).toBe(true);
	});

	it("regression contrast: drops the envelope (Codex's empirically-verified failure mode) when __includeRawResponse is unset — proves the flag, not test setup, is what makes the hoist work", async () => {
		const model = new ChatOpenAI({
			model: "system.ai.claude-sonnet-5",
			apiKey: "test-key",
			maxTokens: 4096,
			configuration: {
				baseURL:
					"https://adb-123.4.azuredatabricks.net/serving-endpoints",
				fetch: stubbedFetch(),
			},
			// __includeRawResponse intentionally omitted — this is the shape the
			// Databricks branch had BEFORE this fix.
		} as ConstructorParameters<typeof ChatOpenAI>[0]);

		const result = await model.invoke([new HumanMessage("hi")]);

		hoistRawStopReason(result);
		expect(resolveStopReason(result)).toBeUndefined();
		expect(isOutputTruncated(result)).toBe(false);
	});
});

describe("createProviderModel — base-URL-required provider without a base URL", () => {
	// The ai-config route now sends gatewayUrl: null for base-URL-required
	// providers with none configured (rather than an OpenRouter fallback). These
	// two providers (CUSTOM / AZURE_OPENAI) have no dedicated branch and used to
	// fall through to the default case, which silently built a client against
	// api.openai.com / Groq with the tenant's key. The default-case guard makes
	// that a clear, loud error instead — the same intent as the route change.
	it("throws for a CUSTOM provider with no base URL (no silent OpenAI fallback)", () => {
		expect(() =>
			createProviderModel(
				{ provider: "CUSTOM", model: "some-model", apiKey: "test-key" },
				{},
			),
		).toThrow(/requires a base URL/i);
	});

	it("throws for an AZURE_OPENAI provider with no base URL", () => {
		expect(() =>
			createProviderModel(
				{
					provider: "AZURE_OPENAI",
					model: "gpt-4o",
					apiKey: "test-key",
				},
				{},
			),
		).toThrow(/requires a base URL/i);
	});

	it("throws for a CUSTOM provider even when the model looks Groq-like", () => {
		// Without the guard, a `llama*` model id would silently route to Groq.
		expect(() =>
			createProviderModel(
				{
					provider: "CUSTOM",
					model: "llama-3.3-70b-versatile",
					apiKey: "test-key",
				},
				{},
			),
		).toThrow(/requires a base URL/i);
	});

	it("still builds a model against the custom base URL when one is provided", () => {
		const model = createProviderModel(
			{
				provider: "CUSTOM",
				model: "some-model",
				apiKey: "test-key",
				baseUrl: "https://my-endpoint.example.com/v1",
			},
			{},
		) as ChatOpenAI;
		const baseURL = (
			model as unknown as { clientConfig?: { baseURL?: string } }
		).clientConfig?.baseURL;
		expect(baseURL).toBe("https://my-endpoint.example.com/v1");
	});

	it("preserves the provider-less Groq heuristic (no provider specified)", () => {
		// The guard is gated on `provider` being truthy, so the genuine
		// no-provider last-resort path is untouched.
		expect(() =>
			createProviderModel(
				{ provider: undefined, model: "llama-3.3-70b", apiKey: "k" },
				{},
			),
		).not.toThrow();
	});
});

// =============================================================================
// PR 5 — Multi-family Gateway reasoning enrolment (OpenAI o-series + gpt-5)
// =============================================================================
//
// 16 new cases extending getGatewayReasoningConfig + isGatewayReasoningCapableModel
// + isGatewayClaudeReasoningModel (back-compat) + integration coverage of the
// Gateway branch creating ChatOpenAI with the per-family modelKwargs shape.
// Plus 4 cases on MODEL_FAMILIES table integrity (exhaustiveness, no overlaps,
// parity vs the deleted v1 lists).

describe("PR 5 — getGatewayReasoningConfig multi-family extension", () => {
	it("OpenAI o3 + VERCEL_GATEWAY → reasoning.effort = 'medium'", () => {
		expect(
			getGatewayReasoningConfig("openai/o3", "VERCEL_GATEWAY"),
		).toEqual({ reasoning: { effort: "medium" } });
	});

	it("OpenAI o1-mini + VERCEL_GATEWAY → reasoning.effort = 'medium'", () => {
		expect(
			getGatewayReasoningConfig("openai/o1-mini", "VERCEL_GATEWAY"),
		).toEqual({ reasoning: { effort: "medium" } });
	});

	it("OpenAI bare gpt-5 + VERCEL_GATEWAY → reasoning.effort = 'medium'", () => {
		expect(
			getGatewayReasoningConfig("openai/gpt-5", "VERCEL_GATEWAY"),
		).toEqual({ reasoning: { effort: "medium" } });
	});

	it("OpenAI gpt-5-mini + VERCEL_GATEWAY → reasoning.effort = 'medium' (defense-in-depth permissive — Codex B2)", () => {
		// Even though the catalog does NOT flag gpt-5-mini with REASONING
		// capability, MODEL_FAMILIES is intentionally permissive at runtime.
		// Documented as a defense-in-depth split in MODEL_FAMILIES JSDoc.
		expect(
			getGatewayReasoningConfig("openai/gpt-5-mini", "VERCEL_GATEWAY"),
		).toEqual({ reasoning: { effort: "medium" } });
	});

	it("OpenAI gpt-5.1-codex + VERCEL_GATEWAY → reasoning.effort = 'medium' (dotted variant)", () => {
		expect(
			getGatewayReasoningConfig("openai/gpt-5.1-codex", "VERCEL_GATEWAY"),
		).toEqual({ reasoning: { effort: "medium" } });
	});

	it("OpenAI gpt-5-chat-latest + VERCEL_GATEWAY → null (excluded chat variant)", () => {
		// Negative lookahead in the regex must exclude the chat-tuned
		// non-reasoning flagship. If this regresses, gpt-5-chat sessions
		// would silently pay reasoning tokens on every turn.
		expect(
			getGatewayReasoningConfig(
				"openai/gpt-5-chat-latest",
				"VERCEL_GATEWAY",
			),
		).toBeNull();
	});

	it("OpenAI gpt-4o + VERCEL_GATEWAY → null (gpt-4o is NOT reasoning-capable on gateway)", () => {
		expect(
			getGatewayReasoningConfig("openai/gpt-4o", "VERCEL_GATEWAY"),
		).toBeNull();
	});

	it("Anthropic claude-sonnet-3.5 + VERCEL_GATEWAY → null (Claude 3.x is NOT reasoning-capable)", () => {
		// Note: dot-version after `3` would match `4.x` regex if we weren't
		// careful — but `3.5` is the 3-family which the regex anchors out.
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-sonnet-3-5",
				"VERCEL_GATEWAY",
			),
		).toBeNull();
	});

	it("OpenAI o3 + OPENROUTER → null (OpenRouter rejects Vercel reasoning extension)", () => {
		expect(getGatewayReasoningConfig("openai/o3", "OPENROUTER")).toBeNull();
	});

	it("OpenAI o3 + CLOUDFLARE_AI → null (Cloudflare rejects Vercel reasoning extension)", () => {
		expect(
			getGatewayReasoningConfig("openai/o3", "CLOUDFLARE_AI"),
		).toBeNull();
	});

	it("VERCEL_AI_GATEWAY enum alias also routes correctly (Codex B7 parity check)", () => {
		// VERCEL_AI_GATEWAY is the runtime enum variant emitted by some
		// CopilotKit code paths; VERCEL_GATEWAY is the catalog enum. Both
		// must produce identical kwargs.
		expect(
			getGatewayReasoningConfig("openai/o3", "VERCEL_AI_GATEWAY"),
		).toEqual({ reasoning: { effort: "medium" } });
		expect(
			getGatewayReasoningConfig(
				"anthropic/claude-sonnet-4-6",
				"VERCEL_AI_GATEWAY",
			),
		).toEqual({ reasoning: { enabled: true, max_tokens: 5000 } });
	});
});

describe("PR 5 — isGatewayReasoningCapableModel (generalized capability check)", () => {
	it("claude-sonnet-4-6 → true", () => {
		expect(
			isGatewayReasoningCapableModel("anthropic/claude-sonnet-4-6"),
		).toBe(true);
	});

	it("o3 → true", () => {
		expect(isGatewayReasoningCapableModel("openai/o3")).toBe(true);
	});

	it("gpt-4o → false", () => {
		expect(isGatewayReasoningCapableModel("openai/gpt-4o")).toBe(false);
	});

	it("gpt-5-chat-latest → false (chat-tuned variant excluded)", () => {
		expect(isGatewayReasoningCapableModel("openai/gpt-5-chat-latest")).toBe(
			false,
		);
	});

	it("codex-mini → false (param-strip family without reasoning emission)", () => {
		// codex-mini IS in MODEL_FAMILIES (requiresParamStrip: true) but
		// its gatewayReasoning is null because the model doesn't emit
		// reasoning text. isGatewayReasoningCapableModel must distinguish.
		expect(isGatewayReasoningCapableModel("openai/codex-mini")).toBe(false);
	});
});

describe("PR 5 — isGatewayClaudeReasoningModel back-compat narrow check", () => {
	it("o3 → false (the narrow check stays Claude-only)", () => {
		expect(isGatewayClaudeReasoningModel("openai/o3")).toBe(false);
	});

	it("gpt-5 → false (the narrow check stays Claude-only)", () => {
		expect(isGatewayClaudeReasoningModel("openai/gpt-5")).toBe(false);
	});

	it("claude-sonnet-4-6 → true (narrow check still matches Claude 4.x)", () => {
		expect(
			isGatewayClaudeReasoningModel("anthropic/claude-sonnet-4-6"),
		).toBe(true);
	});
});

describe("PR 5 — createProviderModel Gateway branch integration for OpenAI o-series", () => {
	it("Vercel Gateway + openai/o3 → ChatOpenAI with modelKwargs.reasoning.effort='medium', no temperature, no maxTokens, __includeRawResponse=true", () => {
		const config: RuntimeProviderConfig = {
			provider: "VERCEL_GATEWAY",
			apiKey: "test-key",
			model: "openai/o3",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
		};
		const model = createProviderModel(config, {
			temperature: 0.7,
			maxTokens: 4000,
		}) as ChatOpenAI & {
			modelKwargs?: Record<string, unknown>;
			temperature?: number;
			maxTokens?: number;
			__includeRawResponse?: boolean;
		};

		expect(model.modelKwargs).toEqual({
			reasoning: { effort: "medium" },
		});
		// temperature and maxTokens MUST be omitted for o-series — OpenAI
		// rejects max_tokens (uses max_completion_tokens) and temperature
		// != 1 with HTTP 400 on reasoning models.
		expect(model.temperature).toBeUndefined();
		expect(model.maxTokens).toBeUndefined();
		expect(model.__includeRawResponse).toBe(true);
	});

	it("Vercel Gateway + openai/gpt-5-mini → same shape as o-series (defense-in-depth, Codex B2)", () => {
		const config: RuntimeProviderConfig = {
			provider: "VERCEL_GATEWAY",
			apiKey: "test-key",
			model: "openai/gpt-5-mini",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
		};
		const model = createProviderModel(config, {
			temperature: 0.5,
			maxTokens: 8000,
		}) as ChatOpenAI & {
			modelKwargs?: Record<string, unknown>;
		};

		expect(model.modelKwargs).toEqual({
			reasoning: { effort: "medium" },
		});
	});

	it("Vercel Gateway + openai/codex-mini → temperature + maxTokens stripped, NO reasoning kwargs", () => {
		// Latent-guard test (code-reviewer Important #1): codex-mini has
		// `gatewayReasoning: null` (no reasoning emission) but
		// `requiresParamStrip: true` because the upstream OpenAI Responses
		// API rejects `temperature != 1` and `max_tokens` regardless of
		// routing path. Without the strip, this configuration would HTTP 400
		// on every call.
		const config: RuntimeProviderConfig = {
			provider: "VERCEL_GATEWAY",
			apiKey: "test-key",
			model: "openai/codex-mini",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
		};
		const model = createProviderModel(config, {
			temperature: 0.7,
			maxTokens: 4000,
		}) as ChatOpenAI & {
			modelKwargs?: Record<string, unknown>;
			temperature?: number;
			maxTokens?: number;
			__includeRawResponse?: boolean;
		};

		// Strip happened despite no reasoning enrolment.
		expect(model.temperature).toBeUndefined();
		expect(model.maxTokens).toBeUndefined();
		// No reasoning kwargs (codex-mini doesn't emit reasoning text).
		// ChatOpenAI defaults modelKwargs to {} when not supplied, so the
		// assertion checks that it does NOT carry the reasoning key.
		expect(
			(model.modelKwargs as Record<string, unknown> | undefined)
				?.reasoning,
		).toBeUndefined();
		// __includeRawResponse is reasoning-only — codex-mini doesn't need
		// the raw response envelope preserved.
		expect(model.__includeRawResponse).toBeUndefined();
	});
});

describe("PR 5 — MODEL_FAMILIES table integrity", () => {
	it("each family matches at least one canonical name from the production smoke set", () => {
		// Sanity check that the regex anchors didn't drift. Each family
		// must match its representative production name.
		const sampleMatches: Record<string, string[]> = {
			"anthropic-claude-4": [
				"claude-sonnet-4-6",
				"anthropic/claude-sonnet-4-6",
				"claude-opus-4-7",
			],
			"openai-o-series": ["o3-mini", "openai/o3-mini", "o1", "o1-mini"],
			"openai-gpt-5": [
				"gpt-5",
				"gpt-5-mini",
				"openai/gpt-5.2",
				"gpt-5.1-codex",
			],
			"openai-codex-mini": ["codex-mini", "openai/codex-mini"],
		};
		for (const family of MODEL_FAMILIES) {
			const samples = sampleMatches[family.id];
			expect(samples, `samples for family ${family.id}`).toBeDefined();
			for (const name of samples ?? []) {
				expect(
					family.matches(name),
					`${family.id} should match ${name}`,
				).toBe(true);
			}
		}
	});

	it("no two families overlap on any name in the smoke set (first-wins ordering is unambiguous)", () => {
		const allSamples = [
			"claude-sonnet-4-6",
			"anthropic/claude-sonnet-4-6",
			"claude-opus-4-7",
			"o3-mini",
			"o1",
			"openai/o1-mini",
			"gpt-5",
			"gpt-5-mini",
			"gpt-5.1-codex",
			"codex-mini",
		];
		for (const name of allSamples) {
			const matches = MODEL_FAMILIES.filter((f) => f.matches(name));
			expect(
				matches.length,
				`${name} should match exactly one family (got ${matches.map((f) => f.id).join(", ")})`,
			).toBe(1);
		}
	});

	it("parity vs deleted v1 REASONING_CAPABLE_PATTERNS — isReasoningCapableModel still returns true for the v1 set", () => {
		// The v1 REASONING_CAPABLE_PATTERNS matched these names on
		// OPENAI_DIRECT + ANTHROPIC_DIRECT. After consolidation into
		// MODEL_FAMILIES, all of them must still resolve to true.
		const v1AnthropicNames = [
			"claude-sonnet-4-5",
			"claude-opus-4-7",
			"claude-haiku-4-5",
			"claude-sonnet-4.6",
		];
		for (const n of v1AnthropicNames) {
			expect(
				isReasoningCapableModel(n, "ANTHROPIC_DIRECT"),
				`${n} via ANTHROPIC_DIRECT`,
			).toBe(true);
		}
		const v1OpenAINames = [
			"o1",
			"o3-mini",
			"o4-mini",
			"gpt-5",
			"gpt-5-nano",
			"gpt-5.1",
			"gpt-5.4",
		];
		for (const n of v1OpenAINames) {
			expect(
				isReasoningCapableModel(n, "OPENAI_DIRECT"),
				`${n} via OPENAI_DIRECT`,
			).toBe(true);
		}
	});

	it("parity vs deleted v1 REASONING_MODELS — getReasoningConfig still returns shape that strips temperature on Direct branch via applyReasoningConfig", () => {
		// Smoke: for an OpenAI reasoning model on OPENAI_DIRECT, the
		// returned config should include reasoning kwargs + useResponsesApi.
		// The exact shape is documented per family in MODEL_FAMILIES.
		const o3Config = getReasoningConfig("o3", "OPENAI_DIRECT");
		expect(o3Config).toEqual({
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		});
		// Anthropic Claude 4.x returns the thinking shape:
		const claudeConfig = getReasoningConfig(
			"claude-sonnet-4-6",
			"ANTHROPIC_DIRECT",
		);
		expect(claudeConfig).toEqual({
			thinking: { type: "enabled", budget_tokens: 5000 },
		});
	});

	it("exhaustive parity vs deleted v1 REASONING_MODELS — every long-tail name still triggers param strip", () => {
		// Code-reviewer Important #2: the v1 REASONING_MODELS array was a
		// substring-match list of 16 canonical names that all needed the
		// OpenAI Responses API temperature/maxTokens strip. After the
		// MODEL_FAMILIES consolidation, every one of those names MUST still
		// resolve to a family with `requiresParamStrip: true`. The earlier
		// 7-name spot check was too narrow — this loop locks in coverage
		// for the long-tail variants.
		const V1_REASONING_MODELS = [
			// o1 series
			"o1",
			"o1-mini",
			"o1-preview",
			// o3 series
			"o3",
			"o3-mini",
			"o3-pro",
			// o4 series
			"o4-mini",
			// gpt-5 reasoning variants
			"gpt-5-nano",
			"gpt-5-mini",
			"gpt-5-pro",
			"gpt-5.1",
			"gpt-5.1-codex",
			"gpt-5.1-codex-mini",
			"gpt-5.1-codex-max",
			"gpt-5.2",
			"gpt-5.4",
			"gpt-5.5",
			// codex reasoning models
			"codex-mini",
		];
		for (const name of V1_REASONING_MODELS) {
			const family = MODEL_FAMILIES.find((f) => f.matches(name));
			expect(family, `${name} should match a family`).toBeDefined();
			expect(
				family?.requiresParamStrip,
				`${name} should have requiresParamStrip=true`,
			).toBe(true);
		}
	});
});

/**
 * The LangChain agent path never received the explicit output-token budgets the
 * Vercel AI SDK path got in #2198 — it fell back to a bare `4000` for every
 * model, including ones the catalog rates at 128,000. Raising the default is
 * only safe alongside the clamp: `llama-3-3-70b` on the same gateway caps at
 * 8,192, so an unclamped raise would 400 that model on every call.
 */
describe("resolveOutputTokenBudget", () => {
	it("defaults to the quota-safe ceiling when nothing is requested", () => {
		expect(resolveOutputTokenBudget(undefined, null)).toBe(32_768);
	});

	it("no longer collapses to the old 4000 literal", () => {
		expect(resolveOutputTokenBudget(undefined, null)).toBeGreaterThan(
			4_000,
		);
	});

	it("clamps DOWN to the catalog cap — the llama-3-3-70b case", () => {
		// Catalog: system.ai.meta-llama-3-3-70b-instruct -> 8192 (read from
		// production on 2026-08-11). Asking for the default would 400.
		expect(
			resolveOutputTokenBudget(undefined, { maxOutputTokens: 8_192 }),
		).toBe(8_192);
	});

	it("keeps the requested value when it fits under the cap", () => {
		expect(
			resolveOutputTokenBudget(16_000, { maxOutputTokens: 128_000 }),
		).toBe(16_000);
	});

	it("clamps an over-ask down to the cap", () => {
		expect(
			resolveOutputTokenBudget(200_000, { maxOutputTokens: 128_000 }),
		).toBe(128_000);
	});

	it("honours the request when the catalog is silent", () => {
		// A custom serving endpoint we have no row for: inventing a ceiling
		// here is how you truncate a model that could have done more.
		expect(resolveOutputTokenBudget(64_000, {})).toBe(64_000);
		expect(
			resolveOutputTokenBudget(64_000, { maxOutputTokens: undefined }),
		).toBe(64_000);
	});

	it("ignores a nonsensical catalog cap rather than strangling generation", () => {
		expect(resolveOutputTokenBudget(16_000, { maxOutputTokens: 0 })).toBe(
			16_000,
		);
	});

	it("honours a deliberately small request — the floor guards the CAP, not the caller", () => {
		// The bounded summary model asks for 1,024 on purpose; inflating an
		// explicit request would be this helper overriding its own callers.
		expect(
			resolveOutputTokenBudget(512, { maxOutputTokens: 128_000 }),
		).toBe(512);
	});

	it("respects even a tiny catalog cap rather than over-asking", () => {
		// Raising a real cap into an over-ask is what the provider rejects
		// outright; asking for less only costs output length.
		expect(resolveOutputTokenBudget(16_000, { maxOutputTokens: 10 })).toBe(
			10,
		);
	});

	it("keeps a DEFAULT reservation from crowding out the prompt on a small window", () => {
		// Anthropic requires input + max_tokens to fit the window. A 32,768
		// default against a 64,000-token window would leave only half the
		// window for a history that routinely carries large tool results.
		expect(
			resolveOutputTokenBudget(undefined, {
				maxOutputTokens: 64_000,
				contextWindow: 64_000,
			}),
		).toBe(16_000);
	});

	it("leaves a large-window model's default alone", () => {
		// claude-sonnet-5 as seeded in production: 1,000,000 / 128,000.
		expect(
			resolveOutputTokenBudget(undefined, {
				maxOutputTokens: 128_000,
				contextWindow: 1_000_000,
			}),
		).toBe(32_768);
	});

	it("does NOT apply the context guard to an EXPLICIT request", () => {
		// The document agents size their budget from the document they are
		// rewriting; shrinking that silently would reintroduce truncation.
		expect(
			resolveOutputTokenBudget(48_000, {
				maxOutputTokens: 64_000,
				contextWindow: 64_000,
			}),
		).toBe(48_000);
	});
});

/**
 * Issue #2781: invisible thinking tokens on reasoning-capable models count
 * against the same `max_tokens` cap as the visible output. This allowance
 * gives the document-tool budget headroom for that, sized from measured
 * production spend (~9-10K thinking tokens on a Databricks-served Claude
 * Sonnet 5 endpoint).
 */
describe("reasoningOutputAllowance", () => {
	const mustMatch = [
		"system.ai.claude-sonnet-5",
		"claude-sonnet-5",
		"claude-opus-5",
		"anthropic/claude-sonnet-4-5",
		"claude-sonnet-4-5",
		"claude-opus-4-1",
		"databricks-claude-sonnet-4-5",
		"o3",
		"o1-mini",
		"openai/o4-mini",
		"gpt-5",
		"gpt-5.1-codex",
	];

	it.each(mustMatch)(
		"returns the allowance for reasoning-capable model %s",
		(model) => {
			expect(reasoningOutputAllowance(model)).toBe(
				REASONING_OUTPUT_TOKEN_ALLOWANCE,
			);
		},
	);

	const mustZero = [
		"claude-3-5-sonnet",
		"claude-3-opus",
		"claude-3-haiku",
		"claude-3-sonnet",
		"gpt-4o",
		"gpt-5-chat-latest",
		"codex-mini",
		"llama-3-3-70b",
		"",
		null,
		undefined,
	] as const;

	it.each(mustZero)("returns 0 for non-reasoning model %s", (model) => {
		expect(reasoningOutputAllowance(model)).toBe(0);
	});

	it("recognizes the older Anthropic version-before-role naming from 3.7 up", () => {
		expect(reasoningOutputAllowance("claude-3-7-sonnet")).toBe(
			REASONING_OUTPUT_TOKEN_ALLOWANCE,
		);
		expect(reasoningOutputAllowance("system.ai.claude-3-7-sonnet")).toBe(
			REASONING_OUTPUT_TOKEN_ALLOWANCE,
		);
	});

	it("does not match a version below the reasoning threshold on the older naming", () => {
		expect(reasoningOutputAllowance("claude-3-5-haiku")).toBe(0);
	});

	// Codex review (issue #2781 follow-up): the role-first regex originally
	// matched on the leading version digits alone with no boundary after
	// them, and the version comparison built a lossy decimal from
	// major/minor (`Number("3.10")` === 3.1).
	it("requires a boundary after the version — does not match claude-sonnet-4o", () => {
		expect(reasoningOutputAllowance("claude-sonnet-4o")).toBe(0);
	});

	it("requires a boundary after the version — does not match claude-opus-3.7beta", () => {
		expect(reasoningOutputAllowance("claude-opus-3.7beta")).toBe(0);
	});

	it("compares version components as integers, not a lossy decimal — claude-3-10-sonnet", () => {
		expect(reasoningOutputAllowance("claude-3-10-sonnet")).toBe(
			REASONING_OUTPUT_TOKEN_ALLOWANCE,
		);
	});

	it("a bare major above 3 matches regardless of minor (documented ≥3.7 contract)", () => {
		expect(reasoningOutputAllowance("claude-sonnet-45")).toBe(
			REASONING_OUTPUT_TOKEN_ALLOWANCE,
		);
	});
});

/**
 * Config-aware variant. `isReasoningModel`'s real semantics are "emits
 * DeepSeek-R1 `<think>` tags" (see `isReasoningModelName` in
 * `databricks-compat.ts`), NOT "is a reasoning model" in general — the
 * producers (`ai-config` / `ai-config/task` routes) set it unconditionally
 * to `isReasoningModelName(canonicalName)`, so every non-R1 model, INCLUDING
 * Anthropic's thinking-capable Claude releases, resolves to `false`. `true`
 * can therefore ADD an allowance a name guess would miss (an R1 model under
 * an opaque alias); `false` must NOT subtract one a name guess correctly
 * grants — `system.ai.claude-sonnet-5` (the issue #2781 incident model)
 * resolves to `isReasoningModel: false` on every path that populates the
 * flag, and is exactly the model this allowance exists to cover.
 */
describe("reasoningOutputAllowanceForConfig", () => {
	it("isReasoningModel: true grants the allowance even for a non-matching name", () => {
		expect(
			reasoningOutputAllowanceForConfig({
				model: "prod-chat",
				isReasoningModel: true,
			}),
		).toBe(REASONING_OUTPUT_TOKEN_ALLOWANCE);
	});

	// This is the actual production shape of the incident config:
	// isReasoningModelName("system.ai.claude-sonnet-5") is false (Claude is
	// not DeepSeek-R1), so both ai-config resolution routes populate
	// isReasoningModel: false for this model — yet it IS the model issue
	// #2781 needs the allowance for. false must fall through to the
	// name-based check, not short-circuit to 0.
	it("isReasoningModel: false does NOT deny the allowance for a matching name (system.ai.claude-sonnet-5 production shape)", () => {
		expect(
			reasoningOutputAllowanceForConfig({
				model: "system.ai.claude-sonnet-5",
				isReasoningModel: false,
			}),
		).toBe(REASONING_OUTPUT_TOKEN_ALLOWANCE);
	});

	it("isReasoningModel: false + a non-matching name still returns 0", () => {
		expect(
			reasoningOutputAllowanceForConfig({
				model: "gpt-4o",
				isReasoningModel: false,
			}),
		).toBe(0);
	});

	it("isReasoningModel: undefined falls back to the name-based check (match)", () => {
		expect(
			reasoningOutputAllowanceForConfig({
				model: "claude-sonnet-5",
				isReasoningModel: undefined,
			}),
		).toBe(REASONING_OUTPUT_TOKEN_ALLOWANCE);
	});

	it("isReasoningModel: undefined falls back to the name-based check (no match)", () => {
		expect(
			reasoningOutputAllowanceForConfig({
				model: "gpt-4o",
				isReasoningModel: undefined,
			}),
		).toBe(0);
	});
});

/**
 * `maxTokensForConfig` (issue #2781 HIGH review finding): `chat-node.ts`
 * extracts provider config before calling `getAgentModelAsync`, but
 * `getAgentModelAsync` can replace the model afterward (task-specific
 * preference override, or an API-fallback-resolved config the caller never
 * saw). A model-dependent budget computed against the pre-resolution model
 * would silently apply to the wrong model. `createProviderModel` is the
 * single choke point every resolution path funnels through, so evaluating
 * the callback there against its own `config` parameter is guaranteed to
 * see the model actually being built against.
 */
describe("createProviderModel — maxTokensForConfig choke point", () => {
	it("invokes maxTokensForConfig with the resolved config and its return value wins over maxTokens", () => {
		const model = createProviderModel(
			{ provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "k" },
			{ maxTokens: 4000, maxTokensForConfig: () => 9999 },
		);
		expect((model as unknown as { maxTokens?: number }).maxTokens).toBe(
			9999,
		);
	});

	it("passes the actual config argument through to the callback (proof it sees the resolved model, not a fixed pre-resolution value)", () => {
		const seen: RuntimeProviderConfig[] = [];
		createProviderModel(
			{ provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "k" },
			{
				maxTokensForConfig: (cfg) => {
					seen.push(cfg);
					return 5000;
				},
			},
		);
		expect(seen).toHaveLength(1);
		expect(seen[0].model).toBe("llama-3.3-70b-versatile");
	});

	it("falls back to maxTokens when maxTokensForConfig is absent (regression guard)", () => {
		const model = createProviderModel(
			{ provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "k" },
			{ maxTokens: 4321 },
		);
		expect((model as unknown as { maxTokens?: number }).maxTokens).toBe(
			4321,
		);
	});

	it("end-to-end: a reasoning-model config gets base+allowance capped at 48000 via the callback pattern used in chat-node", () => {
		const base = 40000; // base + 12000 would exceed 48000 without the cap
		const model = createProviderModel(
			{
				provider: "GROQ",
				model: "system.ai.claude-sonnet-5",
				apiKey: "k",
			},
			{
				maxTokensForConfig: (cfg) =>
					Math.min(
						48000,
						base + reasoningOutputAllowanceForConfig(cfg),
					),
			},
		);
		expect((model as unknown as { maxTokens?: number }).maxTokens).toBe(
			48000,
		);
	});

	it("end-to-end: a non-reasoning-model config gets base with no allowance added", () => {
		const base = 20000;
		const model = createProviderModel(
			{ provider: "GROQ", model: "gpt-4o", apiKey: "k" },
			{
				maxTokensForConfig: (cfg) =>
					Math.min(
						48000,
						base + reasoningOutputAllowanceForConfig(cfg),
					),
			},
		);
		expect((model as unknown as { maxTokens?: number }).maxTokens).toBe(
			base,
		);
	});
});
