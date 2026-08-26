/**
 * Insertion order in ExtractionFactory's Map is the fallback order that
 * `getLocalExtractors` returns. If local-html and local-text ever swap, HTML
 * silently reverts to raw-markup passthrough and no other test fails — so this
 * ordering is worth a test of its own.
 *
 * `@repo/database` is mocked because factory.ts imports it at module scope for
 * provider configuration, which would otherwise require a generated Prisma
 * client on disk — the same reason every other test in this package that
 * touches `@repo/database` mocks it, even though this is the first test to
 * import factory.ts itself (see the `@repo/ai` mock below for what that
 * import additionally requires).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getEnabledOrganizationRagProviders: vi.fn().mockResolvedValue([]),
	getEnabledUserRagProviders: vi.fn().mockResolvedValue([]),
	incrementOrganizationRagProviderUsage: vi.fn().mockResolvedValue(undefined),
	incrementUserRagProviderUsage: vi.fn().mockResolvedValue(undefined),
}));

// factory.ts reaches AiVisionExtractor through the extractors barrel, which
// imports @repo/ai. Left unmocked, that module's own module-scope imports
// pull in @repo/payments, which in turn needs a much larger slice of
// @repo/database (setAiUsageRecorder, GATEWAY_PROVIDERS, ...) than this
// ordering test has any interest in. Mocking @repo/ai here cuts that chain
// off at the one place this test actually touches it.
vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

import { ExtractionFactory } from "../factory";

describe("extraction factory ordering (Fizzy #1684)", () => {
	it("tries local-html before local-text for text/html", () => {
		const factory = new ExtractionFactory();
		const names = (
			factory as unknown as {
				getLocalExtractors(mime: string): { name: string }[];
			}
		)
			.getLocalExtractors("text/html")
			.map((e) => e.name);

		expect(names).toEqual(["local-html", "local-text"]);
	});
});
