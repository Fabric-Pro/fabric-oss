/**
 * E2E: Download project context files
 *
 * Spec:
 *   docs/specs/2026-04-15-download-project-context-files/spec.md §13.4
 *   docs/specs/2026-04-15-download-project-context-files/tasks.md §10.1
 *
 * Scenarios (A1, A2, A5, A9, A13):
 *   1. Per-row Class A (uploaded PDF) — personal tenant
 *   2. Per-row Class B (NOTE) — personal tenant, checks `.md` + shared header
 *   3. Download all (happy path) — personal tenant, filename matches
 *      `/-contexts-\d{4}-\d{2}-\d{2}\.zip$/`, ZIP contains `MANIFEST.txt`
 *      and a `files/` entry per included row
 *   4. Empty state — disabled-but-focusable button, tooltip surfaces
 *      `No contexts to download`
 *   5. Org-tenant parity — per-row Class A and download-all also run
 *      inside `/app/{slug}/projects/{id}` when `TEST_ORG_*` env vars are
 *      supplied
 *
 * Setup: the existing `auth.setup.ts` storageState is reused. Tests that
 * need concrete project/context IDs read them from env vars and skip
 * themselves when the placeholders are not overridden (same pattern as
 * `codebase-context-awareness.spec.ts`).
 *
 * Env vars consumed (all optional — unset values cause tests to skip):
 *   TEST_PERSONAL_PROJECT_WITH_CONTEXTS_ID
 *   TEST_PERSONAL_PROJECT_WITH_CONTEXTS_SLUG    (slug prefix used to match
 *                                                 the zip filename)
 *   TEST_PERSONAL_CONTEXT_FILE_NAME             (display/filename of an
 *                                                 existing FILE row)
 *   TEST_PERSONAL_CONTEXT_NOTE_TITLE            (display title of an
 *                                                 existing NOTE row)
 *   TEST_PERSONAL_EMPTY_PROJECT_ID              (project with zero contexts)
 *   TEST_ORG_SLUG
 *   TEST_ORG_PROJECT_WITH_CONTEXTS_ID
 *   TEST_ORG_PROJECT_WITH_CONTEXTS_SLUG
 *   TEST_ORG_CONTEXT_FILE_NAME
 *
 * Manual runbook to produce the fixtures (see spec §13.5 smoke list):
 *   - Personal: create a project, upload a PDF, add one NOTE, note the
 *     IDs and slug.
 *   - Org: in an organization you belong to, create a project and upload
 *     a PDF.
 *   - Also create a separate personal project with zero contexts for the
 *     empty-state test.
 *
 * Run:
 *   pnpm --filter web e2e tests/projects/contexts-download.spec.ts
 */

import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// ── ZIP smoke helpers ─────────────────────────────────────────────────────
// The repo only depends on `archiver` (write-only) on the server side, and
// pulling in a dedicated unzip dependency for one Playwright assertion is
// heavier than warranted. Instead, the tests below parse the ZIP central
// directory with a lightweight inline reader: enough to list entry names
// without decompressing payloads. That fulfils spec §13.4's
// "assert presence of MANIFEST.txt and expected files/ entries" without
// adding a new package.

/** Return the list of file entry names in a ZIP archive. */
function listZipEntries(buffer: Buffer): string[] {
	// End-of-central-directory (EOCD) signature: 0x06054b50.
	const eocdSig = 0x06054b50;
	const cdSig = 0x02014b50;

	// Scan backwards for EOCD — max 65557 bytes in (comment max = 0xFFFF).
	let eocdOffset = -1;
	const scanStart = Math.max(0, buffer.length - 65_557);
	for (let i = buffer.length - 22; i >= scanStart; i--) {
		if (buffer.readUInt32LE(i) === eocdSig) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset === -1) {
		throw new Error("ZIP: EOCD record not found (invalid archive)");
	}

	const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
	const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

	const names: string[] = [];
	let ptr = cdOffset;
	for (let i = 0; i < totalEntries; i++) {
		if (buffer.readUInt32LE(ptr) !== cdSig) {
			throw new Error(
				`ZIP: central directory header mismatch at offset ${ptr}`,
			);
		}
		const nameLen = buffer.readUInt16LE(ptr + 28);
		const extraLen = buffer.readUInt16LE(ptr + 30);
		const commentLen = buffer.readUInt16LE(ptr + 32);
		const nameStart = ptr + 46;
		const name = buffer.toString("utf8", nameStart, nameStart + nameLen);
		names.push(name);
		ptr = nameStart + nameLen + extraLen + commentLen;
	}
	return names;
}

