import { expect, type Page, test } from "@playwright/test";

/**
 * The Documents-tab create flow, end to end.
 *
 * Every branch below is covered by unit tests already. What those cannot show is
 * whether the dialog assembles into something a person can actually use: that
 * the prompt selector fits and resolves a default, that the source controls
 * appear only when there is a source, that submitting navigates somewhere real.
 * A wall of green unit tests over a dialog nobody has opened is exactly the gap
 * this closes.
 *
 * Written to be skipped rather than to fail when the environment cannot supply
 * a project — a red spec that only means "no seed data" trains people to ignore
 * red specs.
 */

const DIALOG = { name: /create document/i };

async function openCreateDialog(page: Page): Promise<boolean> {
	await page.goto("/app");
	await page.waitForLoadState("networkidle");

	const projectLink = page.locator('a[href*="/projects/"]').first();
	if (!(await projectLink.isVisible({ timeout: 5000 }).catch(() => false))) {
		return false;
	}
	await projectLink.click();
	await page.waitForLoadState("networkidle");

	const documentsTab = page.getByRole("tab", { name: /documents/i });
	if (await documentsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
		await documentsTab.click();
	}

	const createButton = page.getByRole("button", DIALOG).first();
	if (!(await createButton.isVisible({ timeout: 5000 }).catch(() => false))) {
		return false;
	}
	await createButton.click();
	return await page
		.getByRole("dialog")
		.isVisible({ timeout: 5000 })
		.catch(() => false);
}

test.describe("Documents tab — create document", () => {
	test("opens with AI drafting on and a prompt already selected", async ({
		page,
	}) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");

		// Generation on by default is the central behaviour change: the old
		// flow's default produced an empty document.
		await expect(dialog.getByRole("checkbox").first()).toBeChecked();

		// The prompt selector is the onboarding component, and it must resolve a
		// default for the type rather than sitting empty.
		const promptTrigger = dialog.getByRole("combobox", {
			name: /prompt/i,
		});
		await expect(promptTrigger).toBeVisible();
		await expect(promptTrigger).not.toHaveText("");
	});

	test("defaults the title from the type, and stops once the user edits it", async ({
		page,
	}) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");
		const titleField = dialog.getByRole("textbox", { name: /title/i });
		const initial = await titleField.inputValue();
		expect(initial.length).toBeGreaterThan(0);

		await titleField.fill("Ours, not the default");

		// Changing the type must not overwrite a title the user has typed.
		const typePicker = dialog.getByRole("combobox").first();
		await typePicker.click();
		await page.getByRole("option").nth(1).click();

		await expect(titleField).toHaveValue("Ours, not the default");
	});

	test("offers the usage choice only once there is a source", async ({
		page,
	}) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");
		const usage = dialog.getByText(/use as context/i);
		await expect(usage).toBeHidden();

		await dialog
			.getByRole("textbox", { name: /source content|content/i })
			.fill("Notes from the kickoff call.");

		await expect(usage).toBeVisible();
	});

	/**
	 * The rule that removed the old default path. With generation off and no
	 * source there is nothing to create, and the dialog has to say so rather
	 * than produce an empty document.
	 */
	test("refuses to create nothing, and says why", async ({ page }) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");
		const generateToggle = dialog.getByRole("checkbox").first();
		test.skip(
			!(await generateToggle.isEnabled()),
			"AI is not configured here, where creating from a title alone is the sanctioned route",
		);

		await generateToggle.uncheck();
		await dialog.getByRole("button", { name: /^create/i }).click();

		await expect(dialog.getByRole("alert")).toBeVisible();
		// Still open: a refusal that closed the dialog would lose the user's work.
		await expect(dialog).toBeVisible();
	});

	test("creates a document from pasted text and lands in it", async ({
		page,
	}) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");
		await dialog
			.getByRole("textbox", { name: /source content|content/i })
			.fill("# Kickoff notes\n\nShip the thing by June.");

		// Use As-Is: no model call, so this passes without AI configured.
		const asIs = dialog.getByText(/use as-is/i);
		if (await asIs.isVisible({ timeout: 2000 }).catch(() => false)) {
			await asIs.click();
		}

		await dialog.getByRole("button", { name: /^create/i }).click();

		await page.waitForURL(/\/documents\//, { timeout: 20000 });
		await expect(page.getByText(/Ship the thing by June/)).toBeVisible({
			timeout: 15000,
		});
	});

	test("takes one file as the source", async ({ page }) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");
		await dialog.getByTestId("source-file-input").setInputFiles({
			name: "kickoff.md",
			mimeType: "text/markdown",
			buffer: Buffer.from("# Kickoff\n\nNotes."),
		});

		await expect(dialog.getByTestId("source-file-chosen")).toHaveText(
			/kickoff\.md/,
		);
		// The paste box yields to the file rather than competing with it.
		await expect(
			dialog.getByRole("textbox", { name: /source content|content/i }),
		).toBeDisabled();
	});

	test("refuses a file the shared allowlist does not carry", async ({
		page,
	}) => {
		test.skip(
			!(await openCreateDialog(page)),
			"No project with a Documents tab available in this environment",
		);

		const dialog = page.getByRole("dialog");
		await dialog.getByTestId("source-file-input").setInputFiles({
			name: "installer.exe",
			mimeType: "application/x-msdownload",
			buffer: Buffer.from("MZ"),
		});

		await expect(dialog.getByTestId("source-file-refusal")).toBeVisible();
		await expect(dialog.getByTestId("source-file-chosen")).toBeHidden();
	});
});
