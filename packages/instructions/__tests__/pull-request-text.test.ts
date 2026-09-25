import { afterEach, describe, expect, it, vi } from "vitest";
import { pullRequestContextSchema } from "../src/pull-request-context";
import { renderPullRequestText } from "../src/pull-request-text";
import * as secrets from "../src/secrets";

// The real scanner, wrapped so one case can simulate a rule no current
// pattern implements; every other case runs the real rules.
const scanner = vi.hoisted(() => ({
	real: null as null | typeof import("../src/secrets").scanTextForSecrets,
}));
vi.mock("../src/secrets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/secrets")>();
	scanner.real = actual.scanTextForSecrets;
	return { ...actual, scanTextForSecrets: vi.fn(actual.scanTextForSecrets) };
});
function realScan(text: string) {
	if (!scanner.real) {
		throw new Error("the secrets module was not loaded");
	}
	return scanner.real(text);
}

// Assembled at run time: no address- or token-shaped literal in the tree.
const NOREPLY = ["noreply", "example.com"].join("@");
const MAIL_FROM = `Fabric <${NOREPLY}>`;
const TOKEN = `${"gh"}${"p_"}${"A".repeat(36)}`;

function render(
	overrides: Partial<Parameters<typeof renderPullRequestText>[0]> = {},
) {
	return renderPullRequestText({
		note: {},
		proposerName: "Pat Example",
		projectName: "Example Project",
		fileCount: 3,
		mailFrom: MAIL_FROM,
		...overrides,
	});
}

function ok(result: ReturnType<typeof renderPullRequestText>) {
	if (!result.ok) {
		throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	}
	return result;
}

afterEach(() => {
	vi.mocked(secrets.scanTextForSecrets).mockImplementation(realScan);
});

