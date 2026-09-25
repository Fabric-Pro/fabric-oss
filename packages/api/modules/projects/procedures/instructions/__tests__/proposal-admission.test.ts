/**
 * `admitInstructionProposal` — the one admission every "Suggest a change"
 * surface goes through (Fizzy #2563 spec §5.1): the tab's derive, and the
 * inline entry point behind REST v1, MCP and the CLI.
 *
 * What it decides, in order: the destination from the project's source of
 * truth; for a repository-backed project, that there is a sync row, an ACTIVE
 * integration on this project, a repository identity Fabric does not have to
 * invent, the proposer's authority (CREATE, or READ with the opt-in), and a
 * published base that is exactly the sync's; and last the note, rendered into
 * the frozen pull-request text.
 *
 * Mocked: the database reads, the live permission resolver and the mail
 * sender. Real: `parseRepoUrl`, `credentialFreeUrl`, the note schema, the
 * renderer and its secret scan — so every refusal here is the one that ships.
 */

import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectInstructionSettings: vi.fn(),
	getInstructionRepositorySyncForProposal: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	projectFindFirst: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	mailFrom: "",
	render: undefined as undefined | ((...a: unknown[]) => unknown),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			project: {
				findFirst: (...a: unknown[]) => m.projectFindFirst(...a),
			},
		},
		getProjectInstructionSettings: (...a: unknown[]) =>
			m.getProjectInstructionSettings(...a),
		getInstructionRepositorySyncForProposal: (...a: unknown[]) =>
			m.getInstructionRepositorySyncForProposal(...a),
		getPublishedInstructionSnapshot: (...a: unknown[]) =>
			m.getPublishedInstructionSnapshot(...a),
	};
});
vi.mock("@repo/config", () => ({
	config: {
		mails: {
			get from() {
				return m.mailFrom;
			},
		},
	},
}));
vi.mock("@repo/instructions", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		renderPullRequestText: (...a: unknown[]) => unknown;
	};
	return {
		...actual,
		renderPullRequestText: (...a: unknown[]) =>
			m.render ? m.render(...a) : actual.renderPullRequestText(...a),
	};
});
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));

import {
	admitInstructionProposal,
	frozenRootPath,
	uploadStartedAuditTemplate,
} from "../proposal-admission";

const PROJECT = "proj_1";
const ORG = "org_1";
const USER = "user_1";
const SHA = "a".repeat(40);
// Assembled at run time: no address- or token-shaped literal in the tree.
const NOREPLY = ["noreply", "example.com"].join("@");
const TOKEN = `${"gh"}${"p_"}${"A".repeat(36)}`;

function syncRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "sync_1",
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "instructions",
		automatic: false,
		generation: 4,
		automaticPausedReason: null,
		allowReaderProposals: false,
		repositoryIntegration: {
			id: "int_1",
			projectId: PROJECT,
			status: "ACTIVE",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/example-repo",
		},
		...overrides,
	};
}

function integration(overrides: Record<string, unknown>) {
	return {
		repositoryIntegration: {
			...syncRow().repositoryIntegration,
			...overrides,
		},
	};
}

function publishedBase(overrides: Record<string, unknown> = {}) {
	return {
		id: "snap_base",
		projectId: PROJECT,
		organizationId: ORG,
		version: 7,
		status: "READY",
		source: "REPOSITORY",
		sourceCommitSha: SHA,
		sourceRef: "main",
		repositoryIntegrationId: "int_1",
		settingsFrozen: {
			layer: "default",
			ignoreGlobs: [],
			rootPath: "instructions",
		},
		...overrides,
	};
}

function access(permissions: readonly string[], source = "org") {
	return { permissions, source, organizationId: ORG };
}

