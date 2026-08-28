import { describe, expect, it } from "vitest";
import { buildContextDownloadManifest } from "../context-download-manifest";
import {
	CONTEXT_SKIP_REASON_CODES,
	type ContextSkipReason,
	describeContextSkipReason,
} from "../context-skip-reason";

const FIXED_DATE = new Date("2026-04-15T14:22:03.000Z");

const baseArgs = {
	project: { id: "proj_123", name: "Acme Portal" },
	exportedAt: FIXED_DATE,
	exportedBy: { id: "user_42", email: "alice@example.com" },
	totalBytes: 2048,
};

describe("buildContextDownloadManifest", () => {
	it("renders personal-tenant header line", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [],
			skipped: [],
		});
		expect(out).toContain("Tenant        : Personal");
		expect(out).toContain("Project       : Acme Portal");
		expect(out).toContain("Project ID    : proj_123");
		expect(out).toContain("Exported at   : 2026-04-15T14:22:03Z");
		expect(out).toContain("Exported by   : user_42 (alice@example.com)");
		expect(out).toContain("Context count : 0 included, 0 skipped");
	});

	it("renders org-tenant header as '{id} ({name})'", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "org", id: "org_7", name: "Acme Inc" },
			included: [],
			skipped: [],
		});
		expect(out).toContain("Tenant        : org_7 (Acme Inc)");
	});

	it("preserves INCLUDED row insertion order", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [
				{
					type: "UPLOAD",
					title: "Alpha",
					fileInZip: "files/alpha.pdf",
				},
				{ type: "NOTE", title: "Beta", fileInZip: "files/beta.md" },
				{ type: "LINK", title: "Gamma", fileInZip: "files/gamma.txt" },
			],
			skipped: [],
		});
		const alpha = out.indexOf("Alpha");
		const beta = out.indexOf("Beta");
		const gamma = out.indexOf("Gamma");
		expect(alpha).toBeGreaterThan(-1);
		expect(alpha).toBeLessThan(beta);
		expect(beta).toBeLessThan(gamma);
		expect(out).toContain("--- INCLUDED (3) ---");
	});

	it("omits the SKIPPED section entirely when zero skipped", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [
				{
					type: "UPLOAD",
					title: "Alpha",
					fileInZip: "files/alpha.pdf",
				},
			],
			skipped: [],
		});
		expect(out).not.toContain("SKIPPED");
	});

	it("renders every taxonomy reason verbatim", () => {
		// The manifest prints whatever `describeContextSkipReason` produces,
		// so walking the taxonomy here means a new reason cannot ship without
		// this file proving it renders (Fizzy #2228).
		const reasons = CONTEXT_SKIP_REASON_CODES.map((code) =>
			describeContextSkipReason(
				code === "CONVERSATION_NOT_CAPTURED" ||
					code === "PRIVATE_CONVERSATION_EXCLUDED"
					? { code, sourceSystem: "Slack" }
					: ({ code } as ContextSkipReason),
			),
		);
		// The samples above are built through a cast, so a new payload-carrying
		// reason would render `Linked undefined chat` and still pass the
		// verbatim check below. Fail on the placeholder instead.
		for (const reason of reasons) {
			expect(reason).not.toMatch(/undefined/);
		}
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [],
			skipped: reasons.map((reason, i) => ({
				type: "UPLOAD",
				title: `Item ${i}`,
				reason,
			})),
		});
		expect(out).toContain(
			`--- SKIPPED (${CONTEXT_SKIP_REASON_CODES.length}) ---`,
		);
		for (const reason of reasons) {
			expect(out).toContain(reason);
		}
	});

	it("never truncates long titles — they overflow their column", () => {
		const longTitle = "a".repeat(120);
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [
				{
					type: "UPLOAD",
					title: longTitle,
					fileInZip: "files/long.pdf",
				},
			],
			skipped: [],
		});
		expect(out).toContain(longTitle);
	});

	it("uses fixed 3 / 14 / 40 / rest column widths for included rows", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [
				{
					type: "UPLOAD",
					title: "Brief",
					fileInZip: "files/brief.pdf",
				},
			],
			skipped: [],
		});
		const lines = out.split("\n");
		const dataLine = lines.find((l) => l.includes("Brief"));
		expect(dataLine).toBeDefined();
		if (!dataLine) {
			return;
		}
		// Col 1 (3 chars = "01 ") + space, col 2 (14 chars) + space, col 3 (40)
		// + space, then file-in-zip.
		expect(dataLine.slice(0, 3)).toBe("01 ");
		expect(dataLine.slice(4, 18)).toBe("UPLOAD        ");
		// Col 3 is 40 chars for "Brief" padded with spaces
		expect(dataLine.slice(19, 59)).toBe("Brief".padEnd(40, " "));
		expect(dataLine.slice(60)).toBe("files/brief.pdf");
	});

	it("uses fixed 3 / 14 / 40 / rest column widths for skipped rows", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [],
			skipped: [
				{
					type: "UPLOAD",
					title: "Old interview",
					reason: "Source object not found in storage",
				},
			],
		});
		const lines = out.split("\n");
		const dataLine = lines.find((l) => l.includes("Old interview"));
		expect(dataLine).toBeDefined();
		if (!dataLine) {
			return;
		}
		expect(dataLine.slice(0, 3)).toBe("01 ");
		expect(dataLine.slice(4, 18)).toBe("UPLOAD        ");
		expect(dataLine.slice(19, 59)).toBe("Old interview".padEnd(40, " "));
		expect(dataLine.slice(60)).toBe("Source object not found in storage");
	});

	it("renders the total-size line and counts summary", () => {
		const out = buildContextDownloadManifest({
			...baseArgs,
			tenant: { kind: "personal" },
			included: [
				{ type: "UPLOAD", title: "A", fileInZip: "files/a.pdf" },
				{ type: "NOTE", title: "B", fileInZip: "files/b.md" },
			],
			skipped: [
				{
					type: "LINK",
					title: "C",
					reason: describeContextSkipReason({
						code: "NOTHING_STORED",
					}),
				},
			],
			totalBytes: 1536,
		});
		expect(out).toContain("Context count : 2 included, 1 skipped");
		expect(out).toMatch(/Total size {4}: .*KB|Total size {4}: .*B/);
	});
});
