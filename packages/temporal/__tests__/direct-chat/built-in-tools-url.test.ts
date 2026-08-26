/**
 * Worker-environment URL regression test for the Slack-reachable bug-site.
 *
 * Approach choice (per spec §15 and tasks.md Group 3.2): the `buildStoryUrl`
 * helper used by `fabric_create_story` is now a narrow module-level export of
 * `built-in-tools.ts` (it was previously an inline closure). Exporting it lets
 * us assert the URL shape with just `vi.stubEnv` plus a thin upstream-module
 * mock — no real DB, no real LLM, no tool factory wiring. The behaviour of the
 * helper is identical to the prior closure: `${getBaseUrl()}` followed by the
 * `/app/{slug?}/projects/{projectId}/stories/{storyId}` path.
 *
 * The fix itself lives in `@repo/utils/lib/base-url.ts` (APP_URL added to the
 * precedence chain). This file does NOT mock `@repo/utils` so that the real
 * `getBaseUrl()` resolution is exercised — that is the regression seam.
 *
 * The heavy upstream packages (`@repo/ai`, `@repo/database`, `@repo/search`,
 * `@repo/storage`) are mocked solely because ESM module evaluation of
 * `built-in-tools.ts` pulls them in at import time. The mocks are inert; only
 * `buildStoryUrl` is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	tool: (def: unknown) => def,
}));

vi.mock("@repo/database", () => ({
	canCreateProjectStory: vi.fn(),
	db: {
		organization: { findUnique: vi.fn() },
		userStory: { update: vi.fn() },
	},
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	resolveModelWithCredentials: vi.fn(),
}));

vi.mock("@repo/search", () => ({
	createProvider: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	uploadFile: vi.fn(),
}));

vi.mock("../../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));

vi.mock("../../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));

vi.mock("../../src/activities/orchestrator/tools/fabric-ai-tools", () => ({
	getAllFabricAiTools: () => [],
}));

vi.mock("../../src/activities/shared/fabric-content-tools", () => ({
	getFabricToolDefinitionMap: () => new Map(),
}));

vi.mock("../../src/activities/shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));

vi.mock("../../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

// Static import — vi.mock calls above are hoisted by Vitest to run before this
// import executes, so the heavy upstream packages are already stubbed. A
// top-level `await import` would work but trips strict tsc (TS1378) because the
// temporal tsconfig targets es2017.
import { buildStoryUrl } from "../../src/activities/direct-chat/built-in-tools";

describe("buildStoryUrl (worker env shape)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		// Worker shape: APP_URL set, NEXT_PUBLIC_* explicitly unset so the
		// precedence chain in getBaseUrl resolves to APP_URL.
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
		vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
		vi.stubEnv("NEXT_PUBLIC_VERCEL_URL", "");
		vi.stubEnv("APP_URL", "https://fabric.pro");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("builds an https://fabric.pro/app/{slug}/projects/.../stories/... URL when APP_URL is set and slug is present", () => {
		const url = buildStoryUrl({
			projectId: "project-1",
			storyId: "story-1",
			slug: "acme",
		});

		expect(url).toBe(
			"https://fabric.pro/app/acme/projects/project-1/stories/story-1",
		);
	});

	it("builds an https://fabric.pro/app/projects/.../stories/... URL when the org has no slug (personal context)", () => {
		const url = buildStoryUrl({
			projectId: "project-1",
			storyId: "story-1",
			slug: null,
		});

		expect(url).toBe(
			"https://fabric.pro/app/projects/project-1/stories/story-1",
		);
	});

	it("never produces a localhost URL when APP_URL is set (both branches)", () => {
		const orgUrl = buildStoryUrl({
			projectId: "p",
			storyId: "s",
			slug: "acme",
		});
		const personalUrl = buildStoryUrl({
			projectId: "p",
			storyId: "s",
			slug: null,
		});

		expect(orgUrl).not.toContain("localhost");
		expect(orgUrl).not.toContain("127.0.0.1");
		expect(personalUrl).not.toContain("localhost");
		expect(personalUrl).not.toContain("127.0.0.1");
	});
});
