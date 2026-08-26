# Playwright Test Fixtures

Tiny binary fixtures used by the Copilot attachment specs
(`ai-feature-assistant-attachments.spec.ts`,
`copilot-attachments-regression.spec.ts`).

## Files

| File | Purpose | Size |
|---|---|---|
| `sample.pdf` | Minimal one-page PDF, opens in any PDF viewer. Body text reads `"Add PostgreSQL as the primary database."` so end-to-end tests can assert the agent extracted and used the file content. | ~567 B |
| `sample.png` | 1x1 transparent PNG. Used by the paste-image assertions and as a bytes payload for in-browser `DataTransfer` simulation. | 68 B |
| `sample.xlsx` | Two-sheet workbook (`Summary`, `Q1 Detail`). Multi-sheet on purpose: it proves a workbook with more than one sheet is read whole, with no sheet-selection prompt. Committed as a real file rather than inlined bytes — a zip container cannot be hand-written the way `sample.png` is. | ~7 KB |

## Why `sample.xlsx` must be a real workbook

The other fixtures exist only to produce a `File` with the right name and MIME.
`sample.xlsx` is different: the client-side classifier
(`classifyAiChatWorkbook`) reads the file's **leading bytes** and accepts a
`.xlsx` only when they are the `PK` zip signature. A stub would be rejected
before the chip ever appeared, so the spec would pass against the wrong path.
The `.xls` refusal test needs the mirror-image property — a real OLE signature
(`D0 CF 11 E0`) — but only the first four bytes are read, so that one is inlined
as a byte array in the spec rather than committed here.

## Regenerate

All three files are regenerated from the snippets below. Keep them tiny — these
specs only need byte-accurate `File` objects, not real-world content.

```js
const fs = require("node:fs");

// Minimal PDF (1 page, 567 bytes). The xref byte offsets are computed
// from the assembled buffer so the table stays consistent if the body
// text is changed — do not hand-edit them.
const text = "Add PostgreSQL as the primary database.";
const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`;
const streamLen = Buffer.byteLength(stream, "binary");
const objects = [
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
  `4 0 obj<</Length ${streamLen}>>stream\n${stream}endstream\nendobj\n`,
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
];
const header = "%PDF-1.4\n";
const offsets = [0];
let cursor = Buffer.byteLength(header, "binary");
for (const obj of objects) {
  offsets.push(cursor);
  cursor += Buffer.byteLength(obj, "binary");
}
const xrefOffset = cursor;
const xrefLines = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
for (let i = 1; i <= objects.length; i++) {
  xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
}
const trailer = `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
const pdf = Buffer.from(header + objects.join("") + xrefLines.join("") + trailer, "binary");
fs.writeFileSync("apps/web/tests/fixtures/sample.pdf", pdf);

// 1x1 transparent PNG (68 bytes).
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0b, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x02, 0x00,
  0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
fs.writeFileSync("apps/web/tests/fixtures/sample.png", png);
```

`sample.xlsx` needs `exceljs`, so it is regenerated separately — run this from
`apps/web` (module resolution follows the script's location, not the cwd):

```js
const ExcelJS = require("exceljs");

async function main() {
  const wb = new ExcelJS.Workbook();
  // Pinned so regeneration stays as close to byte-stable as exceljs allows.
  const fixed = new Date("2026-01-01T00:00:00Z");
  wb.created = fixed;
  wb.modified = fixed;
  wb.creator = "fabric-tests";
  wb.lastModifiedBy = "fabric-tests";

  const summary = wb.addWorksheet("Summary");
  summary.addRow(["Metric", "Q1", "Q2"]);
  summary.addRow(["Signups", 1200, 1810]);
  summary.addRow(["Churn", 34, 29]);

  const detail = wb.addWorksheet("Q1 Detail");
  detail.addRow(["Item", "Owner", "Status"]);
  detail.addRow(["Onboarding revamp", "Ada", "Shipped"]);
  detail.addRow(["Billing migration", "Grace", "In progress"]);

  await wb.xlsx.writeFile("tests/fixtures/sample.xlsx");
}
main();
```

The sheet names above are mirrored by the `process` mock's `extraction.sheets`
in `ai-feature-assistant-attachments.spec.ts`. Rename a sheet here and that
mock is lying — update both.
