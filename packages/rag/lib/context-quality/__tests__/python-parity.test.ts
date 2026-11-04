import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	contextQualitySourceRevision,
	evaluateContextQuality,
} from "../evaluate";

const NOTEBOOK = resolve(
	__dirname,
	"../../../../../deployment/databricks/context-quality-evaluations/src/evaluate_context.py",
);
const PYTHON =
	"import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['evaluate'](json.load(sys.stdin)),ensure_ascii=True))";

function runPython(input: unknown) {
	return spawnSync("python3", ["-c", PYTHON, NOTEBOOK], {
		input: JSON.stringify(input),
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 512 * 1024,
	});
}

function fixture() {
	const content =
		'Example policy: bookings can be moved online.\r\nQuoted: "yes".\n';
	return {
		version: 1,
		sources: [
			{
				id: "example-source",
				content,
				revision: contextQualitySourceRevision(content),
			},
		],
		cases: [
			{
				id: "example-case",
				recordedAnswer: "Bookings can be moved online.",
				retrievedSourceIds: ["example-source"],
				citedSourceIds: ["example-source"],
				expectations: {
					expectedSourceIds: ["example-source"],
					requiredPhrases: ["moved online"],
					forbiddenPhrases: ["phone only"],
				},
			},
		],
	};
}

describe("Databricks Python scorer parity with the canonical Fabric evaluator", () => {
	const good = fixture();
	const failure = fixture();
	failure.cases[0]!.recordedAnswer = "phone only";
	failure.cases[0]!.citedSourceIds = ["unavailable"];
	const unicode = fixture();
	unicode.sources = ["\ue000", "😀", "A", "\ud800"].map((id) => ({
		id,
		content: `source ${id}`,
		revision: contextQualitySourceRevision(`source ${id}`),
	}));
	unicode.cases = unicode.sources.map(({ id }) => ({
		id,
		recordedAnswer: "😀\u0085\u2028",
		retrievedSourceIds: [id],
		citedSourceIds: [id],
		expectations: {
			expectedSourceIds: [id],
			requiredPhrases: ["\ud83d", "\u0085"],
			forbiddenPhrases: ["never"],
		},
	}));
	const noExpectedSource = fixture();
	noExpectedSource.cases[0]!.expectations.expectedSourceIds = [];
	const emptyAnswer = fixture();
	emptyAnswer.cases[0]!.recordedAnswer = "\ufeff\u2000\n";
	const precision = fixture();
	precision.cases[0]!.retrievedSourceIds = ["example-source", "missing"];
	precision.cases[0]!.citedSourceIds = ["example-source", "missing"];
	const unalignedUtf16 = fixture();
	unalignedUtf16.cases[0]!.recordedAnswer = "A\u0100";
	unalignedUtf16.cases[0]!.expectations.requiredPhrases = ["\u4101"];

	it.each([
		good,
		failure,
		unicode,
		noExpectedSource,
		emptyAnswer,
		precision,
		unalignedUtf16,
	])("matches the complete report and all hashes %#", (input) => {
		const expected = evaluateContextQuality(input);
		const result = runPython(input);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(expected);
	});

	it("rejects tampered source content in both runtimes", () => {
		const input = fixture();
		input.sources[0]!.content += " changed";
		expect(() => evaluateContextQuality(input)).toThrow();
		expect(runPython(input).status).not.toBe(0);
	});

	it("rejects duplicate identifiers and missing expectations in both runtimes", () => {
		const duplicate = fixture();
		duplicate.cases.push({ ...duplicate.cases[0]! });
		const empty = fixture();
		empty.cases[0]!.expectations = {
			expectedSourceIds: [],
			requiredPhrases: [],
			forbiddenPhrases: [],
		};
		for (const input of [duplicate, empty]) {
			expect(() => evaluateContextQuality(input)).toThrow();
			expect(runPython(input).status).not.toBe(0);
		}
	});
});
