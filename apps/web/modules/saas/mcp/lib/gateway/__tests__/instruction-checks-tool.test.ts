/**
 * `fabric_instruction_checks` — the server-side half of `fabric instructions
 * doctor`, returning the same report shape.
 *
 * The cases pin what the server may and may not claim: it reports the
 * credential, project access and the published version on its own authority;
 * it only COMPARES what the caller reports (a lock digest, the names of
 * variables that are set); and everything on the developer's machine comes
 * back `skip`. Arguments are validated in the handler, because the gateway
 * does not enforce a tool's `inputSchema`, and no refusal echoes the value it
 * refused — `presentVariables` is meant to carry names, and a caller that
 * sends `NAME=value` by mistake must not see the value copied back.
 *
 * `@repo/database`, `@repo/storage` and `@repo/config` are mocked — the
 * handler reaches them through dynamic `await import(...)`, so the mock
 * intercepts inside the handler body.
 *
 * Run with: pnpm --filter @repo/web exec vitest run modules/saas/mcp/lib/gateway/__tests__/instruction-checks-tool.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	resolveInstructionSnapshotSource: vi.fn(),
	resolveCurrentInstructionRepository: vi.fn(),
	downloadFile: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: m.getProjectAccessContext,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	getInstructionFileByPath: m.getInstructionFileByPath,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	resolveInstructionSnapshotSource: m.resolveInstructionSnapshotSource,
	resolveCurrentInstructionRepository: m.resolveCurrentInstructionRepository,
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.downloadFile }),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

import {
	CHECK_IDS,
	INSTRUCTION_ENVIRONMENT_FILE,
	INSTRUCTION_ENVIRONMENT_MAX_BYTES,
	type InstructionCheck,
	type InstructionChecksReport,
} from "../instruction-checks";
import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
	TOOL_SCOPES,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const TOOL = "fabric_instruction_checks";
const PROJECT = "proj_1";
const DIGEST =
	"ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org_1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["instructions:read"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

function text(result: { content: Array<{ text: string }> }): string {
	return result.content[0]?.text ?? "";
}

/**
 * Parses a report, and holds every report to one rule on the way: a `fail`
 * always tells the reader what to do next.
 */
function reportOf(result: {
	content: Array<{ text: string }>;
	isError?: boolean;
}): InstructionChecksReport {
	expect(result.isError).toBeUndefined();
	const report = JSON.parse(text(result)) as InstructionChecksReport;
	for (const c of report.checks.filter((c) => c.status === "fail")) {
		expect(c.fix?.description, `${c.id} fails without a fix`).toMatch(/\S/);
	}
	return report;
}

/** The content-free fix every exception boundary attaches. */
const RERUN_FIX = {
	description:
		"rerun the check; if it keeps failing, report the failure class shown",
};

function check(
	report: InstructionChecksReport,
	id: InstructionCheck["id"],
): InstructionCheck {
	const found = report.checks.find((c) => c.id === id);
	if (!found) {
		throw new Error(`no ${id} check`);
	}
	return found;
}

function publishedSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		id: "snap_1",
		version: 4,
		status: "READY",
		digest: DIGEST,
		fileCount: 3,
		projectId: PROJECT,
		organizationId: "org_1",
		...overrides,
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The immutable file record; its size and digest describe what was published. */
function declarationRow(size: number, sha256 = "0".repeat(64)) {
	return {
		id: "file_1",
		path: INSTRUCTION_ENVIRONMENT_FILE,
		kind: "OTHER",
		name: INSTRUCTION_ENVIRONMENT_FILE,
		description: null,
		size,
		mimeType: "application/json",
		isText: true,
		sha256,
		storageKey: "projects/proj_1/instructions/snapshots/snap_1/key",
		mode: null,
		projectId: PROJECT,
	};
}

/** Publishes `body` as the project's declaration, record and bytes agreeing. */
function publishDeclaration(body: string | Buffer) {
	const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
	m.getInstructionFileByPath.mockResolvedValue(
		declarationRow(bytes.length, sha256Hex(bytes)),
	);
	m.downloadFile.mockResolvedValue({ data: bytes });
}

const DECLARATION = JSON.stringify({
	version: 1,
	variables: [
		{ name: "OPENAI_API_KEY", required: true },
		{ name: "SENTRY_DSN", required: false },
	],
	tools: [{ name: "pnpm", version: ">=11" }, { name: "gh" }],
});