function admit(overrides: Record<string, unknown> = {}) {
	return admitInstructionProposal({
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		mode: "proposal",
		proposerName: "Pat Example",
		fileCount: 2,
		...overrides,
	} as Parameters<typeof admitInstructionProposal>[0]);
}

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error("expected a refusal");
		},
		(e: unknown) => e,
	);
	return error as {
		code: string;
		message: string;
		data?: Record<string, unknown>;
	};
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function" && "mockReset" in fn) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.mailFrom = `Fabric <${NOREPLY}>`;
	m.render = undefined;
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
	});
	m.getInstructionRepositorySyncForProposal.mockResolvedValue(syncRow());
	m.getPublishedInstructionSnapshot.mockResolvedValue(publishedBase());
	m.projectFindFirst.mockResolvedValue({ name: "Example Project" });
	m.resolveEffectiveProjectPermissions.mockResolvedValue(
		access([Permissions.INSTRUCTION_READ, Permissions.INSTRUCTION_CREATE]),
	);
});

describe("destination", () => {
	it("an upload-backed project is FABRIC, keeps its note and reads nothing about a repository", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
		});

		const admission = await admit({
			note: { title: "Tighten the review skill", body: "Why: flaky" },
		});

		expect(admission).toEqual({
			destination: "FABRIC",
			note: { title: "Tighten the review skill", body: "Why: flaky" },
		});
		expect(
			m.getInstructionRepositorySyncForProposal,
		).not.toHaveBeenCalled();
		expect(m.getProjectInstructionSettings).toHaveBeenCalledWith(
			PROJECT,
			ORG,
		);
	});

	it("an absent note is null, never an empty object", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: null,
		});

		expect(await admit()).toEqual({ destination: "FABRIC", note: null });
	});

	it.each(["publish", "direct"] as const)(
		"%s mode on a repository-backed project keeps REPOSITORY_SOURCE_OF_TRUTH",
		async (mode) => {
			const error = await refusal(admit({ mode }));

			expect(error).toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
			});
			expect(error.message).toContain("repository");
			expect(
				m.getInstructionRepositorySyncForProposal,
			).not.toHaveBeenCalled();
		},
	);

	it("a repository-backed project without a sync row is REPOSITORY_SOURCE_OF_TRUTH", async () => {
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(null);

		expect(await refusal(admit())).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
		});
		// Tenant-scoped read: the organization is part of the query itself.
		expect(m.getInstructionRepositorySyncForProposal).toHaveBeenCalledWith(
			PROJECT,
			ORG,
		);
	});
});

describe("repository", () => {
	it.each([
		["an inactive integration", integration({ status: "TOKEN_EXPIRED" })],
		["a disconnected integration", integration({ status: "DISCONNECTED" })],
		["another project's integration", integration({ projectId: "proj_2" })],
	])("%s is REPOSITORY_UNAVAILABLE", async (_label, overrides) => {
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow(overrides),
		);

		expect(await refusal(admit())).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REPOSITORY_UNAVAILABLE" },
		});
	});

	it("an Azure DevOps URL without a project is REPOSITORY_UNAVAILABLE with the reconnect copy", async () => {
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow(
				integration({
					provider: "AZURE_DEVOPS",
					repositoryUrl:
						"https://dev.azure.com/example-org/_git/example-repo",
				}),
			),
		);

		const error = await refusal(admit());

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REPOSITORY_UNAVAILABLE" },
		});
		expect(error.message).toBe(
			"Reconnect the repository with a URL that names its Azure DevOps project.",
		);
	});

	it("a URL whose provider disagrees with the integration's is REPOSITORY_UNAVAILABLE", async () => {
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow(integration({ provider: "GITLAB" })),
		);

		expect(await refusal(admit())).toMatchObject({
			data: { reason: "REPOSITORY_UNAVAILABLE" },
		});
	});

	it("normalises a URL carrying userinfo through credentialFreeUrl before parsing it", async () => {
		const secret = "s".repeat(12);
		const url = `https://${["user", secret].join(":")}@github.com/example-org/example-repo`;
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow(integration({ repositoryUrl: url })),
		);

		const admission = await admit();

		expect(admission).toMatchObject({
			destination: "REPOSITORY",
			context: {
				repository: {
					provider: "GITHUB",
					owner: "example-org",
					repo: "example-repo",
				},
			},
		});
		expect(JSON.stringify(admission)).not.toContain(secret);
	});

	it("keeps GitLab subgroups and decodes an Azure DevOps project with a space", async () => {
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow(
				integration({
					provider: "GITLAB",
					repositoryUrl:
						"https://gitlab.com/example-org/sub/example-repo",
				}),
			),
		);
		expect(await admit()).toMatchObject({
			context: {
				provider: "GITLAB",
				repository: {
					provider: "GITLAB",
					projectPath: "example-org/sub/example-repo",
				},
			},
		});

		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow(
				integration({
					provider: "AZURE_DEVOPS",
					repositoryUrl:
						"https://dev.azure.com/example-org/Example%20Project/_git/example-repo",
				}),
			),
		);
		expect(await admit()).toMatchObject({
			context: {
				provider: "AZURE_DEVOPS",
				repository: {
					provider: "AZURE_DEVOPS",
					apiOrigin: "https://dev.azure.com",
					organization: "example-org",
					project: "Example Project",
					repository: "example-repo",
				},
			},
		});
	});
});

