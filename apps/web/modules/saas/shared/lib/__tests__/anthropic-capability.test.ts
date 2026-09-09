/**
 * Unit tests for the shared Anthropic capability notice.
 *
 * Two things are pinned here, and nothing else states either of them:
 *
 * - The rule that decides whether the cross-app banner shows. It is a pure
 *   function precisely so that a consumer and a test cannot drift apart, which
 *   only holds if the truth table is written down somewhere — here.
 * - The approved copy, asserted against literal sentences typed into this
 *   file. Comparing an import to itself would pass no matter what the copy was
 *   changed to, so the sentences below are deliberately spelled out again.
 *
 * The fixtures build only the two fields the rule reads, and both describe the
 * CALLER. An earlier generation of this file built `defaultProvider` and
 * `embeddingProvider` fixtures — tenant-scoped fields — alongside the
 * caller-scoped `canResolveProvider`, and so encoded the same scope confusion
 * as the code it was testing: every combination it could express was one the
 * buggy predicate handled, which is exactly why it never caught the bug. Do not
 * reintroduce those fields here.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/shared/lib/__tests__/anthropic-capability.test.ts
 */
import {
	ANTHROPIC_PROVIDER_ID,
	canProviderSupportEmbeddings,
} from "@saas/settings/lib/ai-providers";
import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_CAPABILITY_BANNER_DETAIL,
	ANTHROPIC_CAPABILITY_BODY,
	ANTHROPIC_CAPABILITY_TITLE,
	type AnthropicCapabilityStatus,
	shouldShowAnthropicCapabilityBanner,
} from "../anthropic-capability";

/**
 * The Anthropic id written out by hand, so the fixtures below do not inherit
 * whatever the module under test believes the id to be. It is anchored to the
 * registry by the tripwire at the bottom of this file.
 */
const ANTHROPIC = "ANTHROPIC_DIRECT";

/** An ordinary in-app page — nowhere near the provider settings. */
const ORDINARY_PATH = "/app/acme/projects";

/**
 * The status payload as the rule reads it: what the caller can resolve, and
 * what the embedding path will actually resolve to for them. The default is
 * the state the banner exists for — a caller whose embeddings land on a
 * provider that serves none.
 */
function status(
	overrides: Partial<AnthropicCapabilityStatus> = {},
): AnthropicCapabilityStatus {
	return {
		canResolveProvider: true,
		resolvedEmbeddingProvider: ANTHROPIC,
		...overrides,
	};
}

describe("shouldShowAnthropicCapabilityBanner — nothing to say yet", () => {
	it("returns false for an undefined payload, because absent data is not an answer", () => {
		expect(
			shouldShowAnthropicCapabilityBanner(undefined, ORDINARY_PATH),
		).toBe(false);
	});

	it("returns false while the AI-setup reminder is showing, even when the embedding path resolves to Anthropic (AE6)", () => {
		expect(
			shouldShowAnthropicCapabilityBanner(
				status({
					canResolveProvider: false,
					resolvedEmbeddingProvider: ANTHROPIC,
				}),
				ORDINARY_PATH,
			),
		).toBe(false);
	});
});

describe("shouldShowAnthropicCapabilityBanner — the pages that already say it (AE11)", () => {
	it("returns false on an organization's AI Providers settings page", () => {
		expect(
			shouldShowAnthropicCapabilityBanner(
				status(),
				"/app/acme/settings/ai-providers",
			),
		).toBe(false);
	});

	it("returns false on the account's AI Providers settings page", () => {
		expect(
			shouldShowAnthropicCapabilityBanner(
				status(),
				"/app/acme/settings/account/ai-providers",
			),
		).toBe(false);
	});
});

