import { describe, expect, it } from "vitest";
import {
	analyzeChunkQuality,
	classifyBoundary,
	type QualitySource,
	sizeDistribution,
} from "../quality";

function source(
	id: string,
	chunks: string[],
	extra: Partial<QualitySource> = {},
): QualitySource {
	return {
		id,
		contentType: "prd",
		textLength: chunks.join("").length,
		embedded: true,
		chunks: chunks.map((content) => ({ content })),
		...extra,
	};
}

const LONG = "x".repeat(400);

describe("classifyBoundary", () => {
	it("recognises clean, mid-sentence, list and table cuts", () => {
		expect(classifyBoundary(`${LONG} end.`, "Next sentence.")).toBe(
			"clean",
		);
		expect(classifyBoundary(`${LONG} the quick brown`, "fox jumps.")).toBe(
			"mid-sentence",
		);
		expect(
			classifyBoundary("- EX-1 Build the login", "page with SSO support"),
		).toBe("mid-list-item");
		expect(classifyBoundary("| 1 | a |", "| 2 | b |")).toBe("split-table");
		expect(classifyBoundary("- EX-1 Done", "- EX-2 Next")).toBe("clean");
	});

	it("does not count a table continued under its repeated header", () => {
		const next = ["| n | v |", "|---|---|", "| 2 | b |"].join(
			String.fromCharCode(10),
		);
		expect(classifyBoundary("| 1 | a |", next)).toBe("clean");
	});
});

describe("analyzeChunkQuality", () => {
	it("counts the problems on synthetic fixtures", () => {
		const report = analyzeChunkQuality([
			source("cut", [`${LONG} the quick brown`, `fox jumps. ${LONG}`]),
			source("table", [`${LONG}\n| 1 | a |`, `| 2 | b |\n${LONG}`]),
			source("list", [
				`${LONG}\n- EX-1 Build the login`,
				`page with SSO ${LONG}`,
			]),
			source("tiny", [`${LONG}.`, "ok."]),
			source("pending", [], { embedded: false }),
			source("kb", ["k".repeat(24_000)], {
				contentType: "knowledge",
				knowledge: true,
				textLength: 30_000,
			}),
			source("short", ["One short note."]),
		]);

		expect(report.problems).toEqual({
			cutMidSentence: 1,
			cutMidListItem: 1,
			splitTables: 1,
			tinyChunks: 1,
			notEmbedded: 1,
			truncatedKnowledge: { entries: 1, charactersLost: 6_000 },
		});
		expect(report.examples.splitTables).toEqual(["table"]);
		const prd = report.byType.find((t) => t.contentType === "prd");
		expect(prd).toMatchObject({ sources: 6, profiles: ["setting"] });
	});

	it("reports the size distribution per type", () => {
		expect(sizeDistribution([100, 300, 200, 400])).toEqual({
			min: 100,
			p50: 200,
			p90: 400,
			max: 400,
		});
		expect(sizeDistribution([])).toBeNull();
	});
});