describe("renderPullRequestText (spec §5.2)", () => {
	it("defaults the title to the file count", () => {
		const text = ok(render());
		expect(text.title).toBe("Update coding instructions (3 files)");
		expect(text.message).toBe("Update coding instructions (3 files)");
	});

	it("uses the note's title and body, and puts the footer under a rule", () => {
		const text = ok(
			render({
				note: { title: "Tighten reviews", body: "Why it helps" },
			}),
		);
		expect(text.title).toBe("Tighten reviews");
		expect(text.body).toBe(
			"Why it helps\n\n---\n\nOpened from Fabric project Example Project by Pat Example",
		);
		expect(text.message).toBe("Tighten reviews\n\nWhy it helps");
	});

	it("attributes the commit to the proposer at the deployment's noreply address", () => {
		const text = ok(render());
		expect(text.author).toEqual({ name: "Pat Example", email: NOREPLY });
		expect(text.committer).toEqual({ name: "Fabric", email: NOREPLY });
	});

	it("accepts a bare mail-from address", () => {
		expect(ok(render({ mailFrom: NOREPLY })).author.email).toBe(NOREPLY);
	});

	it.each([
		["no address", "Fabric"],
		["no domain", "Fabric <noreply@>"],
		["a single-label domain", ["noreply", "localhost"].join("@")],
		["a domain with a path", ["noreply", "example.com/x"].join("@")],
	])(
		"refuses to attribute with a mail-from of %s (Decision 10)",
		(_, mailFrom) => {
			expect(render({ mailFrom })).toEqual({
				ok: false,
				code: "ATTRIBUTION_REJECTED",
			});
		},
	);

	it.each([
		["an address", ["pat", "example.com"].join("@")],
		["a URL", "https://example.com/pat"],
		["a token-shaped run", `Pat ${TOKEN}`],
		["nothing", ""],
		["only controls and whitespace", " \u0000\u0007\t "],
	])("falls back when the proposer's name is %s", (_, proposerName) => {
		const text = ok(render({ proposerName }));
		expect(text.author.name).toBe("a Fabric user");
		expect(text.body).toContain("by a Fabric user");
		expect(text.body).not.toContain(TOKEN);
	});

	it.each([
		["an address", ["team", "example.com"].join("@")],
		["a URL", "https://example.com"],
		["a token-shaped run", TOKEN],
		["nothing", ""],
	])("falls back when the project's name is %s", (_, projectName) => {
		const text = ok(render({ projectName }));
		expect(text.body).toContain(
			"Opened from Fabric project a Fabric project by",
		);
	});

	it("normalises names: NFC, controls removed, trimmed, at most 100 code points", () => {
		const text = ok(
			render({
				proposerName: "  José\r\n Example\u0007 ",
				projectName: "\u{1F600}".repeat(150),
			}),
		);
		expect(text.author.name).toBe("José Example");
		expect(text.body).toContain(`project ${"\u{1F600}".repeat(100)} by`);
	});

	it.each([
		["title", { title: `Rotate ${TOKEN}` }],
		["body", { body: `See ${TOKEN}` }],
	] as const)(
		"refuses a token in the note's %s before anything is escaped",
		(field, note) => {
			expect(render({ note })).toEqual({
				ok: false,
				code: "NOTE_REJECTED",
				field,
			});
		},
	);

	it("scans the raw note, because escaping would split the pattern", () => {
		// Escaping turns the token's `_` into `\_`, which the rule no longer
		// matches; a scan after escaping would let it through.
		const escaped = TOKEN.replace(/_/g, "\\_");
		expect(realScan(TOKEN)).not.toEqual([]);
		expect(realScan(escaped)).toEqual([]);
		expect(render({ note: { body: TOKEN } })).toEqual({
			ok: false,
			code: "NOTE_REJECTED",
			field: "body",
		});
	});

	it("refuses to attribute when a hit survives the fallback outside the note", () => {
		// No current rule spans the footer's fixed text, so this simulates one
		// that does: each name alone is clean and is kept, the composed footer
		// is not, and the hit is not the note's.
		vi.mocked(secrets.scanTextForSecrets).mockImplementation((text) => [
			...realScan(text),
			...(text.includes("project Example Project by")
				? [{ rule: "simulated-composed-rule", line: 1 }]
				: []),
		]);
		expect(render({ note: { body: "Clean note" } })).toEqual({
			ok: false,
			code: "ATTRIBUTION_REJECTED",
		});
	});

	it.each(["\\", "`", "*", "_", "#", ">", "[", "]", "<", "|"])(
		"escapes %s in the title and body but not in the message",
		(ch) => {
			const text = ok(
				render({ note: { title: `a${ch}b`, body: `c${ch}d` } }),
			);
			expect(text.title).toBe(`a\\${ch}b`);
			expect(text.body.startsWith(`c\\${ch}d\n`)).toBe(true);
			expect(text.message).toBe(`a${ch}b\n\nc${ch}d`);
		},
	);

	it("escapes Markdown in the names inside the footer", () => {
		const text = ok(render({ projectName: "Example *Project*" }));
		expect(text.body).toContain("project Example \\*Project\\* by");
	});

	it("collapses leading whitespace so nothing renders as a code block", () => {
		const text = ok(
			render({ note: { title: "  Indented", body: "    code\n\tmore" } }),
		);
		expect(text.title).toBe("Indented");
		expect(text.body.startsWith("code\nmore\n")).toBe(true);
		expect(text.message).toBe("  Indented\n\n    code\n\tmore");
	});

	it("keeps the footer free of any URL or address", () => {
		const text = ok(render());
		const footer = text.body.split("\n").at(-1) ?? "";
		expect(footer).toBe(
			"Opened from Fabric project Example Project by Pat Example",
		);
		expect(footer).not.toMatch(/@|:\/\//);
	});
});

describe("pullRequestContextSchema (spec §5.2)", () => {
	const context = {
		v: 1,
		integrationId: "int_1",
		syncId: "sync_1",
		syncGeneration: 2,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: "",
		baseCommitSha: "a".repeat(40),
		repository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
		},
		branch: "fabric/instructions/cexample000000000000000a",
		author: { name: "Pat Example", email: NOREPLY },
		committer: { name: "Fabric", email: NOREPLY },
		title: "Update coding instructions (3 files)",
		body: "---\n\nOpened from Fabric project Example Project by Pat Example",
		message: "Update coding instructions (3 files)",
		committedAt: "2026-09-24T00:00:00Z",
	};

	it("accepts a frozen GitHub context", () => {
		expect(pullRequestContextSchema.parse(context)).toEqual(context);
	});

	it("keeps GitLab subgroups and Azure DevOps projects", () => {
		expect(
			pullRequestContextSchema.safeParse({
				...context,
				provider: "GITLAB",
				repository: {
					provider: "GITLAB",
					projectPath: "example-org/sub/example-repo",
				},
			}).success,
		).toBe(true);
		expect(
			pullRequestContextSchema.safeParse({
				...context,
				provider: "AZURE_DEVOPS",
				repository: {
					provider: "AZURE_DEVOPS",
					apiOrigin: "https://dev.azure.com",
					organization: "example-org",
					project: "Example Project",
					repository: "example-repo",
				},
			}).success,
		).toBe(true);
	});

	it.each([
		["a repository of another provider", { provider: "GITLAB" }],
		[
			"a fractional-second commit time",
			{ committedAt: "2026-09-24T00:00:00.123Z" },
		],
		["a non-UTC commit time", { committedAt: "2026-09-24T00:00:00+02:00" }],
		["an abbreviated base commit", { baseCommitSha: "a".repeat(12) }],
		["another version", { v: 2 }],
	])("refuses %s", (_, change) => {
		expect(
			pullRequestContextSchema.safeParse({ ...context, ...change })
				.success,
		).toBe(false);
	});

	it("refuses an Azure DevOps origin carrying a path or userinfo", () => {
		for (const apiOrigin of [
			"https://dev.azure.com/example-org",
			`https://${["user", "dev.azure.com"].join("@")}`,
			"http://dev.azure.com",
		]) {
			expect(
				pullRequestContextSchema.safeParse({
					...context,
					provider: "AZURE_DEVOPS",
					repository: {
						provider: "AZURE_DEVOPS",
						apiOrigin,
						organization: "example-org",
						project: "Example Project",
						repository: "example-repo",
					},
				}).success,
			).toBe(false);
		}
	});
});