describe("shouldShowAnthropicCapabilityBanner — the gap it exists for", () => {
	it("returns true when the embedding path resolves to Anthropic, on an ordinary page (AE1)", () => {
		// The whole rule: not what the tenant stored, but what the resolver
		// will hand the embedding call when it runs.
		expect(
			shouldShowAnthropicCapabilityBanner(
				status({ resolvedEmbeddingProvider: ANTHROPIC }),
				ORDINARY_PATH,
			),
		).toBe(true);
	});

	it("returns false once the embedding path resolves to a provider that can embed (AE3)", () => {
		// Assigning an embedding provider is the remedy the copy asks for, and
		// the resolver landing somewhere that serves embeddings is what carrying
		// it out looks like from here.
		expect(canProviderSupportEmbeddings("OPENAI_DIRECT")).toBe(true);
		expect(
			shouldShowAnthropicCapabilityBanner(
				status({ resolvedEmbeddingProvider: "OPENAI_DIRECT" }),
				ORDINARY_PATH,
			),
		).toBe(false);
	});
});

describe("shouldShowAnthropicCapabilityBanner — resolutions that are not Anthropic", () => {
	it("returns false when the embedding path resolves to nothing at all", () => {
		// No resolution is a different failure with a different remedy, and the
		// AI-setup reminder owns it. Reading null as "Anthropic" would put this
		// banner in front of tenants who never configured Anthropic.
		//
		// Not AE9. That example described a dormant Anthropic row beside a
		// working default, which no longer has an input of its own here: the
		// resolver reports the working default, so it arrives as the AE3 shape
		// above. Its collapsing into AE3 is what the predicate change bought.
		expect(
			shouldShowAnthropicCapabilityBanner(
				status({ resolvedEmbeddingProvider: null }),
				ORDINARY_PATH,
			),
		).toBe(false);
	});

	it("returns false when it resolves to a different provider that also cannot embed, because this release is Anthropic-scoped", () => {
		// Groq serves no embeddings either. Widening the rule to every such
		// provider is a separate decision with its own approved copy; this one
		// names Anthropic in its first sentence and may only be shown for it.
		expect(canProviderSupportEmbeddings("GROQ")).toBe(false);
		expect(
			shouldShowAnthropicCapabilityBanner(
				status({ resolvedEmbeddingProvider: "GROQ" }),
				ORDINARY_PATH,
			),
		).toBe(false);
	});
});

describe("the approved copy", () => {
	it("uses the approved title", () => {
		expect(ANTHROPIC_CAPABILITY_TITLE).toBe(
			"Some capabilities are unavailable with Anthropic",
		);
	});

	it("uses the approved body sentence shared by every surface", () => {
		expect(ANTHROPIC_CAPABILITY_BODY).toBe(
			"Anthropic does not support embeddings, image generation, or audio. To use these features, configure an additional provider that supports them.",
		);
	});

	it("uses the approved banner-only sentence about what keeps working", () => {
		expect(ANTHROPIC_CAPABILITY_BANNER_DETAIL).toBe(
			"Chat and agents keep working. Document search, retrieval, and the context step in document generation do not.",
		);
	});
});

describe("registry tripwire", () => {
	it("still finds Anthropic unable to serve embeddings, which is what ANTHROPIC_CAPABILITY_BODY asserts in prose", () => {
		// If Anthropic ever becomes embedding-capable in the provider
		// registry, this fails — and the sentence in
		// ANTHROPIC_CAPABILITY_BODY ("does not support embeddings") has to be
		// re-approved rather than quietly left telling users something untrue.
		expect(canProviderSupportEmbeddings(ANTHROPIC)).toBe(false);

		// Configured and enabled changes nothing: the gap is the provider's,
		// not the tenant's.
		expect(
			canProviderSupportEmbeddings(ANTHROPIC, {
				configuredProviders: [
					{
						provider: ANTHROPIC,
						displayName: "Anthropic",
						isDefault: true,
						isEmbeddingProvider: false,
						source: "org_config",
					},
				],
				embeddingProvider: null,
			}),
		).toBe(false);
	});

	it("resolves the Anthropic id the rule compares against to ANTHROPIC_DIRECT", () => {
		// The rule reads the id out of the typed provider metadata instead of
		// writing the literal, so this is the one place that says which id it
		// is expected to be — without it, a renamed registry key would change
		// the rule's meaning with every other test still green.
		expect(ANTHROPIC_PROVIDER_ID).toBe("ANTHROPIC_DIRECT");
	});
});
