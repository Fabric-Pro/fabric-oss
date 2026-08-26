/**
 * Local smoke test: run the new ADO HTML pipeline on a representative body,
 * PATCH the result to a real ADO work item, then fetch it back to confirm
 * what ADO stored.
 *
 * Usage (PowerShell):
 *   $env:ADO_PAT="<pat>"; $env:ADO_WORK_ITEM_ID=170; pnpm tsx packages/temporal/scripts/ado-smoke-push.ts
 *
 * Required env:
 *   ADO_PAT             — Personal Access Token with Work Items (Read & Write)
 *   ADO_WORK_ITEM_ID    — numeric id of the work item to PATCH (e.g. 170)
 *
 * Optional env:
 *   ADO_ORG             — defaults to "example-org"
 *   ADO_PROJECT         — defaults to "Fabric"
 *
 * Side effects: PATCHes the work item's System.Description in-place.
 * Diagnostic only — does not touch any other ADO fields.
 */

import { markdownToSimpleHtml } from "../src/activities/pm-integration/story-sync";
import {
	extractAdoImages,
	extractAdoTables,
	restoreAdoImages,
	restoreAdoTables,
	rewriteAdoInCellImagesToAttachments,
	uploadAdoImageAttachments,
} from "../src/activities/pm-integration/story-sync-media";

const PAT = process.env.ADO_PAT;
const WORK_ITEM_ID = process.env.ADO_WORK_ITEM_ID;
const ORG = process.env.ADO_ORG ?? "example-org";
const PROJECT = process.env.ADO_PROJECT ?? "Fabric";

if (!PAT) {
	console.error("ADO_PAT env var is required");
	process.exit(1);
}
if (!WORK_ITEM_ID) {
	console.error("ADO_WORK_ITEM_ID env var is required");
	process.exit(1);
}

// Representative body matching what Fabric would produce: AI-drafted bug
// template with a Tiptap table embedded mid-document and a standalone
// markdown image attachment at the end. This exercises every shape the
// new ADO pipeline has to handle.
const FABRIC_BODY = `# Bug: PM Sync ADO HTML body smoke test

## Bug Metadata

- kind: BUG
- severity: High
- priority: P1
- dateReported: 2026-05-23

## Overview

PR #1160 fixes the regression where Fabric markdown around an embedded \`<table>\` block was shown as **raw text** in ADO. The whole body should now ship as HTML.

## Steps to Reproduce

1. Push a Fabric feature whose description has \`## headings\`, \`- bullets\`, **bold**, and an inline Tiptap table to ADO.
2. Open the ADO ticket.
3. Verify all four formatting shapes render correctly.

## Issue Summary

<table class="tiptap-table" style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Area</p></th><th colspan="1" rowspan="1"><p>Status</p></th><th colspan="1" rowspan="1"><p>Notes</p></th></tr><tr><td colspan="1" rowspan="1"><p><strong>Navigation</strong></p></td><td colspan="1" rowspan="1"><p>Fixed</p></td><td colspan="1" rowspan="1"><p>Return to list works<br>No 404 page</p></td></tr><tr><td colspan="1" rowspan="1"><p><strong>Project Brief</strong></p></td><td colspan="1" rowspan="1"><p>Fixed</p></td><td colspan="1" rowspan="1"><ul><li><p>Persists on save</p></li><li><p>Revert restored</p></li><li><p>No data loss</p></li></ul></td></tr><tr><td colspan="1" rowspan="1"><p><strong>Tech Stack</strong></p></td><td colspan="1" rowspan="1"><p>Open</p></td><td colspan="1" rowspan="1"><p><img src="https://staging.fabric.pro/images/fabric-white-logo.svg" alt="Fabric logo placeholder"></p></td></tr></tbody></table>

## Acceptance Criteria

- AC1: \`## Heading\` shows as a real H2 (not raw text)
- AC2: \`**bold**\` shows as bold (not literal \`**\`)
- AC3: \`- bullet\` shows as a real bullet (not \`-\` text)
- AC4: Table renders as a real HTML table
- AC5: Standalone \`![…](url)\` shows as an image

## Attachments

![Sample diagram](https://placehold.co/300x150/png?text=PR+%231160)

PR #1160 verification — local smoke test against ADO REST API.`;

