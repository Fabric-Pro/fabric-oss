/**
 * E2E: Bulk feature export — kanban selection action bar.
 *
 * Spec:
 *   fabric/specs/2026-05-05-feature-export-download/spec.md §3.1, §5.3
 *   fabric/specs/2026-05-05-feature-export-download/spec.md §8.4
 *
 * Scenarios:
 *   1. Open the kanban → multi-select 3 features (one stub) → click
 *      `Download selected (.zip)` → assert a `.zip` download arrives;
 *      parse the central directory and assert there are 2 `.md` files
 *      plus a `MANIFEST.txt`; assert the manifest body lists the stub
 *      under `SKIPPED`.
 *   2. Select 51 features → assert the Download button is disabled and
 *      its tooltip surfaces the `tooMany` copy.
 *
 * Setup: reuses the existing `auth.setup.ts` storageState. IDs are read
 * from env vars so the suite stays green on PR checks while remaining
 * runnable manually.
 *
 * Env vars consumed (all optional):
 *   TEST_PERSONAL_PROJECT_WITH_FEATURES_ID    - project id
 *   TEST_PERSONAL_FEATURE_BULK_NON_STUB_IDS   - comma-separated story ids
 *                                               (must include exactly two
 *                                               non-stub features)
 *   TEST_PERSONAL_FEATURE_STUB_ID             - story id that is a stub
 *   TEST_PERSONAL_PROJECT_WITH_51_FEATURES_ID - project with at least 51
 *                                               features for the cap test
 *
 * Manual runbook:
 *   - Reuse the project from `feature-download-single.spec.ts`. Add a
 *     third real feature so the bulk test has 3 selectable rows: 2 with
 *     content + 1 stub.
 *   - For the cap test: create or reuse a project with 51+ features.
 *
 * Run:
 *   pnpm --filter web e2e tests/stories/feature-download-bulk.spec.ts
 */

import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// ── ZIP smoke helpers ─────────────────────────────────────────────────────
// Inline central-directory reader — same approach as
// `apps/web/tests/projects/contexts-download.spec.ts`. The repo only depends
// on `archiver` (write-only) so we read entry names without decompressing.

