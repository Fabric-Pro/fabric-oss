/**
 * The security boundaries a pull-request proposal keeps (Fizzy #2563 spec
 * §13), pinned at the API-key surface every non-browser proposer goes
 * through: REST v1, which the CLI and the SDK call.
 *
 * What runs for real: the v1 routes, the real `requireScope` middleware (the
 * instruction scopes have no owner gate, so it is exactly the scope check),
 * `submitInstructionChange`, the admission every "Suggest a change" surface
 * shares and both authorization modules. What is mocked is the same boundary
 * `submit-change-authorization.test.ts` and `modules/v1/__tests__/
 * instructions.test.ts` mock: the database reads and writes, the live
 * permission resolver (the one call every check above makes), storage, audit,
 * the finalizer and the pull-request service. So each refusal below is the
 * one that ships, reached the way a key reaches it.
 *
 * The temporal and integrations halves of §13 (a row whose integration moved,
 * revocation before the push, the opt-in turned off before the push, tokens
 * in argv, results and audit metadata, the ref namespace) live in the
 * activity, adapter and git-plumbing suites, which own that code.
 */

import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getInstructionRepositorySyncForProposal: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getInstructionSnapshotWithPublishedPointer: vi.fn(),
	createDerivedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	claimInstructionFileStagingKey: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	findOrganization: vi.fn(),
	findUser: vi.fn(),
	findProject: vi.fn(),
	uploadFile: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	finalizeInstructionSnapshot: vi.fn(),
	getProposalPullRequestStatus: vi.fn(),
	startAdmittedProposalPullRequest: vi.fn(),
	readProposalPullRequest: vi.fn(),
	buildInstructionSnapshotZip: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			organization: { findFirst: m.findOrganization },
			user: { findUnique: m.findUser },
			project: { findFirst: m.findProject },
		},
		getProjectInstructionSettings: m.getProjectInstructionSettings,
		getInstructionRepositorySyncForProposal:
			m.getInstructionRepositorySyncForProposal,
		getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
		getInstructionSnapshot: m.getInstructionSnapshot,
		getInstructionSnapshotWithPublishedPointer:
			m.getInstructionSnapshotWithPublishedPointer,
		createDerivedInstructionSnapshot: m.createDerivedInstructionSnapshot,
		listInstructionFiles: m.listInstructionFiles,
		claimInstructionFileStagingKey: m.claimInstructionFileStagingKey,
		rejectAbandonedInstructionSnapshot:
			m.rejectAbandonedInstructionSnapshot,
	};
});
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ uploadFile: m.uploadFile }),
}));
vi.mock("../../../../../lib/audit", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		recordAuditFromRequest: m.recordAuditFromRequest,
	};
});
vi.mock("../finalize", () => ({
	finalizeInstructionSnapshot: m.finalizeInstructionSnapshot,
}));
vi.mock("../proposal-pull-request", () => ({
	getProposalPullRequestStatus: m.getProposalPullRequestStatus,
	startAdmittedProposalPullRequest: m.startAdmittedProposalPullRequest,
	readProposalPullRequest: m.readProposalPullRequest,
}));
vi.mock("../build-zip", () => ({
	buildInstructionSnapshotZip: m.buildInstructionSnapshotZip,
}));

const { registerInstructionRoutes } = await import(
	"../../../../v1/instructions"
);

const PROJECT = "proj_1";
const ORG = "org_1";
const OTHER_ORG = "org_2";
const CREATOR = "user_1";
const SNAPSHOT = "snap_3";
const CHANGES_PATH = `/projects/${PROJECT}/instructions/changes`;
const STATUS_PATH = `/projects/${PROJECT}/instructions/proposals/${SNAPSHOT}/pull-request`;
const SCOPE_WRITE = "instructions:write";
const SCOPE_READ = "instructions:read";

let apiContext: {
	keyType: "personal" | "organization";
	userId: string;
	organizationId?: string;
	scopes: string[];
};

/** An organization key minted by `CREATOR`, carrying `scopes`. */
function organizationKey(organizationId: string, scopes: string[]) {
	return {
		keyType: "organization" as const,
		userId: CREATOR,
		organizationId,
		scopes,
	};
}

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", apiContext);
		await next();
	});
	registerInstructionRoutes(
		app as unknown as Parameters<typeof registerInstructionRoutes>[0],
	);
	return app;
}