describe("authority", () => {
	it("admits a member holding INSTRUCTION_CREATE by default", async () => {
		expect(await admit()).toMatchObject({ destination: "REPOSITORY" });
	});

	it("admits the project owner", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(
			access([], "owner"),
		);

		expect(await admit()).toMatchObject({ destination: "REPOSITORY" });
	});

	it("refuses a reader without the opt-in with FORBIDDEN", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(
			access([Permissions.INSTRUCTION_READ]),
		);

		expect(await refusal(admit())).toMatchObject({ code: "FORBIDDEN" });
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("admits a reader once allowReaderProposals is on", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(
			access([Permissions.INSTRUCTION_READ]),
		);
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow({ allowReaderProposals: true }),
		);

		expect(await admit()).toMatchObject({ destination: "REPOSITORY" });
	});

	it("refuses a caller with no access at all, opt-in or not", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(null);
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(
			syncRow({ allowReaderProposals: true }),
		);

		expect(await refusal(admit())).toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("base", () => {
	it("admits against an unchanged snapshot synced before this PR", async () => {
		// Its settingsFrozen.rootPath equals the sync root; no new sync needed.
		expect(await admit()).toMatchObject({
			destination: "REPOSITORY",
			context: { baseCommitSha: SHA, rootPath: "instructions" },
		});
	});

	it.each([
		["no published snapshot", null],
		["a base not from the repository", publishedBase({ source: "UPLOAD" })],
		["a base without a commit", publishedBase({ sourceCommitSha: null })],
		[
			"a base from another integration",
			publishedBase({ repositoryIntegrationId: "int_2" }),
		],
		["a base from another ref", publishedBase({ sourceRef: "develop" })],
		[
			"a base in another organization",
			publishedBase({ organizationId: "org_2" }),
		],
	])("%s is REPOSITORY_BASE_UNAVAILABLE", async (_label, base) => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(base);

		const error = await refusal(admit());

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REPOSITORY_BASE_UNAVAILABLE" },
		});
		expect(error.message).toBe(
			"Sync the repository before proposing a change.",
		);
	});

	it("refuses a base whose settingsFrozen.rootPath differs from the sync root", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(
			publishedBase({
				settingsFrozen: { layer: "default", rootPath: "docs/agents" },
			}),
		);

		expect(await refusal(admit())).toMatchObject({
			data: { reason: "REPOSITORY_BASE_UNAVAILABLE" },
		});
	});

	it.each([
		["no rootPath", { layer: "default" }],
		["a non-string rootPath", { rootPath: 7 }],
		["no settingsFrozen", null],
		["a non-object settingsFrozen", "instructions"],
	])("refuses a base whose settingsFrozen has %s", async (_label, frozen) => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(
			publishedBase({ settingsFrozen: frozen }),
		);

		expect(await refusal(admit())).toMatchObject({
			data: { reason: "REPOSITORY_BASE_UNAVAILABLE" },
		});
	});

	it("reads a root path only from a string on an object", () => {
		expect(frozenRootPath({ rootPath: "" })).toBe("");
		expect(frozenRootPath({ rootPath: "a/b" })).toBe("a/b");
		expect(frozenRootPath({ rootPath: null })).toBeNull();
		expect(frozenRootPath(["a"])).toBeNull();
		expect(frozenRootPath(undefined)).toBeNull();
	});
});