function listZipEntries(buffer: Buffer): string[] {
	const eocdSig = 0x06054b50;
	const cdSig = 0x02014b50;
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

/**
 * Read the uncompressed payload of a single STORED-method entry. Used only
 * for `MANIFEST.txt`, which the bulk procedure appends as a plain string
 * (default archiver behaviour for tiny entries).
 */
function readZipEntry(buffer: Buffer, name: string): string {
	const localSig = 0x04034b50;
	let ptr = 0;
	while (ptr + 30 <= buffer.length) {
		if (buffer.readUInt32LE(ptr) !== localSig) {
			throw new Error(`ZIP: local header mismatch at offset ${ptr}`);
		}
		const compMethod = buffer.readUInt16LE(ptr + 8);
		const compSize = buffer.readUInt32LE(ptr + 18);
		const uncSize = buffer.readUInt32LE(ptr + 22);
		const nameLen = buffer.readUInt16LE(ptr + 26);
		const extraLen = buffer.readUInt16LE(ptr + 28);
		const entryName = buffer.toString("utf8", ptr + 30, ptr + 30 + nameLen);
		const dataStart = ptr + 30 + nameLen + extraLen;
		if (entryName === name) {
			if (compMethod !== 0) {
				throw new Error(
					`ZIP: cannot read '${name}' inline (compressed; method=${compMethod})`,
				);
			}
			return buffer.toString("utf8", dataStart, dataStart + uncSize);
		}
		ptr = dataStart + compSize;
	}
	throw new Error(`ZIP: entry '${name}' not found in archive`);
}

// ── Test data & guards ────────────────────────────────────────────────────

const TEST_DATA = {
	projectId:
		process.env.TEST_PERSONAL_PROJECT_WITH_FEATURES_ID ??
		"<personal-project-id>",
	bulkNonStubIds: (
		process.env.TEST_PERSONAL_FEATURE_BULK_NON_STUB_IDS ??
		"<personal-bulk-ids>"
	).split(","),
	stubStoryId:
		process.env.TEST_PERSONAL_FEATURE_STUB_ID ?? "<personal-stub-id>",
	projectWith51:
		process.env.TEST_PERSONAL_PROJECT_WITH_51_FEATURES_ID ??
		"<personal-51-project-id>",
} as const;

function isPlaceholder(value: string): boolean {
	return value.startsWith("<") && value.endsWith(">");
}

function skipIfAnyPlaceholder(...values: string[]): void {
	for (const v of values) {
		if (isPlaceholder(v)) {
			test.skip();
			return;
		}
	}
}

// ── Page helpers ──────────────────────────────────────────────────────────

function projectKanbanUrl(projectId: string): string {
	return `/app/projects/${projectId}?tab=stories`;
}

async function gotoKanban(page: Page, projectId: string): Promise<void> {
	await page.goto(projectKanbanUrl(projectId));
	// Selection action bar only renders when a card is selected, so we just
	// wait for the kanban region to be present.
	await page
		.getByRole("region", { name: /kanban/i })
		.or(page.locator('[aria-label*="kanban" i]').first())
		.waitFor({ state: "visible", timeout: 20_000 });
}

/** Click the per-card selection checkbox for the story whose identifier matches. */
async function selectStoryById(page: Page, storyId: string): Promise<void> {
	// Use the data-story-id attribute that StoryCard sets on its outer
	// container (the kanban tests rely on this hook today).
	const card = page
		.locator(`[data-story-id="${storyId}"]`)
		.or(page.locator(`[data-id="${storyId}"]`))
		.first();
	const checkbox = card.getByRole("checkbox").first();
	await checkbox.click();
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.describe("Feature export — bulk (kanban selection action bar)", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(
			TEST_DATA.projectId,
			TEST_DATA.bulkNonStubIds[0],
			TEST_DATA.stubStoryId,
		);
	});

	test("3 selected features (1 stub) → ZIP contains 2 .md + MANIFEST.txt with the stub under SKIPPED", async ({
		page,
	}) => {
		test.skip(
			TEST_DATA.bulkNonStubIds.length < 2,
			"Need at least 2 non-stub story ids in TEST_PERSONAL_FEATURE_BULK_NON_STUB_IDS",
		);

		await gotoKanban(page, TEST_DATA.projectId);

		// Select the two non-stubs + the stub.
		await selectStoryById(page, TEST_DATA.bulkNonStubIds[0]);
		await selectStoryById(page, TEST_DATA.bulkNonStubIds[1]);
		await selectStoryById(page, TEST_DATA.stubStoryId);

		// The action bar surfaces the Download button.
		const downloadBtn = page.getByRole("button", {
			name: /download.*selected/i,
		});
		await downloadBtn.waitFor({ state: "visible", timeout: 5_000 });

		const [download] = await Promise.all([
			page.waitForEvent("download", { timeout: 30_000 }),
			downloadBtn.click(),
		]);

		const filename = download.suggestedFilename();
		expect(filename).toMatch(/\.zip$/i);
		const path = await download.path();
		if (!path) {
			throw new Error("download produced no local path");
		}
		const buffer = readFileSync(path);
		expect(buffer.slice(0, 4).toString("binary")).toBe("PK\x03\x04");

		const entries = listZipEntries(buffer);
		expect(entries).toContain("MANIFEST.txt");
		const mdEntries = entries.filter((e) => e.endsWith(".md"));
		expect(mdEntries).toHaveLength(2);

		const manifest = readZipEntry(buffer, "MANIFEST.txt");
		expect(manifest).toContain("--- INCLUDED (2) ---");
		expect(manifest).toContain("--- SKIPPED (1) ---");
		expect(manifest).toContain("SKIPPED — insufficient content");
	});
});

test.describe("Feature export — soft cap (51+ features)", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(TEST_DATA.projectWith51);
	});

	test("Selecting 51 features disables the Download button and shows the tooMany tooltip", async ({
		page,
	}) => {
		await gotoKanban(page, TEST_DATA.projectWith51);

		// Use the kanban "select all" affordance if present; otherwise tick
		// 51 individual cards. The exact mechanism is project-dependent; we
		// rely on a `data-select-all` button if it exists, falling back to
		// the first 51 visible checkboxes.
		const selectAll = page.getByRole("button", {
			name: /select all/i,
		});
		if (await selectAll.isVisible().catch(() => false)) {
			await selectAll.click();
		} else {
			const checkboxes = page.getByRole("checkbox");
			const count = await checkboxes.count();
			const upper = Math.min(count, 51);
			for (let i = 0; i < upper; i++) {
				await checkboxes.nth(i).click();
			}
		}

		const downloadBtn = page.getByRole("button", {
			name: /download.*selected/i,
		});
		await downloadBtn.waitFor({ state: "visible", timeout: 5_000 });
		await expect(downloadBtn).toBeDisabled();

		// Hovering the disabled button surfaces the tooltip.
		await downloadBtn.hover();
		await expect(page.getByText(/fewer than 50 features/i)).toBeVisible({
			timeout: 3_000,
		});
	});
});