function proposeChange() {
	return buildApp().request(
		new Request(`http://localhost${CHANGES_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				baseSnapshotId: "snap_base",
				changes: [{ op: "put", path: "AGENTS.md", content: "# New\n" }],
			}),
		}),
	);
}

function readStatus() {
	return buildApp().request(new Request(`http://localhost${STATUS_PATH}`));
}

/** The creator's live access to the project, as the resolver returns it. */
function access(permissions: readonly string[]) {
	return { source: "org", organizationId: ORG, permissions };
}
const READER = [Permissions.INSTRUCTION_READ];
const EDITOR = [Permissions.INSTRUCTION_READ, Permissions.INSTRUCTION_CREATE];

/** A repository-backed project's sync row, read-only proposals off. */
function syncRow(allowReaderProposals: boolean) {
	return {
		id: "sync_1",
		projectId: PROJECT,
		organizationId: ORG,
		userId: CREATOR,
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "instructions",
		automatic: false,
		generation: 4,
		automaticPausedReason: null,
		allowReaderProposals,
		repositoryIntegration: {
			id: "int_1",
			projectId: PROJECT,
			status: "ACTIVE",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/example-repo",
		},
	};
}

/** Nothing below this point may run once a refusal has been given. */
function expectNothingWritten() {
	expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	expect(m.claimInstructionFileStagingKey).not.toHaveBeenCalled();
	expect(m.uploadFile).not.toHaveBeenCalled();
	expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
	expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue(access(EDITOR));
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "REPOSITORY",
	});
	m.getInstructionRepositorySyncForProposal.mockResolvedValue(syncRow(false));
	// No published base the sync accepts: a caller who gets PAST the
	// authority check meets `REPOSITORY_BASE_UNAVAILABLE` (412) and nothing
	// is written, so every control case below stops at a known place.
	m.getPublishedInstructionSnapshot.mockResolvedValue(null);
	m.findUser.mockResolvedValue({
		email: ["dev", "example.com"].join("@"),
		name: "Example Member",
	});
	m.getProposalPullRequestStatus.mockResolvedValue({ state: "OPEN" });
});

describe("tenant (spec §13)", () => {
	it("refuses a proposal whose project's hosting organization differs from the key's", async () => {
		apiContext = organizationKey(OTHER_ORG, [SCOPE_READ, SCOPE_WRITE]);

		const change = await proposeChange();
		const status = await readStatus();

		// Not found, in the words a missing project gets: an organization key
		// learns nothing about another tenant's project, not even that it
		// exists.
		expect(change.status).toBe(404);
		await expect(change.json()).resolves.toEqual({
			error: { message: "Project not found" },
		});
		expect(status.status).toBe(404);
		// Nothing reached the admission, the audit actor lookup or the
		// pull-request read: the tenant comes from the project, never from
		// the request, and a mismatch stops there.
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(
			m.getInstructionRepositorySyncForProposal,
		).not.toHaveBeenCalled();
		expect(m.findUser).not.toHaveBeenCalled();
		expect(m.getProposalPullRequestStatus).not.toHaveBeenCalled();
		expectNothingWritten();
	});
});