function run(args: Record<string, unknown>, as: GatewaySession = session) {
	return executePlatformTool(TOOL, args, as);
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.getProjectAccessContext.mockResolvedValue({ organizationId: "org_1" });
	m.getPublishedInstructionSnapshot.mockResolvedValue(publishedSnapshot());
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: null,
	});
	m.getInstructionFileByPath.mockResolvedValue(null);
	// Fizzy #2709: every existing fixture here is an UPLOAD snapshot in a
	// project with no repository-sync configuration; the REPOSITORY-specific
	// tests override this explicitly.
	m.resolveInstructionSnapshotSource.mockResolvedValue({
		source: { kind: "UPLOAD" },
		repository: null,
	});
	// Fizzy #2709 review: a "nothing published" report also carries the
	// project's current repository-sync configuration.
	m.resolveCurrentInstructionRepository.mockResolvedValue(null);
});

describe("fabric_instruction_checks definition", () => {
	it("is defined as a read-only tool with projectId required", () => {
		const def = PLATFORM_TOOL_DEFINITIONS.find((t) => t.name === TOOL);
		expect(def).toBeDefined();
		expect(def?.annotations).toEqual({ readOnlyHint: true });
		expect(def?.inputSchema.required).toEqual(["projectId"]);
		const props = def?.inputSchema.properties as Record<string, unknown>;
		expect(Object.keys(props).sort()).toEqual([
			"lockDigest",
			"presentVariables",
			"projectId",
		]);
		// The description tells an agent the report is not authority.
		expect(def?.description).toMatch(/proposal, not authority/);
		expect(def?.description).toMatch(/never values/);
	});

	it("is gated on instructions:read as a read", () => {
		expect(TOOL_SCOPES[TOOL]).toEqual({
			scope: "instructions:read",
			kind: "read",
		});
	});

	it("is refused before any lookup to a key without an instructions or mcp scope", async () => {
		const r = await run(
			{ projectId: PROJECT },
			{ ...session, scopes: ["projects:read"] },
		);
		expect(r.isError).toBe(true);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});
});

