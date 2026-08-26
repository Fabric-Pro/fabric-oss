/**
 * Excalidraw default-enabled — E2E coverage.
 *
 * Locks two acceptance criteria:
 *
 *   - "draw a flow diagram using Excalidraw" in Nexus renders an
 *     inline Excalidraw diagram (scenario 1 below).
 *   - Same prompt inside the in-feature AI Assistant (`FabricDirectChat`,
 *     mounted by `FabricAgentLauncher`) renders the same diagram
 *     (scenario 2 below).
 *
 * Both scenarios run against an authenticated session produced by
 * `auth.setup.ts`. The migration's backfill guarantees a
 * managed-default `MCPConfig` row exists for the test user, so the
 * prompt does NOT have to traverse the connect-CTA flow. If the test
 * user is freshly created, the post-signup hook has the same effect.
 *
 * Prerequisites:
 *  - Dev server on :3001 (Playwright config handles this).
 *  - Auth state from `auth.setup.ts` (storageState).
 *  - A project + feature exists for the authed user. Scenario 2 needs
 *    `TEST_FEATURE_STORY_PATH` env var pointing at a route like
 *    `/app/{orgSlug}/projects/{projectId}/stories/{storyId}`. Tests that
 *    rely on the placeholder self-skip when the env var is unset.
 *
 * NOTE: This file requires the dev web server to be running. The
 * orchestrator workflow needs the Temporal worker + database. If those
 * dependencies aren't available locally, run the file behind
 * `pnpm --filter web e2e tests/excalidraw-default-enabled.spec.ts` only
 * when the full stack (`./aspire.sh restart` per CLAUDE.md) is up.
 */

import { expect, test } from "@playwright/test";

const TEST_FEATURE_STORY_PATH =
	process.env.TEST_FEATURE_STORY_PATH || "<feature-story-path>";

// The eager-routing helper triggers on substring match against
// `MCPServer.eagerKeywords` (case-insensitive). The seed flips Excalidraw's
// keywords to `["excalidraw"]`, so any message containing that word fires
// the route. Match the spec's locked example prompt verbatim.
const PROMPT = "draw a flow diagram using Excalidraw";

// The `DefaultMcpStatusCard` testid we use to detect a service-down
// fallback (so a transient upstream outage during CI surfaces clearly
// rather than failing with an unhelpful "selector not found").
const SERVICE_DOWN_TESTID = "default-mcp-status-card";

// The Excalidraw renderer mounts inside the assistant turn. The
// `data-testid` is asserted to disambiguate from generic chat markdown.
// `ExcalidrawEditor.tsx` is what `create_view` results render through.
const EXCALIDRAW_CANVAS_SELECTOR = [
	// First try the canonical testid emitted by the renderer.
	'[data-testid="excalidraw-canvas"]',
	// Fall back to the Excalidraw element class — the package's own
	// outer wrapper class is `.excalidraw` (per @excalidraw/excalidraw
	// docs); the editor wraps in a div that exposes this.
	".excalidraw",
].join(", ");

test.describe("Excalidraw default-enabled — AC2 + AC3", () => {
	test("AC2: Nexus — typing the Excalidraw prompt renders an inline Excalidraw canvas", async ({
		page,
	}) => {
		// 1. Navigate to Nexus.
		await page.goto("/app/nexus");
		await page.waitForLoadState("networkidle");

		// 2. Find the chat composer and send the prompt. The composer is a
		//    textarea or `[role=textbox]` — both forms appear across surfaces.
		const composer = page
			.getByRole("textbox")
			.or(page.locator("textarea"))
			.first();
		await composer.waitFor({ state: "visible", timeout: 10000 });
		await composer.fill(PROMPT);
		await composer.press("Enter");

		// 3. Wait for the assistant turn to render either an Excalidraw
		//    canvas (success) OR a service-down card (transient upstream
		//    outage — surface clearly).
		const canvas = page.locator(EXCALIDRAW_CANVAS_SELECTOR).first();
		const serviceDown = page.getByTestId(SERVICE_DOWN_TESTID).first();
		await Promise.race([
			canvas.waitFor({ state: "visible", timeout: 60_000 }),
			serviceDown.waitFor({ state: "visible", timeout: 60_000 }),
		]);

		// If the service-down card fired, mark the test inconclusive — this
		// is an upstream-service problem, not a regression in our routing.
		if (await serviceDown.isVisible().catch(() => false)) {
			test.info().annotations.push({
				type: "inconclusive",
				description:
					"Excalidraw service unreachable during run — DefaultMcpStatusCard surfaced.",
			});
			test.skip();
		}

		await expect(canvas).toBeVisible();
	});

	test("AC3: AI Assistant — same prompt inside a feature's FabricDirectChat renders the same canvas", async ({
		page,
	}) => {
		if (TEST_FEATURE_STORY_PATH.startsWith("<")) {
			test.skip();
		}

		// 1. Navigate to a feature in StoryWorkspace. The path includes the
		//    feature's story id.
		await page.goto(TEST_FEATURE_STORY_PATH);
		await page.waitForLoadState("networkidle");

		// 2. Open the AI Assistant launcher (FabricAgentLauncher mounts the
		//    button; clicking it opens the inline FabricDirectChat dock).
		//    The launcher's accessible label is "AI Assistant" — confirmed
		//    by `FabricAgentLauncher.test.tsx`.
		const launcher = page
			.getByRole("button", { name: /AI Assistant|Fabric/i })
			.first();
		await launcher.waitFor({ state: "visible", timeout: 10000 });
		await launcher.click();

		// 3. Find the composer inside the FabricDirectChat dock and send
		//    the prompt.
		const composer = page
			.getByRole("textbox")
			.or(page.locator("textarea"))
			.last(); // dock composer is appended below the existing chat composer
		await composer.waitFor({ state: "visible", timeout: 10000 });
		await composer.fill(PROMPT);
		await composer.press("Enter");

		// 4. Same wait pattern as AC2.
		const canvas = page.locator(EXCALIDRAW_CANVAS_SELECTOR).first();
		const serviceDown = page.getByTestId(SERVICE_DOWN_TESTID).first();
		await Promise.race([
			canvas.waitFor({ state: "visible", timeout: 60_000 }),
			serviceDown.waitFor({ state: "visible", timeout: 60_000 }),
		]);

		if (await serviceDown.isVisible().catch(() => false)) {
			test.info().annotations.push({
				type: "inconclusive",
				description:
					"Excalidraw service unreachable during run — DefaultMcpStatusCard surfaced.",
			});
			test.skip();
		}

		await expect(canvas).toBeVisible();
	});
});
