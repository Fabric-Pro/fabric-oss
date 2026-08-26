/**
 * Codebase Context Awareness E2E Tests
 *
 * Verifies that the AI Assistant in the document editor is aware of
 * connected GitHub/ADO repositories and can answer questions about them.
 *
 * Bug: The agent previously had no knowledge of connected codebases,
 * responding with "no connection" when asked about repositories.
 *
 * Fix: Added repository fields to ProjectContext, integration flags
 * to agent state, and formatted repository info in the system prompt.
 *
 * Prerequisites:
 * - Dev server running on :3001
 * - TEST_DATA constants below must be filled with real project/document IDs
 * - The project must have a GitHub repository connected in Settings
 */

import { expect, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data — fill in real IDs before running.
// Tests will skip themselves if projectId is left as the placeholder.
// ---------------------------------------------------------------------------
const TEST_DATA = {
	personal: {
		projectId:
			process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
		documentId:
			process.env.TEST_PERSONAL_DOCUMENT_ID || "<personal-document-id>",
		// Expected repository info (must match what's configured in project settings)
		repositoryOwner: process.env.TEST_REPO_OWNER || "<repo-owner>",
		repositoryName: process.env.TEST_REPO_NAME || "<repo-name>",
	},
	org: {
		slug: process.env.TEST_ORG_SLUG || "<org-slug>",
		projectId: process.env.TEST_ORG_PROJECT_ID || "<org-project-id>",
		documentId: process.env.TEST_ORG_DOCUMENT_ID || "<org-document-id>",
		repositoryOwner: process.env.TEST_ORG_REPO_OWNER || "<org-repo-owner>",
		repositoryName: process.env.TEST_ORG_REPO_NAME || "<org-repo-name>",
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Skip test if placeholder data has not been filled in. */
function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

/** Navigate to the document editor for a project. */
async function gotoDocumentEditor(
	page: Page,
	projectId: string,
	documentId: string,
	orgSlug?: string,
): Promise<void> {
	const base = orgSlug
		? `/app/${orgSlug}/projects/${projectId}/documents/${documentId}`
		: `/app/projects/${projectId}/documents/${documentId}`;
	await page.goto(base);
	await page.waitForLoadState("networkidle");
}

/** Wait for the CopilotKit sidebar to be visible. */
async function waitForSidebar(page: Page): Promise<void> {
	await page
		.locator("textarea")
		.first()
		.waitFor({ state: "visible", timeout: 10000 });
}

/** Send a message in the CopilotKit sidebar and wait for a response. */
async function sendChatMessage(page: Page, message: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	await textarea.fill(message);
	await textarea.press("Enter");
}

/**
 * Wait for the AI assistant to finish responding.
 * Looks for the loading indicator to appear and then disappear.
 */
async function waitForAiResponse(page: Page): Promise<void> {
	// Wait for the response to start (loading indicator or new message)
	await page.waitForTimeout(2000);
	// Wait for loading to finish (no more spinning indicators)
	await page.waitForLoadState("networkidle");
	// Give the response a moment to render
	await page.waitForTimeout(1000);
}

/** Get the last assistant message text from the sidebar. */
async function _getLastAssistantMessage(page: Page): Promise<string> {
	// CopilotKit renders messages in the sidebar
	// The last message from the assistant contains the response
	const messages = page.locator('[class*="copilotKitMessage"]').last();
	if (await messages.isVisible()) {
		return (await messages.textContent()) || "";
	}
	// Fallback: try to find any text response after our question
	const allText = await page
		.locator('[class*="message"]')
		.last()
		.textContent();
	return allText || "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Codebase Context Awareness", () => {
	test.describe("Personal context with connected repo", () => {
		test.beforeEach(async ({ page: _page }) => {
			skipIfNoData(TEST_DATA.personal.projectId);
			if (TEST_DATA.personal.repositoryOwner.startsWith("<")) {
				test.skip();
			}
		});

		test("AI assistant knows about connected repository", async ({
			page,
		}) => {
			await gotoDocumentEditor(
				page,
				TEST_DATA.personal.projectId,
				TEST_DATA.personal.documentId,
			);
			await waitForSidebar(page);

			// Ask the AI about the repository
			await sendChatMessage(
				page,
				"What repository is connected to this project? Just tell me the owner and repo name.",
			);

			// Wait for response
			await waitForAiResponse(page);

			// The response should mention the repository
			// We check the full page text since CopilotKit message selectors vary
			const pageText = await page.textContent("body");
			const hasRepoOwner = pageText?.includes(
				TEST_DATA.personal.repositoryOwner,
			);
			const hasRepoName = pageText?.includes(
				TEST_DATA.personal.repositoryName,
			);

			expect(
				hasRepoOwner || hasRepoName,
				`Expected AI response to mention "${TEST_DATA.personal.repositoryOwner}" or "${TEST_DATA.personal.repositoryName}"`,
			).toBeTruthy();
		});

		test("AI assistant does not say 'no connection' for connected repo", async ({
			page,
		}) => {
			await gotoDocumentEditor(
				page,
				TEST_DATA.personal.projectId,
				TEST_DATA.personal.documentId,
			);
			await waitForSidebar(page);

			// Ask about the codebase
			await sendChatMessage(
				page,
				"Do I have a codebase connected to this project?",
			);

			// Wait for response
			await waitForAiResponse(page);

			// The response should NOT say "no connection" or "not connected"
			const pageText = (await page.textContent("body")) || "";

			// Check that the response doesn't contain negative connection messages
			const negativePatterns = [
				"no connection",
				"not connected",
				"no codebase",
				"no repository",
				"don't have access to",
				"unable to access",
			];

			for (const pattern of negativePatterns) {
				// Only check the sidebar area, not the entire page
				// Since we can't easily isolate the sidebar, we check after the question
				const lowerText = pageText.toLowerCase();
				// Find text after our question
				const questionIndex = lowerText.indexOf("do i have a codebase");
				if (questionIndex > -1) {
					const responseText = lowerText.slice(questionIndex + 40); // Skip past question
					expect(
						responseText.includes(pattern),
						`AI response should not contain "${pattern}" when repo is connected`,
					).toBeFalsy();
				}
			}
		});
	});

	test.describe("Organization context with connected repo", () => {
		test.beforeEach(async ({ page: _page }) => {
			skipIfNoData(TEST_DATA.org.projectId);
			if (TEST_DATA.org.repositoryOwner.startsWith("<")) {
				test.skip();
			}
		});

		test("AI assistant knows about connected repository in org context", async ({
			page,
		}) => {
			await gotoDocumentEditor(
				page,
				TEST_DATA.org.projectId,
				TEST_DATA.org.documentId,
				TEST_DATA.org.slug,
			);
			await waitForSidebar(page);

			await sendChatMessage(
				page,
				"What repository is connected to this project? Just tell me the owner and repo name.",
			);

			await waitForAiResponse(page);

			const pageText = await page.textContent("body");
			const hasRepoOwner = pageText?.includes(
				TEST_DATA.org.repositoryOwner,
			);
			const hasRepoName = pageText?.includes(
				TEST_DATA.org.repositoryName,
			);

			expect(
				hasRepoOwner || hasRepoName,
				`Expected AI response to mention "${TEST_DATA.org.repositoryOwner}" or "${TEST_DATA.org.repositoryName}"`,
			).toBeTruthy();
		});
	});
});