describe("the frozen destination", () => {
	it("freezes the current generation, the sync's identity and the attempt-1 branch", async () => {
		const admission = await admit({
			note: { title: "Tighten the review skill", body: "Why: flaky" },
		});
		if (admission.destination !== "REPOSITORY") {
			throw new Error("expected a REPOSITORY admission");
		}

		expect(admission.operationId).toMatch(/^[a-z][a-z0-9]{23}$/);
		expect(admission.syncId).toBe("sync_1");
		expect(admission.syncGeneration).toBe(4);
		expect(admission.blocked).toBeUndefined();
		expect(admission.note).toEqual({
			title: "Tighten the review skill",
			body: "Why: flaky",
		});
		expect(admission.context).toMatchObject({
			v: 1,
			integrationId: "int_1",
			syncId: "sync_1",
			syncGeneration: 4,
			provider: "GITHUB",
			targetRef: "main",
			rootPath: "instructions",
			baseCommitSha: SHA,
			branch: `fabric/instructions/${admission.operationId}`,
			author: { name: "Pat Example", email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
			title: "Tighten the review skill",
			message: "Tighten the review skill\n\nWhy: flaky",
		});
		expect(admission.context.body).toContain(
			"Opened from Fabric project Example Project by Pat Example",
		);
		expect(admission.context.committedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
		);
		// The project name is read in the project's own organization.
		expect(m.projectFindFirst).toHaveBeenCalledWith({
			where: { id: PROJECT, organizationId: ORG },
			select: { name: true },
		});
	});

	it("titles a note-less proposal by its file count", async () => {
		const admission = await admit({ fileCount: 3 });

		expect(admission).toMatchObject({
			context: { title: "Update coding instructions (3 files)" },
		});
	});

	it("gives every admission its own operation id", async () => {
		const a = await admit();
		const b = await admit();

		expect(a).toMatchObject({ destination: "REPOSITORY" });
		expect((a as { operationId: string }).operationId).not.toBe(
			(b as { operationId: string }).operationId,
		);
	});
});

describe("the note", () => {
	it.each([
		["title", { title: "x".repeat(121) }, "x".repeat(121)],
		["title", { title: "one\ntwo" }, "one\ntwo"],
		["body", { body: "é".repeat(2049) }, "é".repeat(2049)],
	])(
		"a %s the schema refuses is NOTE_REJECTED naming only the field",
		async (field, note, text) => {
			const error = await refusal(admit({ note }));

			expect(error).toMatchObject({
				code: "UNPROCESSABLE_CONTENT",
				data: { reason: "NOTE_REJECTED", field },
			});
			expect(error.message).not.toContain(text);
			expect(JSON.stringify(error.data)).not.toContain(text);
		},
	);

	it("a note that is not an object is NOTE_REJECTED on the note itself", async () => {
		expect(await refusal(admit({ note: "a title" }))).toMatchObject({
			code: "UNPROCESSABLE_CONTENT",
			data: { reason: "NOTE_REJECTED", field: "note" },
		});
	});

	it("refuses a bad note on an upload-backed proposal as well", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
		});

		expect(
			await refusal(admit({ note: { title: "x".repeat(121) } })),
		).toMatchObject({ data: { reason: "NOTE_REJECTED", field: "title" } });
	});

	it("does not read a note outside proposal mode", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
		});

		expect(
			await admit({ mode: "publish", note: { title: "x".repeat(121) } }),
		).toEqual({ destination: "FABRIC", note: null });
	});

	it.each(["title", "body"] as const)(
		"a token in the note's %s is NOTE_REJECTED and names only the field",
		async (field) => {
			const error = await refusal(
				admit({ note: { [field]: `Pat ${TOKEN}` } }),
			);

			expect(error).toMatchObject({
				code: "UNPROCESSABLE_CONTENT",
				data: { reason: "NOTE_REJECTED", field },
			});
			expect(error.message).not.toContain(TOKEN);
		},
	);
});