describe("argument validation", () => {
	it.each([
		["a missing projectId", {}],
		["a non-string projectId", { projectId: 42 }],
		["an empty projectId", { projectId: "" }],
		["an oversized projectId", { projectId: "p".repeat(129) }],
	])("refuses %s before any lookup", async (_label, args) => {
		const r = await run(args);
		expect(r.isError).toBe(true);
		expect(JSON.parse(text(r)).error).toContain("projectId");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it.each([
		["a non-hex lockDigest", "not-a-digest-zz"],
		["an oversized lockDigest", "a".repeat(129)],
		["an empty lockDigest", ""],
		["a non-string lockDigest", 7],
		["a null lockDigest", null],
	])("refuses %s without echoing it", async (_label, lockDigest) => {
		const r = await run({ projectId: PROJECT, lockDigest });
		expect(r.isError).toBe(true);
		expect(JSON.parse(text(r)).error).toContain("lockDigest");
		if (typeof lockDigest === "string" && lockDigest.length > 0) {
			expect(text(r)).not.toContain(lockDigest);
		}
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses a presentVariables entry that carries a value, and does not echo it", async () => {
		const r = await run({
			projectId: PROJECT,
			presentVariables: ["PATH", "SECRET_TOKEN=hunter2-example"],
		});
		expect(r.isError).toBe(true);
		const body = text(r);
		expect(JSON.parse(body).error).toContain(
			"presentVariables[1] is not a variable name",
		);
		expect(body).not.toContain("hunter2-example");
		expect(body).not.toContain("SECRET_TOKEN");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses a 200-character name without echoing it", async () => {
		const long = `A${"B".repeat(199)}`;
		const r = await run({ projectId: PROJECT, presentVariables: [long] });
		expect(r.isError).toBe(true);
		expect(text(r)).not.toContain(long.slice(0, 40));
	});

	it("refuses a non-array presentVariables and a non-string entry", async () => {
		const notArray = await run({
			projectId: PROJECT,
			presentVariables: "FOO",
		});
		expect(notArray.isError).toBe(true);
		const notString = await run({
			projectId: PROJECT,
			presentVariables: ["FOO", 3],
		});
		expect(notString.isError).toBe(true);
		expect(JSON.parse(text(notString)).error).toContain(
			"presentVariables[1]",
		);
	});

	it("refuses a null presentVariables, which the schema does not allow", async () => {
		const r = await run({ projectId: PROJECT, presentVariables: null });
		expect(r.isError).toBe(true);
		expect(JSON.parse(text(r)).error).toBe(
			"presentVariables must be an array of environment variable names.",
		);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses more than 500 names", async () => {
		const r = await run({
			projectId: PROJECT,
			presentVariables: Array.from({ length: 501 }, (_, i) => `V_${i}`),
		});
		expect(r.isError).toBe(true);
		expect(JSON.parse(text(r)).error).toContain("more than 500");
	});
});

describe("report shape", () => {
	it("returns all nine checks in CHECK_IDS order with surface mcp", async () => {
		const report = reportOf(await run({ projectId: PROJECT }));
		expect(report.projectId).toBe(PROJECT);
		expect(report.surface).toBe("mcp");
		expect(report.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
	});

	it("reports the credential kind and the scope that satisfied the gate", async () => {
		const report = reportOf(await run({ projectId: PROJECT }));
		const auth = check(report, "auth");
		expect(auth.status).toBe("pass");
		expect(auth.evidence).toBe("server");
		expect(auth.detail).toBe(
			"organization API key holding instructions:read",
		);

		const browser = reportOf(
			await run(
				{ projectId: PROJECT },
				{ ...session, credential: "session", scopes: ["*"] },
			),
		);
		expect(check(browser, "auth").detail).toBe("browser session holding *");

		const coarse = reportOf(
			await run(
				{ projectId: PROJECT },
				{
					...session,
					credential: "personal-key",
					scopes: ["mcp:read"],
				},
			),
		);
		expect(check(coarse, "auth").detail).toBe(
			"personal API key holding mcp:read",
		);
	});

	it("marks access, published as server evidence and the machine checks as skip", async () => {
		const report = reportOf(await run({ projectId: PROJECT }));
		expect(check(report, "access")).toMatchObject({
			status: "pass",
			evidence: "server",
		});
		expect(check(report, "published")).toMatchObject({
			status: "pass",
			evidence: "server",
		});
		expect(check(report, "published").detail).toContain("version 4");
		for (const id of ["drift", "hook", "mcp-servers"] as const) {
			expect(check(report, id).status).toBe("skip");
			expect(check(report, id).detail).toBe(
				"local-only; run `fabric instructions doctor --project proj_1` on the machine",
			);
		}
	});

	it("is ok with skips and warnings, and not ok with a failure", async () => {
		const clean = reportOf(await run({ projectId: PROJECT }));
		expect(clean.summary.fail).toBe(0);
		expect(clean.ok).toBe(true);

		const failing = reportOf(
			await run({ projectId: PROJECT, lockDigest: "00ff" }),
		);
		expect(failing.summary.fail).toBe(1);
		expect(failing.ok).toBe(false);
		expect(
			failing.summary.pass +
				failing.summary.fail +
				failing.summary.warn +
				failing.summary.skip,
		).toBe(9);
	});
});

describe("access and publication", () => {
	it("reports a denied project as a failed access check and learns nothing more", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);
		const report = reportOf(
			await run({ projectId: "proj_other", lockDigest: DIGEST }),
		);
		expect(check(report, "access")).toMatchObject({
			status: "fail",
			detail: "Project not found or access denied",
		});
		for (const id of CHECK_IDS.filter(
			(id) => id !== "auth" && id !== "access",
		)) {
			expect(check(report, id).status).toBe("skip");
		}
		expect(report.ok).toBe(false);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.getInstructionFileByPath).not.toHaveBeenCalled();
	});

	it("refuses an organization key a project hosted by another organization", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_2",
		});
		const report = reportOf(await run({ projectId: PROJECT }));
		expect(check(report, "access").status).toBe("fail");
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("warns when nothing is published and skips what depends on it", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);
		const report = reportOf(
			await run({
				projectId: PROJECT,
				lockDigest: DIGEST,
				presentVariables: ["OPENAI_API_KEY"],
			}),
		);
		expect(check(report, "published")).toMatchObject({
			status: "warn",
			fix: {
				description:
					"publish a version from the project's Coding Instructions tab",
			},
			repository: null,
		});
		expect(check(report, "lock").status).toBe("skip");
		expect(check(report, "environment").status).toBe("skip");
		expect(check(report, "tools").status).toBe("skip");
		expect(report.ok).toBe(true);
		expect(m.getInstructionFileByPath).not.toHaveBeenCalled();
	});

	it("carries the project's current repository config in a 'nothing published' report (Fizzy #2709 review)", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);
		const repositoryConfig = {
			provider: "GITHUB",
			host: "github.com",
			path: "example-org/example-repo",
			ref: "main",
			rootPath: "",
			generation: 2,
		};
		m.resolveCurrentInstructionRepository.mockResolvedValue(
			repositoryConfig,
		);
		const report = reportOf(await run({ projectId: PROJECT }));
		expect(check(report, "published").repository).toEqual(repositoryConfig);
		expect(m.resolveCurrentInstructionRepository).toHaveBeenCalledWith(
			PROJECT,
			"org_1",
		);
	});

	it("fails the access check with the error class only when the lookup throws", async () => {
		class ExampleDatabaseError extends Error {
			override name = "ExampleDatabaseError";
		}
		m.getProjectAccessContext.mockRejectedValue(
			new ExampleDatabaseError(
				"connection to db.internal.example failed",
			),
		);
		const r = await run({ projectId: PROJECT });
		const report = reportOf(r);
		expect(check(report, "access")).toMatchObject({
			status: "fail",
			detail: "check could not run (ExampleDatabaseError)",
			fix: RERUN_FIX,
		});
		expect(text(r)).not.toContain("db.internal.example");
	});
});

