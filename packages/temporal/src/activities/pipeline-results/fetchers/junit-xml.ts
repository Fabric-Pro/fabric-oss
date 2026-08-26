/**
 * JUnit XML → `JUnitSuite[]` parser.
 *
 * GitHub Actions has no per-test API: teams upload a JUnit report via
 * `actions/upload-artifact`, and the fetcher downloads + unzips it. This module
 * turns that raw XML into the flat, pre-classified `JUnitSuite[]` shape the
 * `mapGithubActionsToNormalizedRuns` mapper consumes — so the network/zip code
 * stays in the fetcher and the reshape stays here, each independently testable.
 *
 * Handles the real-world JUnit variants: a `<testsuites>` root wrapping many
 * `<testsuite>`, a single bare `<testsuite>` root, and `<testsuite>` nested
 * inside `<testsuite>` (walked recursively). A `<testcase>`'s status comes from
 * its child element — `<failure>`→failed, `<error>`→error, `<skipped>`→skipped,
 * otherwise passed — never from `<system-out>`/`<system-err>`, which are output.
 */

import { XMLParser } from "fast-xml-parser";
import type { JUnitSuite, JUnitTestCase } from "../providers/github-actions";

// Attributes carry all JUnit data, so they must be parsed. Values are kept as
// RAW STRINGS (parseAttributeValue/parseTagValue off) to avoid fast-xml-parser
// coercing a classname like "123" or "true" into a number/boolean; `time` is
// Number()-parsed explicitly below. `testsuite`/`testcase` and the outcome
// children are forced to arrays so a single-element collapse never changes shape.
/**
 * Entity-expansion ceilings, stated here rather than inherited.
 *
 * A JUnit report is an untrusted archive entry: anyone who can open a PR on a
 * connected repository controls its bytes. `fast-xml-parser` does defend against
 * billion-laughs and external entities — but those are DEFAULTS of the version
 * currently locked, and this package depends on a `^5` range. A future minor
 * that relaxes them would remove the protection with nothing in Fabric noticing,
 * because no test and no line of our own code asserted it.
 *
 * Setting them explicitly makes the ceiling visible, greppable, and covered by
 * the billion-laughs test below.
 */
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	parseAttributeValue: false,
	parseTagValue: false,
	trimValues: true,
	cdataPropName: "#cdata",
	processEntities: {
		maxEntitySize: 10_000,
		maxEntityCount: 1_000,
		maxExpandedLength: 100_000,
	},
	isArray: (name) =>
		name === "testsuite" ||
		name === "testcase" ||
		name === "failure" ||
		name === "error" ||
		name === "skipped",
});

/** A parsed XML node: attribute keys are `@_`-prefixed, children are nested. */
type XmlNode = Record<string, unknown>;

/** Coerce fast-xml-parser's `unknown` child value into an array of nodes. */
function asNodes(value: unknown): XmlNode[] {
	if (Array.isArray(value)) {
		return value.filter(
			(v): v is XmlNode => typeof v === "object" && v !== null,
		);
	}
	if (value && typeof value === "object") {
		return [value as XmlNode];
	}
	return [];
}

/** Read a string attribute (`@_name`) off a node, or `undefined` when absent. */
function attr(node: XmlNode, name: string): string | undefined {
	const raw = node[`@_${name}`];
	return raw == null ? undefined : String(raw);
}

/**
 * Pull the human-readable failure detail off a `<failure>`/`<error>` node: the
 * `message` attribute plus the element's text / CDATA body, whichever are
 * present, joined. Returns `undefined` when neither carries anything.
 */
function failureText(node: XmlNode): string | undefined {
	const parts: string[] = [];
	const message = attr(node, "message");
	if (message) {
		parts.push(message);
	}
	for (const key of ["#text", "#cdata"]) {
		const body = node[key];
		if (typeof body === "string" && body.trim()) {
			parts.push(body.trim());
		}
	}
	const joined = parts.join("\n").trim();
	return joined || undefined;
}

/** Classify one `<testcase>` node into the pre-mapped JUnit shape. */
function toTestCase(tc: XmlNode): JUnitTestCase {
	const failures = asNodes(tc.failure);
	const errors = asNodes(tc.error);
	const skipped = asNodes(tc.skipped);

	let status: JUnitTestCase["status"] = "passed";
	let failureMessage: string | undefined;
	// A test can technically carry more than one outcome child; failure/error win
	// over skipped, and the first one's text is the reported detail.
	if (failures.length > 0) {
		status = "failed";
		failureMessage = failureText(failures[0]);
	} else if (errors.length > 0) {
		status = "error";
		failureMessage = failureText(errors[0]);
	} else if (skipped.length > 0) {
		status = "skipped";
		failureMessage = failureText(skipped[0]);
	}

	const timeRaw = attr(tc, "time");
	const time = timeRaw != null ? Number(timeRaw) : undefined;

	return {
		name: attr(tc, "name") ?? "",
		classname: attr(tc, "classname"),
		time: time != null && Number.isFinite(time) ? time : undefined,
		status,
		failureMessage,
	};
}

/**
 * Recursively collect suites from a `<testsuite>` node and any nested
 * `<testsuite>` children. A suite with no direct testcases but with nested
 * suites contributes only through its children (no empty parent suite emitted).
 */
function collectSuites(suiteNode: XmlNode, out: JUnitSuite[]): void {
	const testcases = asNodes(suiteNode.testcase).map(toTestCase);
	if (testcases.length > 0) {
		out.push({ name: attr(suiteNode, "name") ?? "", testcases });
	}
	for (const nested of asNodes(suiteNode.testsuite)) {
		collectSuites(nested, out);
	}
}

/**
 * Parse a JUnit XML document into `JUnitSuite[]`. Accepts either a
 * `<testsuites>` root or a bare `<testsuite>` root; returns `[]` for malformed
 * or empty input rather than throwing, so one bad artifact never fails a sync.
 */
export function parseJUnitXml(xml: string): JUnitSuite[] {
	let doc: XmlNode;
	try {
		doc = parser.parse(xml) as XmlNode;
	} catch {
		return [];
	}
	if (!doc || typeof doc !== "object") {
		return [];
	}

	const out: JUnitSuite[] = [];
	// Root `<testsuites>` wrapping many `<testsuite>` …
	for (const suites of asNodes(doc.testsuites)) {
		for (const suite of asNodes(suites.testsuite)) {
			collectSuites(suite, out);
		}
	}
	// … or a single bare `<testsuite>` root.
	for (const suite of asNodes(doc.testsuite)) {
		collectSuites(suite, out);
	}
	return out;
}