describe("attribution", () => {
	it("an unsafe project name admits BLOCKED ATTRIBUTION_REJECTED rather than refusing", async () => {
		m.projectFindFirst.mockResolvedValue({ name: "Unsafe project" });
		m.render = (input: unknown) =>
			(input as { projectName: string }).projectName === "Unsafe project"
				? { ok: false, code: "ATTRIBUTION_REJECTED" }
				: { ok: false, code: "NOTE_REJECTED", field: "title" };

		const admission = await admit();

		expect(admission).toMatchObject({
			destination: "REPOSITORY",
			blocked: {
				phase: "admission",
				code: "ATTRIBUTION_REJECTED",
				retryable: false,
				params: {},
			},
		});
		const blocked = (admission as { blocked: { at: string } }).blocked;
		expect(Number.isNaN(Date.parse(blocked.at))).toBe(false);
	});

	it("a sender without a usable mail domain admits BLOCKED ATTRIBUTION_REJECTED", async () => {
		m.mailFrom = "Fabric";

		const admission = await admit();

		expect(admission).toMatchObject({
			destination: "REPOSITORY",
			blocked: { code: "ATTRIBUTION_REJECTED" },
		});
		// Nothing about the refused attribution is frozen as if it were usable.
		expect(
			(admission as { context: { title: string } }).context.title,
		).toBe("");
	});

	it("an address-shaped proposer name falls back rather than reaching the author", async () => {
		const admission = await admit({
			proposerName: ["pat", "example.com"].join("@"),
		});

		expect(admission).toMatchObject({
			context: { author: { name: "a Fabric user" } },
		});
		expect(admission).not.toHaveProperty("blocked");
	});
});

describe("uploadStartedAuditTemplate", () => {
	it("carries the request's actor and IP and the caller-known metadata", () => {
		const headers = new Headers({
			"x-forwarded-for": "203.0.113.7",
			"user-agent": "vitest",
		});
		const template = uploadStartedAuditTemplate(
			{
				headers,
				user: { id: USER, email: NOREPLY, name: "Pat Example" },
				session: { id: "sess_1", impersonatedBy: null },
			},
			{
				organizationId: ORG,
				projectId: PROJECT,
				baseSnapshotId: "snap_base",
				baseVersion: 7,
				putCount: 1,
				deleteCount: 2,
				via: "mcp-gateway",
			},
		);

		expect(template).toMatchObject({
			actor: {
				type: "user",
				userId: USER,
				emailSnapshot: NOREPLY,
				nameSnapshot: "Pat Example",
			},
			organizationId: ORG,
			projectId: PROJECT,
			userAgent: "vitest",
			sessionId: "sess_1",
			metadata: {
				mode: "proposal",
				baseSnapshotId: "snap_base",
				baseVersion: 7,
				putCount: 1,
				deleteCount: 2,
				via: "mcp-gateway",
			},
		});
		expect(template).toHaveProperty("ipAddress");
		// The id and version exist only inside the create transaction.
		expect(template).not.toHaveProperty("resource");
	});
});