describe("lock", () => {
	it("skips without a lockDigest", async () => {
		const lock = check(reportOf(await run({ projectId: PROJECT })), "lock");
		expect(lock.status).toBe("skip");
		expect(lock.detail).toBe(
			"pass lockDigest from .fabric/instructions.lock to compare",
		);
	});

	it("passes a matching digest as caller-reported, in either case", async () => {
		const lock = check(
			reportOf(
				await run({
					projectId: PROJECT,
					lockDigest: DIGEST.toUpperCase(),
				}),
			),
			"lock",
		);
		expect(lock).toMatchObject({
			status: "pass",
			evidence: "caller-reported",
		});
		expect(lock.detail).not.toMatch(/verified/i);
	});

	it("fails a different digest with the sync command as a proposal", async () => {
		const lock = check(
			reportOf(await run({ projectId: PROJECT, lockDigest: "00ff" })),
			"lock",
		);
		expect(lock).toMatchObject({
			status: "fail",
			evidence: "caller-reported",
		});
		expect(lock.fix?.command).toBe(
			"fabric instructions sync --project proj_1",
		);
		expect(lock.fix?.command).not.toContain("--apply");
	});

	it("fails with the error class and a generic fix when the settings lookup throws", async () => {
		m.getProjectInstructionSettings.mockRejectedValue(
			new RangeError("row for projects/secret-key unreadable"),
		);
		const r = await run({ projectId: PROJECT, lockDigest: DIGEST });
		expect(check(reportOf(r), "lock")).toEqual({
			id: "lock",
			title: expect.any(String),
			status: "fail",
			evidence: "server",
			detail: "check could not run (RangeError)",
			fix: RERUN_FIX,
		});
		expect(text(r)).not.toContain("secret-key");
	});

	it("skips for a repository-backed project, whatever digest is sent", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
		});
		const lock = check(
			reportOf(await run({ projectId: PROJECT, lockDigest: "00ff" })),
			"lock",
		);
		expect(lock.status).toBe("skip");
		expect(lock.detail).toBe(
			"repository-backed project: files and hooks are managed by git",
		);
		expect(m.getProjectInstructionSettings).toHaveBeenCalledWith(
			PROJECT,
			"org_1",
		);
	});
});

