import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, run } from "./osv-severity-gate.mjs";

// Shapes mirror real osv-scanner --format=json output against pnpm-lock.yaml.
const vuln = (id, severity) => ({
	id,
	database_specific: severity === undefined ? {} : { severity },
});

const report = (...pkgs) => ({
	results: [
		{
			source: { path: "/src/pnpm-lock.yaml", type: "lockfile" },
			packages: pkgs,
		},
	],
});

const pkg = (name, version, ...vulns) => ({
	package: { name, version, ecosystem: "npm" },
	vulnerabilities: vulns,
});

describe("evaluate", () => {
	// The step this gate replaced returned exit 0 unconditionally, because npm
	// retired the endpoint `pnpm audit` posted to and `--ignore-registry-errors`
	// swallowed the 410. Everything else here is detail; this is the property
	// that was actually missing.
	it("fails on a high advisory", () => {
		const r = evaluate(
			report(
				pkg("undici", "5.29.0", vuln("GHSA-vxpw-j846-p89q", "HIGH")),
			),
		);

		expect(r.shouldFail).toBe(true);
		expect(r.gated).toHaveLength(1);
	});

	it("fails on a critical advisory", () => {
		const r = evaluate(
			report(
				pkg("shell-quote", "1.7.2", vuln("GHSA-crit-0001", "CRITICAL")),
			),
		);

		expect(r.shouldFail).toBe(true);
	});

	// The real lockfile carries 17 low + 48 moderate. If those gated, the check
	// would be permanently red and would get switched off — which is how the
	// previous gate ended up neutered in the first place.
	it("does not fail on moderate or low advisories", () => {
		const r = evaluate(
			report(
				pkg("dompurify", "3.3.3", vuln("GHSA-mod-0001", "MODERATE")),
				pkg("qs", "6.13.0", vuln("GHSA-low-0001", "LOW")),
			),
		);

		expect(r.shouldFail).toBe(false);
		expect(r.gated).toHaveLength(0);
		// Still reported, just not gating.
		expect(r.counts).toEqual({ MODERATE: 1, LOW: 1 });
	});

	it("gates only the high+ findings in a mixed report", () => {
		const r = evaluate(
			report(
				pkg(
					"undici",
					"5.29.0",
					vuln("GHSA-h-1", "HIGH"),
					vuln("GHSA-h-2", "HIGH"),
				),
				pkg("qs", "6.13.0", vuln("GHSA-l-1", "LOW")),
			),
		);

		expect(r.shouldFail).toBe(true);
		expect(r.gated.map((f) => f.id)).toEqual(["GHSA-h-1", "GHSA-h-2"]);
		expect(r.counts).toEqual({ HIGH: 2, LOW: 1 });
	});

	it("passes a clean report", () => {
		expect(evaluate({ results: [] }).shouldFail).toBe(false);
		expect(evaluate({}).shouldFail).toBe(false);
	});

	it("treats a severity-less advisory as UNKNOWN and does not gate it", () => {
		const r = evaluate(report(pkg("x", "1.0.0", vuln("GHSA-none-0001"))));

		expect(r.counts).toEqual({ UNKNOWN: 1 });
		expect(r.shouldFail).toBe(false);
	});

	it("matches severity case-insensitively", () => {
		// osv.dev has emitted lower-case severities; a gate that missed a "high"
		// because of casing would look exactly like a clean run.
		expect(
			evaluate(report(pkg("x", "1.0.0", vuln("G-1", "high")))).shouldFail,
		).toBe(true);
	});

	it("names the offending package, version and advisory", () => {
		const r = evaluate(
			report(
				pkg("undici", "5.29.0", vuln("GHSA-vxpw-j846-p89q", "HIGH")),
			),
		);

		expect(r.lines.join("\n")).toContain(
			"**HIGH** undici@5.29.0 — GHSA-vxpw-j846-p89q",
		);
		expect(r.lines[0]).toBe(
			"### Dependency audit — 1 undismissed high+ advisory",
		);
	});

	it("pluralises the summary", () => {
		const r = evaluate(
			report(
				pkg(
					"undici",
					"5.29.0",
					vuln("G-1", "HIGH"),
					vuln("G-2", "HIGH"),
				),
			),
		);

		expect(r.lines[0]).toBe(
			"### Dependency audit — 2 undismissed high+ advisories",
		);
	});

	it("tolerates results with no packages and packages with no vulnerabilities", () => {
		const r = evaluate({
			results: [
				{ source: {} },
				{ packages: [{ package: { name: "x" } }] },
			],
		});

		expect(r.findings).toHaveLength(0);
		expect(r.shouldFail).toBe(false);
	});
});

describe("run", () => {
	const write = (name, contents) => {
		const path = join(mkdtempSync(join(tmpdir(), "osv-gate-")), name);
		writeFileSync(path, contents);
		return path;
	};

	it("exits 0 on a clean report", () => {
		expect(run(write("osv.json", JSON.stringify({ results: [] })))).toBe(0);
	});

	it("exits 1 on a high advisory", () => {
		const path = write(
			"osv.json",
			JSON.stringify(
				report(pkg("undici", "5.29.0", vuln("G-1", "HIGH"))),
			),
		);

		expect(run(path)).toBe(1);
	});

	// The scan step is `continue-on-error`, so a missing or truncated report
	// means the scan never produced a verdict. That must not read as "clean" —
	// this gate exists precisely because a check that cannot fail is worse than
	// no check at all.
	it("fails closed when the report is missing", () => {
		expect(() => run(join(tmpdir(), "does-not-exist-osv.json"))).toThrow();
	});

	it("fails closed when the report is not valid JSON", () => {
		expect(() =>
			run(write("osv.json", "<html>502 Bad Gateway</html>")),
		).toThrow();
	});

	it("fails closed when the report is empty", () => {
		expect(() => run(write("osv.json", ""))).toThrow();
	});
});