async function main() {
	const ADO_TARGET = { pat: PAT!, org: ORG };

	console.log("[1/4] Running ADO pipeline on Fabric body …");
	const { withTokens: tableTokens, tables: cleanedTables } =
		extractAdoTables(FABRIC_BODY);
	const { withTokens: imgTokens, images: extractedImages } =
		extractAdoImages(tableTokens);

	console.log(
		`     Uploading ${extractedImages.length} standalone image(s) to ADO …`,
	);
	const uploadedStandalone = await uploadAdoImageAttachments(
		extractedImages,
		ADO_TARGET,
	);
	for (let i = 0; i < extractedImages.length; i++) {
		const before = extractedImages[i].src;
		const after = uploadedStandalone[i].src;
		console.log(
			`       img[${i}]: ${before.slice(0, 60)}${before.length > 60 ? "…" : ""} → ${after.slice(0, 80)}${after.length > 80 ? "…" : ""}`,
		);
	}

	console.log(
		`     Uploading in-table images for ${cleanedTables.length} table(s) …`,
	);
	const cleanedTablesWithUploadedImages = await Promise.all(
		cleanedTables.map((t) =>
			rewriteAdoInCellImagesToAttachments(t, ADO_TARGET),
		),
	);

	const html = restoreAdoImages(
		restoreAdoTables(
			markdownToSimpleHtml(imgTokens),
			cleanedTablesWithUploadedImages,
		),
		uploadedStandalone,
	);

	console.log(`     pipeline output: ${html.length} chars`);
	console.log(
		`     tables=${cleanedTables.length}, images=${extractedImages.length}, has <h2>=${/<h2>/.test(html)}, has <strong>=${html.includes("<strong>")}, has <ul><li>=${/<ul>(?:[^<]|<(?!\/ul))*<li>/.test(html)}, has clean <table>=${/<table>(?:.|\n)*<\/table>/.test(html)}, has ADO attachment img src=${/<img src="https:\/\/dev\.azure\.com\/[^"]*\/_apis\/wit\/attachments/.test(html)}`,
	);

	const authHeader = `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`;
	const url = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${WORK_ITEM_ID}?api-version=7.0`;

	console.log(`[2/4] PATCHing ${url} …`);
	const patchRes = await fetch(url, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json-patch+json",
			Authorization: authHeader,
		},
		body: JSON.stringify([
			{ op: "add", path: "/fields/System.Description", value: html },
		]),
	});

	if (!patchRes.ok) {
		console.error(`[FAIL] PATCH returned ${patchRes.status}`);
		console.error(await patchRes.text());
		process.exit(1);
	}
	const patched = (await patchRes.json()) as { id: number; rev: number };
	console.log(
		`     PATCH ok — work item ${patched.id} revision ${patched.rev}`,
	);

	console.log("[3/4] Fetching back to verify what ADO stored …");
	const getRes = await fetch(
		`https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${WORK_ITEM_ID}?api-version=7.0`,
		{ headers: { Authorization: authHeader } },
	);
	if (!getRes.ok) {
		console.error(`[FAIL] GET returned ${getRes.status}`);
		process.exit(1);
	}
	const stored = (await getRes.json()) as {
		id: number;
		rev: number;
		fields: Record<string, unknown>;
	};
	const storedDesc = String(stored.fields["System.Description"] ?? "");

	console.log(
		`     stored desc: ${storedDesc.length} chars (revision ${stored.rev})`,
	);
	console.log("[4/4] Verifying every PR #1160 acceptance criterion …");

	const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
	checks.push({
		name: "AC1 — `## Heading` becomes `<h2>`",
		ok: /<h2>\s*Overview\s*<\/h2>/i.test(storedDesc),
	});
	checks.push({
		name: "AC2 — `**bold**` becomes `<strong>`",
		ok: storedDesc.includes("<strong>raw text</strong>"),
	});
	checks.push({
		name: "AC3 — `- bullet` becomes `<li>`",
		ok:
			/<ul>(?:.|\n)*?<li>Push a Fabric feature/i.test(storedDesc) ||
			/<li>/.test(storedDesc),
	});
	checks.push({
		name: "AC4 — embedded `<table>` survives",
		ok:
			storedDesc.includes("<table>") &&
			storedDesc.includes("<th>Area</th>") &&
			/<td>Fixed\s*<\/td>/.test(storedDesc),
	});
	checks.push({
		name: "AC4a — `<br>` preserved inside cell",
		ok: /Return to list works\s*<br>\s*No 404 page/.test(storedDesc),
	});
	checks.push({
		name: "AC4b — bullet list survives inside cell",
		ok: /<td><ul><li>Persists on save\s*<\/li>/.test(storedDesc),
	});
	checks.push({
		name: "AC4c — in-cell image uploaded to ADO attachments (src points at dev.azure.com)",
		ok: /<td><img src="https:\/\/dev\.azure\.com\/[^"]*\/_apis\/wit\/attachments\//.test(
			storedDesc,
		),
	});
	checks.push({
		name: "AC5 — standalone image uploaded to ADO attachments (src points at dev.azure.com)",
		ok: /<img src="https:\/\/dev\.azure\.com\/[^"]*\/_apis\/wit\/attachments\//.test(
			storedDesc,
		),
	});
	checks.push({
		name: "AC5a — no leftover external image src (everything is ADO-hosted)",
		ok: !/<img src="https:\/\/(staging\.fabric\.pro|upload\.wikimedia\.org|placehold\.co)/.test(
			storedDesc,
		),
	});
	checks.push({
		name: "REGRESSION GUARD — backtick-wrapped `![…](url)` in AC5 prose becomes <code>",
		ok: /<code>!\[…\]\(url\)<\/code>/.test(storedDesc),
	});
	checks.push({
		name: "AC6 — ordered list (`1. … 2. …`) renders as `<ol><li>`",
		ok:
			/<ol><li>Push a Fabric feature/.test(storedDesc) &&
			/<li>Verify all four formatting shapes/.test(storedDesc),
	});
	checks.push({
		name: "AC7 — inline backtick code (`## headings`) renders as `<code>`",
		ok: /<code>## headings<\/code>/.test(storedDesc),
	});
	checks.push({
		name: "REGRESSION GUARD — no `## ` raw markdown leaked",
		ok: !/^##\s+/m.test(storedDesc) && !storedDesc.includes("## Overview"),
	});
	checks.push({
		name: "REGRESSION GUARD — no `**` raw markdown leaked",
		ok: !storedDesc.includes("**raw text**"),
	});
	checks.push({
		name: "REGRESSION GUARD — no Tiptap class leaked",
		ok: !storedDesc.includes('class="tiptap-table"'),
	});
	checks.push({
		name: "REGRESSION GUARD — no `<colgroup>` leaked",
		ok: !storedDesc.includes("<colgroup"),
	});
	checks.push({
		name: 'REGRESSION GUARD — no default `colspan="1"` leaked',
		ok: !storedDesc.includes('colspan="1"'),
	});

	console.log();
	let allPass = true;
	for (const c of checks) {
		console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}`);
		if (!c.ok) {
			allPass = false;
			if (c.detail) {
				console.log(`       ${c.detail}`);
			}
		}
	}
	console.log();
	if (allPass) {
		console.log(
			`✅ ALL CHECKS PASS — ADO work item #${WORK_ITEM_ID} now stores the PR #1160 transformed body.`,
		);
		console.log(
			`   Open: https://dev.azure.com/${ORG}/${PROJECT}/_workitems/edit/${WORK_ITEM_ID}`,
		);
	} else {
		console.log(
			"❌ SOME CHECKS FAILED — see the stored description excerpt below for diagnosis.",
		);
		console.log("\n--- stored description (first 4000 chars) ---");
		console.log(storedDesc.slice(0, 4000));
		console.log("--- end ---");
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("[FAIL] unhandled error:", err);
	process.exit(1);
});
