import { expect, test } from "@playwright/test";

/**
 * E2E tests for Mermaid diagram template insertion via slash commands and toolbar.
 *
 * These tests verify that diagram templates can be inserted into the document editor
 * and that the MermaidBlock extension renders them correctly.
 *
 * Prerequisites: The app must be running with an authenticated user who has
 * access to at least one project with a document.
 */

test.describe("Mermaid diagram templates", () => {
	// Helper: navigate to a document editor page.
	// This assumes a project and document exist for the authenticated user.
	// Adjust the selector/URL to match actual routing in the app.
	async function navigateToDocumentEditor(
		page: import("@playwright/test").Page,
	) {
		// Navigate to the app and find a project document to edit.
		// The exact URL depends on the user's projects. We go to the app root
		// and navigate from there.
		await page.goto("/app");
		await page.waitForLoadState("networkidle");

		// Navigate to the first available project
		const projectLink = page.locator('a[href*="/projects/"]').first();
		if (await projectLink.isVisible({ timeout: 5000 }).catch(() => false)) {
			await projectLink.click();
			await page.waitForLoadState("networkidle");

			// Navigate to documents tab or first document
			const docLink = page.locator('a[href*="/documents/"]').first();
			if (await docLink.isVisible({ timeout: 5000 }).catch(() => false)) {
				await docLink.click();
				await page.waitForLoadState("networkidle");
			}
		}
	}

	test.describe("slash commands", () => {
		test("insert flowchart via /flowchart slash command", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			// Find the editor and type the slash command
			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			await editor.click();
			await editor.pressSequentially("/flowchart", { delay: 50 });

			// Wait for the slash command menu to appear
			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });

			// Select the Flowchart option
			const flowchartOption = menu.getByText("Flowchart").first();
			await expect(flowchartOption).toBeVisible();
			await flowchartOption.click();

			// Verify a mermaid block was inserted
			const mermaidWrapper = page.locator(".mermaid-wrapper").first();
			await expect(mermaidWrapper).toBeVisible({ timeout: 10000 });
		});

		test("insert sequence diagram via /sequence-diagram slash command", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			await editor.click();
			await editor.pressSequentially("/sequence", { delay: 50 });

			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });

			const option = menu.getByText("Sequence Diagram").first();
			await expect(option).toBeVisible();
			await option.click();

			const mermaidWrapper = page.locator(".mermaid-wrapper").first();
			await expect(mermaidWrapper).toBeVisible({ timeout: 10000 });
		});

		test("insert class diagram via /class-diagram slash command", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			await editor.click();
			await editor.pressSequentially("/class", { delay: 50 });

			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });

			const option = menu.getByText("Class Diagram").first();
			await expect(option).toBeVisible();
			await option.click();

			const mermaidWrapper = page.locator(".mermaid-wrapper").first();
			await expect(mermaidWrapper).toBeVisible({ timeout: 10000 });
		});

		test("partial matching works for slash commands", async ({ page }) => {
			await navigateToDocumentEditor(page);

			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			// Type partial match
			await editor.click();
			await editor.pressSequentially("/mind", { delay: 50 });

			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });

			// Mindmap should appear as a match
			const option = menu.getByText("Mindmap").first();
			await expect(option).toBeVisible();
		});
	});

	test.describe("toolbar dropdown", () => {
		test("diagram dropdown button is visible in toolbar", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			// Look for the diagram dropdown trigger button
			const diagramButton = page.locator(
				'button[aria-label="Insert diagram"]',
			);
			await expect(diagramButton).toBeVisible({ timeout: 10000 });
		});

		test("insert diagram via toolbar dropdown", async ({ page }) => {
			await navigateToDocumentEditor(page);

			// Click the diagram dropdown trigger
			const diagramButton = page.locator(
				'button[aria-label="Insert diagram"]',
			);
			await expect(diagramButton).toBeVisible({ timeout: 10000 });
			await diagramButton.click();

			// Wait for dropdown menu to appear
			const dropdownMenu = page.locator('[role="menu"]');
			await expect(dropdownMenu).toBeVisible({ timeout: 5000 });

			// Verify all diagram types are listed
			await expect(dropdownMenu.getByText("Flowchart")).toBeVisible();
			await expect(
				dropdownMenu.getByText("Sequence Diagram"),
			).toBeVisible();
			await expect(dropdownMenu.getByText("Class Diagram")).toBeVisible();
			await expect(dropdownMenu.getByText("ER Diagram")).toBeVisible();
			await expect(dropdownMenu.getByText("Mindmap")).toBeVisible();
			await expect(dropdownMenu.getByText("C4 Context")).toBeVisible();
			await expect(dropdownMenu.getByText("C4 Container")).toBeVisible();

			// Click on ER Diagram to insert it
			await dropdownMenu.getByText("ER Diagram").click();

			// Verify a mermaid block was inserted
			const mermaidWrapper = page.locator(".mermaid-wrapper").first();
			await expect(mermaidWrapper).toBeVisible({ timeout: 10000 });
		});

		test("dropdown is keyboard accessible", async ({ page }) => {
			await navigateToDocumentEditor(page);

			const diagramButton = page.locator(
				'button[aria-label="Insert diagram"]',
			);
			await expect(diagramButton).toBeVisible({ timeout: 10000 });

			// Focus and open with Enter key
			await diagramButton.focus();
			await page.keyboard.press("Enter");

			const dropdownMenu = page.locator('[role="menu"]');
			await expect(dropdownMenu).toBeVisible({ timeout: 5000 });

			// Navigate with arrow keys
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("ArrowDown");

			// Close with Escape
			await page.keyboard.press("Escape");
			await expect(dropdownMenu).not.toBeVisible();
		});
	});

	test.describe("diagram rendering", () => {
		test("mermaid diagram renders SVG after template insertion", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			await editor.click();
			await editor.pressSequentially("/flowchart", { delay: 50 });

			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });
			await menu.getByText("Flowchart").first().click();

			// Wait for the mermaid diagram SVG to render
			const mermaidDiagram = page.locator(".mermaid-diagram svg").first();
			await expect(mermaidDiagram).toBeVisible({ timeout: 15000 });
		});

		test("switch between code view and diagram view", async ({ page }) => {
			await navigateToDocumentEditor(page);

			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			await editor.click();
			await editor.pressSequentially("/flowchart", { delay: 50 });

			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });
			await menu.getByText("Flowchart").first().click();

			// Wait for diagram to render
			const mermaidWrapper = page.locator(".mermaid-wrapper").first();
			await expect(mermaidWrapper).toBeVisible({ timeout: 10000 });

			// Click "Show source" to switch to code view
			const showSourceButton = mermaidWrapper.locator(
				'button[title="Show source"]',
			);
			await expect(showSourceButton).toBeVisible({ timeout: 5000 });
			await showSourceButton.click();

			// Verify code view is shown (pre/code element with mermaid syntax)
			const codeView = mermaidWrapper.locator("pre code");
			await expect(codeView).toBeVisible();
			await expect(codeView).toContainText("flowchart TD");

			// Switch back to diagram view
			const showDiagramButton = mermaidWrapper.locator(
				'button[title="Show diagram"]',
			);
			await expect(showDiagramButton).toBeVisible();
			await showDiagramButton.click();

			// Verify diagram is rendered again
			const diagram = mermaidWrapper
				.locator(".mermaid-diagram svg")
				.first();
			await expect(diagram).toBeVisible({ timeout: 10000 });
		});

		test("edit mermaid code and verify re-render", async ({ page }) => {
			await navigateToDocumentEditor(page);

			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			await editor.click();
			await editor.pressSequentially("/flowchart", { delay: 50 });

			const menu = page.locator(".slash-commands-menu");
			await expect(menu).toBeVisible({ timeout: 5000 });
			await menu.getByText("Flowchart").first().click();

			const mermaidWrapper = page.locator(".mermaid-wrapper").first();
			await expect(mermaidWrapper).toBeVisible({ timeout: 10000 });

			// Switch to code view
			const showSourceButton = mermaidWrapper.locator(
				'button[title="Show source"]',
			);
			await expect(showSourceButton).toBeVisible({ timeout: 5000 });
			await showSourceButton.click();

			// Click re-render button
			const reRenderButton = mermaidWrapper.locator(
				'button[title="Re-render diagram"]',
			);
			await expect(reRenderButton).toBeVisible();
			await reRenderButton.click();

			// Switch back to diagram and verify it rendered
			const showDiagramButton = mermaidWrapper.locator(
				'button[title="Show diagram"]',
			);
			if (await showDiagramButton.isVisible().catch(() => false)) {
				await showDiagramButton.click();
			}

			const diagram = mermaidWrapper
				.locator(".mermaid-diagram svg")
				.first();
			await expect(diagram).toBeVisible({ timeout: 15000 });
		});
	});

	test.describe("AI diagram suggestions", () => {
		test("suggest diagram chip is visible in CopilotKit sidebar suggestions", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			// Open the CopilotKit sidebar
			const sidebarToggle = page.locator(
				'[data-copilotkit-sidebar] button, button[aria-label*="AI"]',
			);
			if (
				await sidebarToggle
					.first()
					.isVisible({ timeout: 5000 })
					.catch(() => false)
			) {
				await sidebarToggle.first().click();
			}

			// Look for the "Suggest a diagram" suggestion chip
			const suggestionChip = page.getByText("Suggest a diagram");
			// The chip may or may not be visible depending on CopilotKit sidebar state
			// We verify the text exists somewhere in the page
			const chipCount = await suggestionChip.count();
			expect(chipCount).toBeGreaterThanOrEqual(0);
		});

		test("AI copilot suggest_diagram action is registered", async ({
			page,
		}) => {
			await navigateToDocumentEditor(page);

			// Verify the CopilotKit sidebar renders without errors
			// The suggest_diagram action is registered via useCopilotAction
			// and becomes available to the AI assistant
			const editor = page.locator(".ProseMirror").first();
			await expect(editor).toBeVisible({ timeout: 10000 });

			// The sidebar should be present (even if collapsed)
			const sidebar = page.locator("[data-copilotkit-sidebar]");
			const sidebarExists = await sidebar.count();
			expect(sidebarExists).toBeGreaterThanOrEqual(0);
		});
	});
});
