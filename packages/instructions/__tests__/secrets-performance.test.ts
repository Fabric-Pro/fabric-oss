import { describe, expect, it } from "vitest";
import { SECRET_RULES, scanTextForSecrets } from "../src/secrets";

const join = (...parts: string[]) => parts.join("");

/** The two expressions the credential-assignment matchers replaced, as the oracle. */
const ORACLE_GENERIC =
	/(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pat)\b\s*[:=]\s*["']?(?!\$|\$\{|<|\*\*\*|process\.env|os\.environ|\$\()[A-Za-z0-9_\-+/=]{24,}["']?\s*$/im;
const ORACLE_SHORT =
	/(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pat)\b\s*[:=]\s*["']?(?!\$|\$\{|<|\*\*\*|process\.env|os\.environ|\$\()(?=[A-Za-z0-9_\-+/=!@#%^&*.]*[0-9])[A-Za-z0-9_\-+/=!@#%^&*.]{8,}["']?\s*$/im;
const ORACLE_JWT =
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

const rule = (id: string) => {
	const found = SECRET_RULES.find((candidate) => candidate.id === id);
	if (!found) {
		throw new Error(`missing rule ${id}`);
	}
	return found;
};

function timed<T>(run: () => T): { result: T; elapsed: number } {
	const start = performance.now();
	const result = run();
	return { result, elapsed: performance.now() - start };
}

const BUDGET_MS = 250;

const ADVERSARIAL: ReadonlyArray<readonly [string, () => string]> = [
	["80k dots", () => ".".repeat(80_000)],
	["80k SVG path", () => `M${"1.5-2.25-3.1".repeat(6_700)}`],
	["token= repeated then a comment", () => `${"token=".repeat(16_700)} #`],
	[
		"password: repeated then a comment",
		() => `${"password: ".repeat(10_000)}#`,
	],
	["keyword then endless spaces", () => `token${" ".repeat(100_000)}#`],
	[
		"keyword, separator, endless spaces",
		() => `token =${" ".repeat(100_000)}#`,
	],
	["eyJ- repeated", () => "eyJ-".repeat(25_000)],
	[
		"eyJ-.eyJ- repeated",
		() => `${"eyJ-".repeat(12_500)}.eyJ${"-eyJ".repeat(12_500)}`,
	],
	["dotted eyJ chain", () => "a.eyJaaaaaaaaaa".repeat(7_000)],
	["ghp_ run then underscore", () => `ghp_${"A".repeat(90_000)}_`],
	["AIza dashes", () => `AIza${"-".repeat(90_000)}`],
	["AIza repeated", () => "AIza-".repeat(20_000)],
	["Bearer dashes", () => `Bearer ${"-".repeat(90_000)}`],
	["Bearer repeated", () => "Bearer ".repeat(14_000)],
	["sk- repeated", () => "sk-".repeat(30_000)],
	["xoxb- digits", () => `xoxb-${"1".repeat(90_000)}`],
	["Pwd= repeated", () => "Pwd=".repeat(20_000)],
	["ADO_PAT spaces", () => `ADO_PAT${" ".repeat(90_000)}x`],
	["BEGIN repeated", () => "-----BEGIN ".repeat(8_000)],
	["AKIA repeated", () => "AKIA".repeat(20_000)],
	[
		"5 MB mixed line",
		() => "token=abc.".repeat(200_000) + "M1.5-2.25-3.1".repeat(200_000),
	],
];

describe("secret scan on adversarial single lines", () => {
	it.each(ADVERSARIAL)("finishes %s within the budget", (_name, build) => {
		const line = build();

		const { result, elapsed } = timed(() => scanTextForSecrets(line));

		expect(elapsed).toBeLessThan(
			BUDGET_MS * (line.length > 1_000_000 ? 4 : 1),
		);
		expect(Array.isArray(result)).toBe(true);
	});

	it.each(SECRET_RULES.map((candidate) => [candidate.id] as const))(
		"rule %s is linear on every adversarial line",
		(id) => {
			const matcher = rule(id);
			for (const [name, build] of ADVERSARIAL) {
				const line = build();

				const { elapsed } = timed(() => matcher.matches(line));

				expect(elapsed, `${id} on ${name}`).toBeLessThan(
					BUDGET_MS * (line.length > 1_000_000 ? 4 : 1),
				);
			}
		},
	);

	it("still detects a credential at the end of a long line", () => {
		const value = join("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0");
		const line = `${"x".repeat(50_000)} api_key = ${value}`;

		const { result, elapsed } = timed(() =>
			scanTextForSecrets(line, { limit: 10 }),
		);

		expect(result.hits).toEqual([{ rule: "generic-assignment", line: 1 }]);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it("still detects a quoted credential at the end of a long line", () => {
		const value = join("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0");
		const line = `${"x".repeat(50_000)} token: "${value}"  `;

		expect(scanTextForSecrets(line)).toEqual([
			{ rule: "generic-assignment", line: 1 },
		]);
	});

	it("does not flag a credential in the middle of a long line", () => {
		const value = join("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0");
		const line = `api_key = ${value} ${"x".repeat(50_000)}`;

		expect(scanTextForSecrets(line)).toEqual([]);
	});

	it("detects a credential that ends a line terminated by a lone carriage return", () => {
		const value = join("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0");
		const text = `a: b\rapi_key = ${value}\rc: d`;

		expect(scanTextForSecrets(text)).toEqual([
			{ rule: "generic-assignment", line: 1 },
		]);
	});

	it("detects a JWT in a long line", () => {
		const jwt = [
			"eyJhbGciOiJIUzI1NiJ9",
			"eyJzdWIiOiIxMjM0In0",
			"abcdefghijklmnopqrstuvwxyz012345",
		].join(".");
		const line = `${"eyJ-".repeat(10_000)} ${jwt}`;

		expect(scanTextForSecrets(line)).toEqual([{ rule: "jwt", line: 1 }]);
	});
});

function createRandom(seed: number) {
	let state = seed;
	return (limit: number) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state % limit;
	};
}

const FRAGMENTS = [
	"token",
	"TOKEN",
	"Api_Key",
	"api-key",
	"apikey",
	"secret",
	"password",
	"passwd",
	"pat",
	"path",
	"x",
	"_",
	".",
	"-",
	":",
	"=",
	"==",
	" ",
	"  ",
	"\t",
	'"',
	"'",
	"\r",
	" ",
	" ",
	"$",
	"${",
	"$(",
	"<",
	"***",
	"process.env",
	"OS.ENVIRON",
	"abc",
	"abc123",
	"1",
	"9f8e7d6c5b4a39281706f5e4d3c2b1a0",
	"short1",
	"longvalue12345",
	"!@#",
	"K",
	"ſ",
];

const JWT_FRAGMENTS = [
	"eyJ",
	"eyJaaaaaaaa",
	"eyJaaaaaaaaaaaa",
	".",
	".eyJ",
	"-",
	"_",
	"aaaaaaaa",
	"aaa",
	" ",
	"!",
	"a.eyJaaaaaaaa.aaaaaaaa",
];

function randomLine(random: (n: number) => number, pool: readonly string[]) {
	const parts = random(9);
	let line = "";
	for (let i = 0; i < parts; i++) {
		line += pool[random(pool.length)];
	}
	return line;
}

describe("linear matchers agree with the regular expressions they replaced", () => {
	it("credential assignments agree on generated lines", () => {
		const random = createRandom(20260930);
		const generic = rule("generic-assignment");
		const short = rule("short-credential-assignment");
		const disagreements: string[] = [];
		let hits = 0;

		for (let i = 0; i < 150_000; i++) {
			const line = randomLine(random, FRAGMENTS);
			const expectedGeneric = ORACLE_GENERIC.test(line);
			const expectedShort = ORACLE_SHORT.test(line);
			hits += Number(expectedGeneric) + Number(expectedShort);
			if (generic.matches(line) !== expectedGeneric) {
				disagreements.push(`generic ${JSON.stringify(line)}`);
			}
			if (short.matches(line) !== expectedShort) {
				disagreements.push(`short ${JSON.stringify(line)}`);
			}
		}

		expect(hits).toBeGreaterThan(500);
		expect(disagreements.slice(0, 10)).toEqual([]);
	});

	it("JWTs agree on generated lines", () => {
		const random = createRandom(7);
		const jwt = rule("jwt");
		const disagreements: string[] = [];
		let hits = 0;

		for (let i = 0; i < 150_000; i++) {
			const line = randomLine(random, JWT_FRAGMENTS);
			const expected = ORACLE_JWT.test(line);
			hits += Number(expected);
			if (jwt.matches(line) !== expected) {
				disagreements.push(JSON.stringify(line));
			}
		}

		expect(hits).toBeGreaterThan(200);
		expect(disagreements.slice(0, 10)).toEqual([]);
	});
});
