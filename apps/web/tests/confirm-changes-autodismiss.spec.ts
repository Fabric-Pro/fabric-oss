/**
 * Confirm Changes Auto-Dismiss E2E Tests
 *
 * Verifies that the "Confirm Changes" panel in the AI Assistant sidebar
 * auto-dismisses after the user accepts or rejects changes.
 *
 * Bug: The panel previously persisted indefinitely after user action,
 * showing stale "Changes discarded" / "Changes accepted" messages.
 *
 * Fix: Added a 2-second auto-dismiss timer that hides the panel.
 *
 * Prerequisites:
 * - Dev server running on :3001
 * - TEST_DATA constants below must be filled with real project/document IDs
 * - The project must have at least one document
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
	},
	org: {
		slug: process.env.TEST_ORG_SLUG || "<org-slug>",
		projectId: process.env.TEST_ORG_PROJECT_ID || "<org-project-id>",
		documentId: process.env.TEST_ORG_DOCUMENT_ID || "<org-document-id>",
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
	// CopilotKit sidebar renders with a textarea for input
	await page
		.locator("textarea")
		.first()
		.waitFor({ state: "visible", timeout: 10000 });
}

/** Send a message in the CopilotKit sidebar. */
async function sendChatMessage(page: Page, message: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	await textarea.fill(message);
	await textarea.press("Enter");
}

/** Wait for the confirm changes modal to appear. */
async function waitForConfirmModal(page: Page): Promise<void> {
	await page.locator('[data-testid="confirm-changes-modal"]').waitFor({
		state: "visible",
		timeout: 60000, // AI generation can take time
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Confirm Changes Auto-Dismiss", () => {
	test.describe("Personal context", () => {
		test.beforeEach(async ({ page: _page }) => {
			skipIfNoData(TEST_DATA.personal.projectId);
		});

		test("reject button shows status then auto-dismisses", async ({
			page,
		}) => {
			await gotoDocumentEditor(
				page,
				TEST_DATA.personal.projectId,
				TEST_DATA.personal.documentId,
			);
			await waitForSidebar(page);

			// Ask AI to make a change
			await sendChatMessage(page, "Add a brief testing section");

			// Wait for the confirm modal to appear
			await waitForConfirmModal(page);

			const modal = page.locator('[data-testid="confirm-changes-modal"]');
			const rejectBtn = modal.locator('[data-testid="reject-button"]');

			// Verify buttons are visible
			await expect(rejectBtn).toBeVisible();
			await expect(
				modal.locator('[data-testid="confirm-button"]'),
			).toBeVisible();

			// Click reject
			await rejectBtn.click();

			// Status should appear briefly
			const statusDisplay = modal.locator(
				'[data-testid="status-display"]',
			);
			await expect(statusDisplay).toBeVisible();
			await expect(statusDisplay).toContainText(/rejected|discarded/i);

			// After ~2 seconds, the entire modal should disappear
			await expect(modal).toBeHidden({ timeout: 5000 });
		});

		test("confirm button shows status then auto-dismisses", async ({
			page,
		}) => {
			await gotoDocumentEditor(
				page,
				TEST_DATA.personal.projectId,
				TEST_DATA.personal.documentId,
			);
			await waitForSidebar(page);

			// Ask AI to make a change
			await sendChatMessage(page, "Add a brief summary section");

			// Wait for the confirm modal to appear
			await waitForConfirmModal(page);

			const modal = page.locator('[data-testid="confirm-changes-modal"]');
			const confirmBtn = modal.locator('[data-testid="confirm-button"]');

			// Click confirm
			await confirmBtn.click();

			// Status should appear briefly
			const statusDisplay = modal.locator(
				'[data-testid="status-display"]',
			);
			await expect(statusDisplay).toBeVisible();
			await expect(statusDisplay).toContainText(/accepted/i);

			// After ~2 seconds, the entire modal should disappear
			await expect(modal).toBeHidden({ timeout: 5000 });
		});
	});

	test.describe("Organization context", () => {
		test.beforeEach(async ({ page: _page }) => {
			skipIfNoData(TEST_DATA.org.projectId);
		});

		test("reject auto-dismisses in org context", async ({ page }) => {
			await gotoDocumentEditor(
				page,
				TEST_DATA.org.projectId,
				TEST_DATA.org.documentId,
				TEST_DATA.org.slug,
			);
			await waitForSidebar(page);

			await sendChatMessage(page, "Add a brief overview section");
			await waitForConfirmModal(page);

			const modal = page.locator('[data-testid="confirm-changes-modal"]');
			await modal.locator('[data-testid="reject-button"]').click();

			// Status shows then modal disappears
			await expect(
				modal.locator('[data-testid="status-display"]'),
			).toBeVisible();
			await expect(modal).toBeHidden({ timeout: 5000 });
		});
	});
});