describe("environment declaration", () => {
	it("skips environment and tools when nothing is declared", async () => {
		const report = reportOf(await run({ projectId: PROJECT }));
		expect(check(report, "environment")).toMatchObject({
			status: "skip",
			detail: "no environment declaration (add fabric.environment.json to the instruction set)",
		});
		expect(check(report, "tools").status).toBe("skip");
		expect(m.getInstructionFileByPath).toHaveBeenCalledWith(
			"snap_1",
			"org_1",
			INSTRUCTION_ENVIRONMENT_FILE,
		);
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("fails a malformed declaration with the parser's content-free reason", async () => {
		publishDeclaration(
			'{"version":1,"variables":[{"name":"BAD NAME=leak"}]}',
		);
		const r = await run({ projectId: PROJECT });
		const report = reportOf(r);
		const env = check(report, "environment");
		expect(env.status).toBe("fail");
		expect(env.detail).toContain("variables[0].name");
		expect(text(r)).not.toContain("leak");
		expect(check(report, "tools")).toMatchObject({
			status: "skip",
			detail: "declaration unreadable",
		});
		expect(report.ok).toBe(false);
	});

	it("fails invalid JSON without quoting it", async () => {
		publishDeclaration("{ not json SECRET_MARKER");
		const r = await run({ projectId: PROJECT });
		expect(check(reportOf(r), "environment").detail).toContain(
			"not valid JSON",
		);
		expect(text(r)).not.toContain("SECRET_MARKER");
	});

	it("refuses an oversized declaration before downloading it", async () => {
		m.getInstructionFileByPath.mockResolvedValue(
			declarationRow(INSTRUCTION_ENVIRONMENT_MAX_BYTES + 1),
		);
		const env = check(
			reportOf(await run({ projectId: PROJECT })),
			"environment",
		);
		expect(env.status).toBe("fail");
		expect(env.detail).toContain("larger than");
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("fails with the error class only when storage throws", async () => {
		m.getInstructionFileByPath.mockResolvedValue(declarationRow(10));
		m.downloadFile.mockRejectedValue(
			new TypeError("fetch failed for bucket skills key projects/secret"),
		);
		const r = await run({ projectId: PROJECT });
		const report = reportOf(r);
		expect(check(report, "environment")).toMatchObject({
			status: "fail",
			detail: "check could not run (TypeError)",
			fix: RERUN_FIX,
		});
		expect(check(report, "tools").status).toBe("skip");
		expect(text(r)).not.toContain("projects/secret");
	});

	describe("integrity against the published file record", () => {
		const INTEGRITY = "published declaration failed integrity check";

		function expectIntegrityFailure(
			r: Awaited<ReturnType<typeof run>>,
		): void {
			const report = reportOf(r);
			const env = check(report, "environment");
			expect(env).toMatchObject({
				status: "fail",
				evidence: "server",
				detail: INTEGRITY,
			});
			expect(env.fix?.command).toBeUndefined();
			expect(env.fix?.description).toMatch(/rerun|publish/);
			expect(env.items).toBeUndefined();
			expect(check(report, "tools")).toMatchObject({
				status: "skip",
				detail: "declaration unreadable",
			});
			// Nothing of the served bytes reaches the report.
			expect(text(r)).not.toContain("OPENAI_API_KEY");
			expect(report.ok).toBe(false);
		}

		it("fails bytes of the recorded size whose digest differs", async () => {
			const published = Buffer.from(DECLARATION, "utf8");
			const served = Buffer.from(
				DECLARATION.replace("SENTRY_DSN", "SENTRY_DSX"),
				"utf8",
			);
			expect(served.length).toBe(published.length);
			m.getInstructionFileByPath.mockResolvedValue(
				declarationRow(published.length, sha256Hex(published)),
			);
			m.downloadFile.mockResolvedValue({ data: served });
			expectIntegrityFailure(
				await run({
					projectId: PROJECT,
					presentVariables: ["OPENAI_API_KEY", "SENTRY_DSN"],
				}),
			);
		});

		it("fails bytes whose length differs from the record, even with a matching digest", async () => {
			const served = Buffer.from(DECLARATION, "utf8");
			m.getInstructionFileByPath.mockResolvedValue(
				declarationRow(served.length + 1, sha256Hex(served)),
			);
			m.downloadFile.mockResolvedValue({ data: served });
			expectIntegrityFailure(await run({ projectId: PROJECT }));
		});

		it("fails a declaration that is not valid UTF-8 instead of decoding it lossily", async () => {
			// `{"version":1}` with a lone continuation byte inside the object.
			publishDeclaration(
				Buffer.concat([
					Buffer.from('{"version":1,', "utf8"),
					Buffer.from([0x80]),
					Buffer.from('"variables":[]}', "utf8"),
				]),
			);
			const report = reportOf(await run({ projectId: PROJECT }));
			const env = check(report, "environment");
			expect(env).toMatchObject({
				status: "fail",
				evidence: "server",
				detail: "the published declaration is unreadable: file is not valid UTF-8",
			});
			expect(env.fix?.description).toContain("publish a new version");
			expect(check(report, "tools").status).toBe("skip");
		});
	});

	it("lists every declared name as skip when presentVariables is not sent", async () => {
		publishDeclaration(DECLARATION);
		const env = check(
			reportOf(await run({ projectId: PROJECT })),
			"environment",
		);
		expect(env.status).toBe("skip");
		expect(env.evidence).toBe("server");
		expect(env.items).toEqual([
			{
				name: "OPENAI_API_KEY",
				status: "skip",
				detail: "required; pass presentVariables to evaluate",
			},
			{
				name: "SENTRY_DSN",
				status: "skip",
				detail: "optional; pass presentVariables to evaluate",
			},
		]);
	});

	it("fails when a required variable is not reported as set", async () => {
		publishDeclaration(DECLARATION);
		const report = reportOf(
			await run({ projectId: PROJECT, presentVariables: ["SENTRY_DSN"] }),
		);
		const env = check(report, "environment");
		expect(env).toMatchObject({
			status: "fail",
			evidence: "caller-reported",
		});
		expect(env.items).toEqual([
			{
				name: "OPENAI_API_KEY",
				status: "fail",
				detail: "missing (required)",
			},
			{ name: "SENTRY_DSN", status: "pass", detail: "present" },
		]);
		expect(env.fix?.command).toBeUndefined();
		expect(env.fix?.description).toContain("OPENAI_API_KEY");
		expect(env.detail).not.toMatch(/verified/i);
		expect(report.ok).toBe(false);
	});

	it("warns when only an optional variable is missing", async () => {
		publishDeclaration(DECLARATION);
		const report = reportOf(
			await run({
				projectId: PROJECT,
				presentVariables: ["OPENAI_API_KEY"],
			}),
		);
		const env = check(report, "environment");
		expect(env).toMatchObject({
			status: "warn",
			evidence: "caller-reported",
		});
		expect(env.fix?.description).toContain("SENTRY_DSN");
		expect(report.ok).toBe(true);
	});

	it("passes when every declared variable is reported, comparing names exactly", async () => {
		publishDeclaration(DECLARATION);
		const env = check(
			reportOf(
				await run({
					projectId: PROJECT,
					presentVariables: [
						"OPENAI_API_KEY",
						"SENTRY_DSN",
						"UNRELATED",
					],
				}),
			),
			"environment",
		);
		expect(env.status).toBe("pass");
		expect(env.evidence).toBe("caller-reported");
		expect(env.detail).not.toMatch(/verified/i);

		const wrongCase = check(
			reportOf(
				await run({
					projectId: PROJECT,
					presentVariables: ["openai_api_key", "SENTRY_DSN"],
				}),
			),
			"environment",
		);
		expect(wrongCase.status).toBe("fail");
	});

	it("lists declared tools as local-only skips with their declared versions", async () => {
		publishDeclaration(DECLARATION);
		const tools = check(
			reportOf(await run({ projectId: PROJECT })),
			"tools",
		);
		expect(tools.status).toBe("skip");
		expect(tools.detail).toBe(
			"local-only; run `fabric instructions doctor --project proj_1` on the machine",
		);
		expect(tools.items).toEqual([
			{
				name: "pnpm",
				status: "skip",
				detail: "declared >=11 (not verified)",
			},
			{
				name: "gh",
				status: "skip",
				detail: "declared; presence not checked from the server",
			},
		]);
	});

	it("reads the declaration of a repository-backed project from its published snapshot", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
		});
		publishDeclaration(DECLARATION);
		const report = reportOf(
			await run({
				projectId: PROJECT,
				presentVariables: ["OPENAI_API_KEY", "SENTRY_DSN"],
			}),
		);
		expect(check(report, "lock").status).toBe("skip");
		expect(check(report, "environment").status).toBe("pass");
	});
});
