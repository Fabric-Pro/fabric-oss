import { describe, expect, it } from "vitest";
import { parseJUnitXml } from "../junit-xml";

describe("parseJUnitXml", () => {
	it("parses a <testsuites> wrapper with multiple suites and classifies each case", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="cart">
    <testcase classname="test/cart.test.js" name="applies a percentage discount" time="0.012">
      <failure message="expected -100 to be 80">AssertionError: expected -100 to be 80
    at Object.&lt;anonymous&gt;</failure>
    </testcase>
    <testcase classname="test/cart.test.js" name="adds an item" time="0.003"/>
  </testsuite>
  <testsuite name="checkout">
    <testcase classname="test/checkout.test.js" name="errors on empty cart">
      <error message="boom">TypeError: boom</error>
    </testcase>
    <testcase classname="test/checkout.test.js" name="skips gift wrap">
      <skipped message="not implemented"/>
    </testcase>
  </testsuite>
</testsuites>`;

		const suites = parseJUnitXml(xml);
		expect(suites).toHaveLength(2);

		const cart = suites[0];
		expect(cart.name).toBe("cart");
		expect(cart.testcases).toHaveLength(2);

		const failing = cart.testcases[0];
		expect(failing.name).toBe("applies a percentage discount");
		expect(failing.classname).toBe("test/cart.test.js");
		expect(failing.status).toBe("failed");
		expect(failing.time).toBeCloseTo(0.012);
		expect(failing.failureMessage).toContain("expected -100 to be 80");
		// The `<` in the body survives entity-decoding.
		expect(failing.failureMessage).toContain("<anonymous>");

		expect(cart.testcases[1].status).toBe("passed");

		const checkout = suites[1];
		expect(checkout.testcases[0].status).toBe("error");
		expect(checkout.testcases[0].failureMessage).toContain("boom");
		expect(checkout.testcases[1].status).toBe("skipped");
	});

	it("parses a single bare <testsuite> root (no <testsuites> wrapper)", () => {
		const xml = `<testsuite name="solo" tests="1">
  <testcase classname="s" name="only" time="1.5"/>
</testsuite>`;
		const suites = parseJUnitXml(xml);
		expect(suites).toHaveLength(1);
		expect(suites[0].name).toBe("solo");
		expect(suites[0].testcases[0].status).toBe("passed");
		expect(suites[0].testcases[0].time).toBeCloseTo(1.5);
	});

	it("does NOT treat <system-out>/<system-err> as a failure", () => {
		const xml = `<testsuite name="withOutput">
  <testcase classname="s" name="noisy but green">
    <system-out>lots of logs</system-out>
    <system-err>a warning</system-err>
  </testcase>
</testsuite>`;
		const [suite] = parseJUnitXml(xml);
		expect(suite.testcases[0].status).toBe("passed");
	});

	it("reads a CDATA failure body", () => {
		const xml = `<testsuite name="cdata">
  <testcase classname="s" name="cdata failure">
    <failure message="short"><![CDATA[full
multiline
stack trace]]></failure>
  </testcase>
</testsuite>`;
		const [suite] = parseJUnitXml(xml);
		const tc = suite.testcases[0];
		expect(tc.status).toBe("failed");
		expect(tc.failureMessage).toContain("short");
		expect(tc.failureMessage).toContain("multiline");
	});

	it("walks nested <testsuite> children", () => {
		const xml = `<testsuites>
  <testsuite name="outer">
    <testsuite name="inner">
      <testcase classname="c" name="deep"/>
    </testsuite>
  </testsuite>
</testsuites>`;
		const suites = parseJUnitXml(xml);
		// Only the nested suite carries a testcase, so exactly one suite is emitted.
		expect(suites).toHaveLength(1);
		expect(suites[0].name).toBe("inner");
		expect(suites[0].testcases[0].name).toBe("deep");
	});

	it("keeps a numeric-looking classname as a string (no coercion)", () => {
		const xml = `<testsuite name="s">
  <testcase classname="123" name="numberish"/>
</testsuite>`;
		const [suite] = parseJUnitXml(xml);
		expect(suite.testcases[0].classname).toBe("123");
	});

	it("returns [] for malformed or empty input instead of throwing", () => {
		expect(parseJUnitXml("")).toEqual([]);
		expect(parseJUnitXml("<not-junit><oops></oops></not-junit>")).toEqual(
			[],
		);
	});

	// A JUnit report is an untrusted archive entry — anyone who can open a PR on
	// a connected repository controls its bytes. These two assert the ceilings
	// the parser is configured with, so a dependency bump that relaxes the
	// library's own defaults cannot quietly remove the protection.
	it("refuses a billion-laughs payload instead of expanding it", () => {
		const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuite [
  <!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
  <!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">
  <!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">
]>
<testsuite name="s" tests="1">
  <testcase name="boom" classname="c">&f;</testcase>
</testsuite>`;

		// The contract is "does not hand back a multi-megabyte expansion and
		// does not hang", not a specific error — the parser is wrapped in a
		// try/catch that answers [] on any throw.
		const started = Date.now();
		const suites = parseJUnitXml(xml);
		expect(Date.now() - started).toBeLessThan(5_000);

		const expanded = JSON.stringify(suites);
		expect(expanded.length).toBeLessThan(200_000);
	});

	it("does not resolve an external entity", () => {
		const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuite [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<testsuite name="s" tests="1">
  <testcase name="leak" classname="c">&xxe;</testcase>
</testsuite>`;

		const suites = parseJUnitXml(xml);
		expect(JSON.stringify(suites)).not.toContain("root:");
	});
});