describe("delegation (spec §13, §16.1)", () => {
	it("refuses a reader without the opt-in at admission", async () => {
		apiContext = organizationKey(ORG, [SCOPE_WRITE]);
		m.resolveEffectiveProjectPermissions.mockResolvedValue(access(READER));

		const response = await proposeChange();

		// A reader passes the route's read gate and the inline entry point's
		// proposal gate; the admission is what refuses, because a proposal to
		// a repository pushes a branch there and that needs
		// INSTRUCTION_CREATE unless an owner opted readers in.
		expect(response.status).toBe(403);
		const body = (await response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toMatch(/pushes a branch to the repository/);
		expect(m.getInstructionRepositorySyncForProposal).toHaveBeenCalledWith(
			PROJECT,
			ORG,
		);
		// Refused before the base is read, so a caller without standing
		// learns nothing about the published snapshot, and before anything is
		// created.
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expectNothingWritten();

		// The opt-in is the only difference: the same reader with it on, and
		// an editor without it, both get past the authority check to the
		// base.
		for (const [permissions, allowReaders] of [
			[READER, true],
			[EDITOR, false],
		] as const) {
			m.resolveEffectiveProjectPermissions.mockResolvedValue(
				access(permissions),
			);
			m.getInstructionRepositorySyncForProposal.mockResolvedValue(
				syncRow(allowReaders),
			);
			const admitted = await proposeChange();
			expect(admitted.status).toBe(412);
			await expect(admitted.json()).resolves.toMatchObject({
				error: { code: "REPOSITORY_BASE_UNAVAILABLE" },
			});
		}
		expectNothingWritten();
	});
});

describe("API keys never grant more than the UI (spec §13)", () => {
	it("a wildcard key still needs the creator's live permission for changes and status", async () => {
		apiContext = organizationKey(ORG, ["*"]);

		// The creator lost read access: `*` passes every scope check and
		// still meets the live one, on both routes.
		m.resolveEffectiveProjectPermissions.mockResolvedValue(access([]));
		const lostChange = await proposeChange();
		const lostStatus = await readStatus();
		for (const response of [lostChange, lostStatus]) {
			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toEqual({
				error: {
					message:
						"No coding-instructions read permission for this project",
				},
			});
		}
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.getProposalPullRequestStatus).not.toHaveBeenCalled();
		expectNothingWritten();

		// A creator who can only read: `*` includes `instructions:write`,
		// and the repository proposal is still refused, because the tab
		// would refuse the same person the same proposal.
		m.resolveEffectiveProjectPermissions.mockResolvedValue(access(READER));
		const readerChange = await proposeChange();
		expect(readerChange.status).toBe(403);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expectNothingWritten();

		// Status is a read: it is answered, and as the creator, so the
		// service's own proposer-or-reviewer check runs for that person and
		// not for the key.
		const readerStatus = await readStatus();
		expect(readerStatus.status).toBe(200);
		expect(m.getProposalPullRequestStatus).toHaveBeenCalledWith({
			snapshotId: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
			userId: CREATOR,
		});
		// Every check above asked about the creator, never anyone else.
		for (const call of m.resolveEffectiveProjectPermissions.mock.calls) {
			expect(call).toEqual([PROJECT, CREATOR]);
		}
	});

	it("tells a scope refusal from a permission refusal", async () => {
		// A key without the scope, minted by someone who holds every
		// permission: the middleware's flat string, before the creator's
		// access is even resolved.
		apiContext = organizationKey(ORG, [SCOPE_READ]);
		const missingWrite = await proposeChange();
		expect(missingWrite.status).toBe(403);
		const scopeBody = (await missingWrite.json()) as { error: unknown };
		expect(scopeBody).toEqual({
			error: `Missing required scope: ${SCOPE_WRITE}`,
		});
		apiContext = organizationKey(ORG, []);
		const missingRead = await readStatus();
		expect(missingRead.status).toBe(403);
		await expect(missingRead.json()).resolves.toEqual({
			error: `Missing required scope: ${SCOPE_READ}`,
		});
		expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();

		// The scope is there and the person's permission is not: an object
		// with a message, from the route's gate and from the admission alike.
		apiContext = organizationKey(ORG, [SCOPE_READ, SCOPE_WRITE]);
		m.resolveEffectiveProjectPermissions.mockResolvedValue(access([]));
		const noRead = await proposeChange();
		const noReadStatus = await readStatus();
		m.resolveEffectiveProjectPermissions.mockResolvedValue(access(READER));
		const noCreate = await proposeChange();
		for (const response of [noRead, noReadStatus, noCreate]) {
			expect(response.status).toBe(403);
			const body = (await response.json()) as {
				error: { message?: unknown };
			};
			expect(typeof body.error).toBe("object");
			expect(typeof body.error.message).toBe("string");
			expect(body.error.message).not.toMatch(/scope/i);
		}
		expect(typeof scopeBody.error).toBe("string");
		expectNothingWritten();
	});
});