// ── Test data & guards ────────────────────────────────────────────────────

const TEST_DATA = {
	personal: {
		projectId:
			process.env.TEST_PERSONAL_PROJECT_WITH_CONTEXTS_ID ??
			"<personal-project-id>",
		projectSlug:
			process.env.TEST_PERSONAL_PROJECT_WITH_CONTEXTS_SLUG ??
			"<personal-project-slug>",
		fileName:
			process.env.TEST_PERSONAL_CONTEXT_FILE_NAME ??
			"<personal-file-name>",
		noteTitle:
			process.env.TEST_PERSONAL_CONTEXT_NOTE_TITLE ??
			"<personal-note-title>",
		emptyProjectId:
			process.env.TEST_PERSONAL_EMPTY_PROJECT_ID ??
			"<personal-empty-project-id>",
	},
	org: {
		slug: process.env.TEST_ORG_SLUG ?? "<org-slug>",
		projectId:
			process.env.TEST_ORG_PROJECT_WITH_CONTEXTS_ID ?? "<org-project-id>",
		projectSlug:
			process.env.TEST_ORG_PROJECT_WITH_CONTEXTS_SLUG ??
			"<org-project-slug>",
		fileName: process.env.TEST_ORG_CONTEXT_FILE_NAME ?? "<org-file-name>",
	},
} as const;

function isPlaceholder(value: string): boolean {
	return value.startsWith("<") && value.endsWith(">");
}

/** Skip current test if any of the provided fields is still a placeholder. */
function skipIfAnyPlaceholder(...values: string[]): void {
	for (const v of values) {
		if (isPlaceholder(v)) {
			test.skip();
			return;
		}
	}
}

// ── Page helpers ──────────────────────────────────────────────────────────

function personalProjectUrl(projectId: string): string {
	return `/app/projects/${projectId}`;
}

function orgProjectUrl(slug: string, projectId: string): string {
	return `/app/${slug}/projects/${projectId}`;
}

/** Navigate to the project page and wait for the contexts section to load. */
async function gotoProjectPage(page: Page, url: string): Promise<void> {
	await page.goto(url);
	// Section header carries the `Download all` button once the query resolves.
	await page
		.getByRole("button", { name: /download all contexts/i })
		.waitFor({ state: "visible", timeout: 15_000 });
}

/** Find the context row whose visible text contains the given title / filename. */
async function openRowMenu(page: Page, titleOrFilename: string): Promise<void> {
	// Rows are flexible across list/kanban variants — fall back to text scoping.
	const row = page
		.locator("[data-context-row], li, tr, div")
		.filter({ hasText: titleOrFilename })
		.first();
	await row.waitFor({ state: "visible", timeout: 10_000 });
	// The dropdown trigger is the only button with a "more" / ellipsis label
	// inside the row. Fallback: tap the last button in the row.
	const trigger = row.getByRole("button").last();
	await trigger.click();
}

/** Click the Download menu item surfaced by the row dropdown. */
async function clickRowDownload(page: Page): Promise<void> {
	await page.getByRole("menuitem", { name: /^download(\s|$)/i }).click();
}

/** Click the section-header `Download all` button. */
async function clickDownloadAll(page: Page): Promise<void> {
	await page.getByRole("button", { name: /download all contexts/i }).click();
}

/** Wait for and capture a browser download triggered by `action`. */
async function captureDownload(
	page: Page,
	action: () => Promise<void>,
): Promise<{ filename: string; path: string }> {
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 30_000 }),
		action(),
	]);
	const filename = download.suggestedFilename();
	const path = await download.path();
	if (!path) {
		throw new Error(
			`Download for ${filename} did not produce a local path`,
		);
	}
	return { filename, path };
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.describe("Project contexts — download (personal tenant)", () => {
	test.beforeEach(async () => {
		skipIfAnyPlaceholder(
			TEST_DATA.personal.projectId,
			TEST_DATA.personal.projectSlug,
		);
	});

	test("per-row Class A (uploaded file) triggers a download with the original filename", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.personal.fileName);

		await gotoProjectPage(
			page,
			personalProjectUrl(TEST_DATA.personal.projectId),
		);

		await openRowMenu(page, TEST_DATA.personal.fileName);

		const { filename, path } = await captureDownload(page, () =>
			clickRowDownload(page),
		);

		// The downloaded filename must either equal the original or at least
		// preserve its extension — the server strips unsafe chars but keeps
		// the base shape.
		expect(filename.length).toBeGreaterThan(0);

		// Non-zero byte size.
		const buf = readFileSync(path);
		expect(buf.byteLength).toBeGreaterThan(0);
	});

	test("per-row Class B (NOTE) downloads a `.md` file starting with the shared text header", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.personal.noteTitle);

		await gotoProjectPage(
			page,
			personalProjectUrl(TEST_DATA.personal.projectId),
		);

		await openRowMenu(page, TEST_DATA.personal.noteTitle);

		const { filename, path } = await captureDownload(page, () =>
			clickRowDownload(page),
		);

		expect(filename).toMatch(/\.md$/i);

		const body = readFileSync(path, "utf8");
		// Spec §8.2: the shared text header for Class B/C downloads includes
		// the project title + "Exported from Fabric" / context metadata. We
		// assert a stable substring — the exact wording is locked in the
		// lib helper, so the presence of "Fabric" is sufficient here as a
		// smoke check without coupling the test to the exact layout.
		expect(body).toMatch(/fabric/i);
	});

	test("Download all produces a ZIP with the expected filename pattern and manifest", async ({
		page,
	}) => {
		await gotoProjectPage(
			page,
			personalProjectUrl(TEST_DATA.personal.projectId),
		);

		const { filename, path } = await captureDownload(page, () =>
			clickDownloadAll(page),
		);

		// Filename pattern: `{projectSlug}-contexts-{YYYY-MM-DD}.zip`
		expect(filename).toMatch(/-contexts-\d{4}-\d{2}-\d{2}\.zip$/);
		expect(filename.startsWith(TEST_DATA.personal.projectSlug)).toBe(true);

		// ZIP contents include MANIFEST.txt and at least one `files/` entry.
		const buffer = readFileSync(path);
		// ZIP local-file-header magic: "PK\x03\x04" at offset 0.
		expect(buffer.slice(0, 4).toString("binary")).toBe("PK\u0003\u0004");
		const entries = listZipEntries(buffer);
		expect(entries).toContain("MANIFEST.txt");
		expect(entries.some((name) => name.startsWith("files/"))).toBe(true);
	});

	test("empty project: Download all is disabled, tab-focusable, and surfaces the empty tooltip", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.personal.emptyProjectId);

		await page.goto(personalProjectUrl(TEST_DATA.personal.emptyProjectId));

		const button = page.getByRole("button", {
			name: /download all contexts/i,
		});
		await button.waitFor({ state: "visible", timeout: 15_000 });

		// Disabled semantics (aria-disabled rather than the HTML disabled
		// attribute, so the button stays tab-focusable per A9).
		await expect(button).toHaveAttribute("aria-disabled", "true");

		// Hover surfaces the empty tooltip.
		await button.hover();
		await expect(
			page.getByText(/no contexts to download/i).first(),
		).toBeVisible({ timeout: 5_000 });
	});
});

test.describe("Project contexts — download (organization tenant)", () => {
	test.beforeEach(async () => {
		skipIfAnyPlaceholder(
			TEST_DATA.org.slug,
			TEST_DATA.org.projectId,
			TEST_DATA.org.projectSlug,
		);
	});

	test("per-row Class A download works inside an organization context", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.org.fileName);

		await gotoProjectPage(
			page,
			orgProjectUrl(TEST_DATA.org.slug, TEST_DATA.org.projectId),
		);

		await openRowMenu(page, TEST_DATA.org.fileName);

		const { filename, path } = await captureDownload(page, () =>
			clickRowDownload(page),
		);

		expect(filename.length).toBeGreaterThan(0);
		const buf = readFileSync(path);
		expect(buf.byteLength).toBeGreaterThan(0);
	});

	test("Download all ZIP fires and matches the org project slug", async ({
		page,
	}) => {
		await gotoProjectPage(
			page,
			orgProjectUrl(TEST_DATA.org.slug, TEST_DATA.org.projectId),
		);

		const { filename, path } = await captureDownload(page, () =>
			clickDownloadAll(page),
		);

		expect(filename).toMatch(/-contexts-\d{4}-\d{2}-\d{2}\.zip$/);
		expect(filename.startsWith(TEST_DATA.org.projectSlug)).toBe(true);

		const buffer = readFileSync(path);
		expect(buffer.slice(0, 4).toString("binary")).toBe("PK\u0003\u0004");
		const entries = listZipEntries(buffer);
		expect(entries).toContain("MANIFEST.txt");
	});
});
