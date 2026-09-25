/**
 * `submitInstructionChange` — the one server entry point behind
 * `fabric instructions push`, the v1 change route and the MCP proposal tool
 * (Fizzy #2539).
 *
 * Three surfaces share it, so what it refuses is what all three refuse, and
 * these are the properties that must hold whichever one is calling:
 *
 *  - the live permission check runs FIRST and asks for the right permission:
 *    `INSTRUCTION_READ` to propose, `INSTRUCTION_CREATE` to publish;
 *  - the organization is the PROJECT's, never the caller's and never anything
 *    from the request — there is no parameter for one;
 *  - the base is the published snapshot, read tenant-scoped, and a caller
 *    naming a different one is refused before a row is written;
 *  - `size` and `sha256` are computed here from the bytes, never taken from
 *    the caller;
 *  - the bytes land on the exact staging key the presigned browser flow would
 *    have used, and only after the same compare-and-set claim.
 *
 * `@repo/instructions` is NOT mocked: the real path validation, secret-filename
 * matcher, ignore matcher and classifier run, so the refusals under test are
 * the actual ones rather than stand-ins.
 */

import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	createDerivedInstructionSnapshot: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getInstructionSnapshotWithPublishedPointer: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	claimInstructionFileStagingKey: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	assertInstructionDeriveAccess: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	finalizeInstructionSnapshot: vi.fn(),
	uploadFile: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	admit: vi.fn(),
	startAdmittedProposalPullRequest: vi.fn(),
	readProposalPullRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createDerivedInstructionSnapshot: (...a: unknown[]) =>
		m.createDerivedInstructionSnapshot(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getInstructionSnapshotWithPublishedPointer: (...a: unknown[]) =>
		m.getInstructionSnapshotWithPublishedPointer(...a),
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
	claimInstructionFileStagingKey: (...a: unknown[]) =>
		m.claimInstructionFileStagingKey(...a),
	rejectAbandonedInstructionSnapshot: (...a: unknown[]) =>
		m.rejectAbandonedInstructionSnapshot(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ uploadFile: m.uploadFile }),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
	resolveActor: (context: { user?: { id: string } }) => ({
		type: "user",
		userId: context.user?.id ?? null,
	}),
	auditRequestFields: () => ({
		impersonatedById: null,
		ipAddress: null,
		userAgent: null,
		requestId: null,
		sessionId: null,
		correlationId: null,
	}),
}));
// Admission is its own suite (`proposal-admission.test.ts`); here it is the
// seam, and each test states the destination it decided.
vi.mock("../proposal-admission", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	admitInstructionProposal: (...a: unknown[]) => m.admit(...a),
}));
vi.mock("../proposal-pull-request", () => ({
	startAdmittedProposalPullRequest: (...a: unknown[]) =>
		m.startAdmittedProposalPullRequest(...a),
	readProposalPullRequest: (...a: unknown[]) =>
		m.readProposalPullRequest(...a),
}));
vi.mock("../proposal-authorization", () => ({
	assertInstructionDeriveAccess: (...a: unknown[]) =>
		m.assertInstructionDeriveAccess(...a),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));
// The workflow start is `finalize-snapshot.ts`'s own, tested there. What
// matters here is that it is reached, with this snapshot and this tenant.
vi.mock("../finalize", () => ({
	finalizeInstructionSnapshot: (...a: unknown[]) =>
		m.finalizeInstructionSnapshot(...a),
}));

// NOT mocked: the marker module has no imports of its own, and the brand it
// applies is the whole point — a test that fabricated a look-alike would be
// asserting against a check the production code does not make.
import { instructionWorkflowNotStarted } from "../instruction-workflow-start";
import { submitInstructionChange } from "../submit-change";

const PROJECT = "proj_1";
const ORG = "org_1";
const USER = "user_1";
const BASE_ID = "snap_base";
const audit = { user: { id: USER, email: "dev@example.com" } };

function published(overrides: Record<string, unknown> = {}) {
	return {
		id: BASE_ID,
		projectId: PROJECT,
		organizationId: ORG,
		status: "READY",
		version: 7,
		settingsFrozen: { layer: "default", ignoreGlobs: [] },
		...overrides,
	};
}

function created(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		id: "snap_new",
		version: 8,
		fileCount: 3,
		inheritedCount: 2,
		staged: [{ id: "file_1", path: "AGENTS.md" }],
		...overrides,
	};
}

function stagedRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "file_1",
		path: "AGENTS.md",
		storageKey: `projects/${PROJECT}/instructions/staging/pending/0`,
		mimeType: "text/markdown",
		size: 4,
		...overrides,
	};
}

function put(content: string, path = "AGENTS.md") {
	return { op: "put" as const, path, content };
}

function submit(overrides: Record<string, unknown> = {}) {
	return submitInstructionChange({
		userId: USER,
		projectId: PROJECT,
		// Required on every call. The suite passes it by default because
		// every test below is about something else; the tests that are about
		// IT override it.
		baseSnapshotId: BASE_ID,
		changes: [put("new\n")],
		// Required, and stated on every call. The mode tests override it.
		mode: "proposal",
		audit,
		via: "test",
		...overrides,
	} as Parameters<typeof submitInstructionChange>[0]);
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function" && "mockReset" in fn) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.requireHostingOrganizationId.mockResolvedValue(ORG);
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "UPLOAD",
	});
	// The tenant-scoped load of the BASE before anything is written. The
	// re-read of the new row after the finalizer is a SEPARATE function,
	// `getInstructionSnapshotWithPublishedPointer` below — the two used to
	// share this mock, keyed by id, until the final read was combined with
	// the pointer read into one Prisma call.
	m.getPublishedInstructionSnapshot.mockResolvedValue(published());
	m.getInstructionSnapshot.mockResolvedValue(published());
	// The final read: the new row plus the project's published pointer, from
	// one call. The pointer defaults to the unchanged base — "nothing has
	// published yet" — because that is the ordinary state for a row that just
	// started validating.
	m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
		snapshot: {
			id: "snap_new",
			version: 8,
			status: "VALIDATING",
			proposalStatus: "PENDING",
			baseVersion: 7,
			publishedAt: null,
		},
		publishedPointer: published(),
	});
	m.createDerivedInstructionSnapshot.mockResolvedValue(created());
	m.listInstructionFiles.mockResolvedValue([stagedRow()]);
	m.claimInstructionFileStagingKey.mockResolvedValue({ moved: true });
	m.finalizeInstructionSnapshot.mockResolvedValue({ status: "VALIDATING" });
	m.rejectAbandonedInstructionSnapshot.mockResolvedValue({ changed: true });
	m.admit.mockResolvedValue({ destination: "FABRIC", note: null });
	m.startAdmittedProposalPullRequest.mockResolvedValue(undefined);
	m.readProposalPullRequest.mockResolvedValue(null);
});

describe("authorization", () => {
	it("asks for the proposal permission in proposal mode, before reading anything", async () => {
		m.assertInstructionDeriveAccess.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "no" }),
		);

		await expect(submit()).rejects.toThrow("no");
		expect(m.assertInstructionDeriveAccess).toHaveBeenCalledWith({
			projectId: PROJECT,
			userId: USER,
			proposal: true,
		});
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	/**
	 * Proposal mode reaches the review-gated path and nothing else, whatever
	 * the caller's permissions are.
	 *
	 * The key minted for the surfaces that ask for this mode carries
	 * `instructions:write`, which the Connect dialog offers to read-only roles
	 * and describes as review-gated. What that key can do must not depend on
	 * who created it, which is why the mode — not the permission set — is what
	 * decides here, and why publishing is a second scope rather than a branch
	 * inside this one.
	 */
	it("only ever opens a proposal in proposal mode", async () => {
		await submit();

		expect(m.assertInstructionDeriveAccess).toHaveBeenCalledWith({
			projectId: PROJECT,
			userId: USER,
			proposal: true,
		});
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ proposal: true, publishOnReady: false }),
		);
	});

	/**
	 * Publish mode asks for the publishing permission and turns on the
	 * workflow's publish step — the same two flags the tab's direct save
	 * sends (`derive-snapshot.ts` with `proposal: false`).
	 */
	it("asks for the publishing permission in publish mode, before reading anything", async () => {
		m.assertInstructionDeriveAccess.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "no" }),
		);

		await expect(submit({ mode: "publish" })).rejects.toThrow("no");
		expect(m.assertInstructionDeriveAccess).toHaveBeenCalledWith({
			projectId: PROJECT,
			userId: USER,
			proposal: false,
		});
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("derives a self-publishing snapshot in publish mode", async () => {
		const result = await submit({ mode: "publish" });

		expect(result.mode).toBe("publish");
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ proposal: false, publishOnReady: true }),
		);
	});

	// Fail-closed: the comparison is against the publish literal, so an
	// absent or unrecognised mode lands on the REVIEWED path. A truthiness
	// test or a `!== "proposal"` would land it on the other one.
	it.each([[undefined], ["PUBLISH"], ["publish "], [1]])(
		"treats a mode of %j as a proposal",
		async (mode) => {
			const result = await submit({ mode });

			expect(result.mode).toBe("proposal");
			expect(m.assertInstructionDeriveAccess).toHaveBeenCalledWith(
				expect.objectContaining({ proposal: true }),
			);
			expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					proposal: true,
					publishOnReady: false,
				}),
			);
		},
	);

	it("acts in the project's hosting organization, resolved server-side", async () => {
		await submit();

		expect(m.requireHostingOrganizationId).toHaveBeenCalledWith(
			PROJECT,
			USER,
		);
		// Every tenant-scoped read and the snapshot write carry it.
		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			BASE_ID,
			PROJECT,
			ORG,
		);
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG, userId: USER }),
		);
	});

	// `getPublishedInstructionSnapshot` follows the pointer on the Project row
	// and is unscoped; the tenant-scoped re-read is what proves the row belongs
	// to the organization resolved above.
	it("refuses when the published pointer is not readable in this tenant", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);

		await expect(submit()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});
});

describe("preconditions", () => {
	it("passes admission's repository refusal through with a code the CLI can branch on", async () => {
		m.admit.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message:
					"This project's coding instructions come from its repository. Change the files there and sync the project.",
				data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
			}),
		);

		await expect(submit({ mode: "publish" })).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
		});
		expect(m.admit).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "publish" }),
		);
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a project with nothing published", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);

		await expect(submit()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "NOTHING_PUBLISHED" },
		});
		expect(m.getInstructionSnapshot).not.toHaveBeenCalled();
	});

	// The spec's PULL_FIRST rule (§6.12): a change set written against a
	// version that has since moved is refused, never rebased.
	it("refuses a base that is not the published version", async () => {
		await expect(
			submit({ baseSnapshotId: "snap_older" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "BASE_NOT_PUBLISHED" },
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("accepts a base that IS the published version", async () => {
		const result = await submit({ baseSnapshotId: BASE_ID });

		expect(result.baseSnapshotId).toBe(BASE_ID);
		expect(result.baseVersion).toBe(7);
		expect(result.proposalStatus).toBe("PENDING");
	});

	/**
	 * It used to be optional, defaulting to whatever was published now, which
	 * turned this check off for every caller that left it out. An agent that
	 * read v7 and sent its edit while a teammate published v8 had that edit
	 * rebased onto v8 in silence, reverting v8's changes to the files it
	 * touched — and nothing in the response said so. There is no safe
	 * default: only the caller knows which version it read.
	 */
	it("refuses a call that names no base at all", async () => {
		await expect(
			submit({ baseSnapshotId: undefined }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "BASE_NOT_PUBLISHED" },
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("refuses an empty change set", async () => {
		await expect(submit({ changes: [] })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("refuses more than 50 changes", async () => {
		const changes = Array.from({ length: 51 }, (_, i) =>
			put("x\n", `rules/${i}.md`),
		);

		await expect(submit({ changes })).rejects.toThrow(/Too many changes/);
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a change set over the inline byte cap", async () => {
		const changes = [
			put("a".repeat(1_100_000)),
			put("b".repeat(1_100_000), "OTHER.md"),
		];

		await expect(submit({ changes })).rejects.toThrow(/too large/i);
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	// The real `@repo/instructions` refusals, reached through the shared
	// validator: a credential-shaped name never gets as far as a row.
	it("refuses a credential-shaped filename", async () => {
		await expect(
			submit({ changes: [put("SECRET=1\n", ".env")] }),
		).rejects.toThrow(/never stores credential files/);
	});

	it("refuses a traversing path", async () => {
		await expect(
			submit({ changes: [put("x\n", "../escape.md")] }),
		).rejects.toThrow(/Path rejected/);
	});
});

describe("the bytes", () => {
	it("computes size and sha256 itself rather than taking them from the caller", async () => {
		await submit({
			changes: [
				{
					op: "put",
					path: "AGENTS.md",
					content: "new\n",
					// A caller-supplied hash and size, which must be ignored:
					// the server holds the bytes on this path.
					size: 999_999,
					sha256: "0".repeat(64),
				},
			],
		});

		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [
					expect.objectContaining({
						op: "put",
						path: "AGENTS.md",
						size: 4,
						sha256: createHash("sha256")
							.update(Buffer.from("new\n"))
							.digest("hex"),
					}),
				],
			}),
		);
	});

	it("decodes base64 content", async () => {
		const bytes = Buffer.from([0x00, 0xff, 0x41]);
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			created({ staged: [{ id: "file_1", path: "logo.png" }] }),
		);
		m.listInstructionFiles.mockResolvedValue([
			stagedRow({ path: "logo.png", mimeType: "image/png" }),
		]);

		await submit({
			changes: [
				{
					op: "put",
					path: "logo.png",
					content: bytes.toString("base64"),
					encoding: "base64",
				},
			],
		});

		expect(m.uploadFile).toHaveBeenCalledWith(
			expect.any(String),
			bytes,
			expect.objectContaining({ contentType: "image/png" }),
		);
	});

	// `Buffer.from(_, "base64")` drops anything outside the alphabet in
	// silence, so without the round-trip check a mangled payload would be
	// stored as whatever survived.
	it("refuses content that is not valid base64", async () => {
		await expect(
			submit({
				changes: [
					{
						op: "put",
						path: "logo.png",
						content: "not base64 !!!",
						encoding: "base64",
					},
				],
			}),
		).rejects.toThrow(/not valid base64/);
	});

	it("writes each staged file to the key the presigned flow would have used", async () => {
		await submit();

		const key = `projects/${PROJECT}/instructions/staging/snap_new/file_1`;
		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledWith({
			fileId: "file_1",
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			from: `projects/${PROJECT}/instructions/staging/pending/0`,
			to: key,
		});
		expect(m.uploadFile).toHaveBeenCalledWith(
			key,
			Buffer.from("new\n"),
			expect.objectContaining({ contentType: "text/markdown" }),
		);
	});

	// A row whose key is already the snapshot's own immutable one has been
	// promoted; pointing it back at writable storage is the thing the
	// compare-and-set exists to prevent.
	it("refuses to write over a row that is no longer in staging", async () => {
		m.listInstructionFiles.mockResolvedValue([
			stagedRow({
				storageKey: `projects/${PROJECT}/instructions/snapshots/snap_new/file_1`,
			}),
		]);

		await expect(submit()).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("refuses when the staging claim loses its race", async () => {
		m.claimInstructionFileStagingKey.mockResolvedValue({ moved: false });

		await expect(submit()).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	// The caller's spelling is normalised by `validateRelativePath`, and the
	// file rows carry the normalised one; pairing content to rows by the raw
	// string would lose the file.
	it("matches content to rows by the stored path, not the caller's spelling", async () => {
		await submit({ changes: [put("new\n", "./AGENTS.md")] });

		expect(m.uploadFile).toHaveBeenCalledWith(
			expect.any(String),
			Buffer.from("new\n"),
			expect.anything(),
		);
	});
});

describe("the rest of the pipeline", () => {
	it("starts the same validation workflow the browser finalize starts", async () => {
		const result = await submit();

		expect(m.finalizeInstructionSnapshot).toHaveBeenCalledWith({
			snapshot: { id: "snap_new", status: "RECEIVING" },
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
		});
		expect(result.status).toBe("VALIDATING");
		expect(result.proposalStatus).toBe("PENDING");
		expect(result.version).toBe(8);
	});

	it("records the same audit action an upload records, with the surface on it", async () => {
		await submit({ via: "mcp-gateway" });

		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			audit,
			expect.objectContaining({
				action: "project.instructions.upload_started",
				organizationId: ORG,
				projectId: PROJECT,
				metadata: expect.objectContaining({
					mode: "proposal",
					via: "mcp-gateway",
					baseSnapshotId: BASE_ID,
					baseVersion: 7,
					putCount: 1,
					deleteCount: 0,
				}),
			}),
		);
	});

	/**
	 * A direct publish records what the TAB's direct save records.
	 *
	 * `derive-snapshot.ts` writes `mode: "derived"` for a snapshot that is not
	 * a proposal, so an audit reader filtering for direct versions has to find
	 * the ones made from here too; `via` is what separates the surfaces. The
	 * publish itself is a second row, `project.instructions.published`, written
	 * by the workflow activity that moves the pointer — the same activity the
	 * tab's publish goes through.
	 */
	it("records a publish the way the tab's direct save does", async () => {
		await submit({ mode: "publish", via: "v1:organization-key" });

		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			audit,
			expect.objectContaining({
				action: "project.instructions.upload_started",
				organizationId: ORG,
				projectId: PROJECT,
				metadata: expect.objectContaining({
					mode: "derived",
					via: "v1:organization-key",
					baseSnapshotId: BASE_ID,
					baseVersion: 7,
				}),
			}),
		);
	});

	// Paths are user content and have no business in the audit log.
	it("keeps file paths out of the audit metadata", async () => {
		await submit();

		const metadata = m.recordAuditFromRequest.mock.calls[0]?.[1]
			?.metadata as Record<string, unknown>;
		expect(JSON.stringify(metadata)).not.toContain("AGENTS.md");
	});

	it("surfaces a database refusal as its own error", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue({
			ok: false,
			reason: "proposal_proposer_limit",
		});

		await expect(submit()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "PROPOSAL_PROPOSER_LIMIT" },
		});
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("sends a delete-only change set with no upload at all", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			created({ staged: [] }),
		);
		m.listInstructionFiles.mockResolvedValue([]);

		await submit({ changes: [{ op: "delete", path: "old.md" }] });

		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).toHaveBeenCalled();
	});
});

/**
 * A retried push is the same push (Fizzy #2605).
 *
 * Nothing about this call is safe to repeat blindly — it opens a PENDING
 * proposal against a five-per-proposer cap — so the query answers a change set
 * it has already admitted with the row it already wrote, and this is what the
 * entry point does with that answer.
 *
 * ONE WRITER PER ROW. This request did not create that snapshot and does not
 * take it over: no upload, no finalize, no audit row, no compensation. An
 * earlier version resumed a RECEIVING duplicate and had to be withdrawn —
 * the creating request outlives its client, the reaper, the tab's "Try again"
 * and the workflow's own cleanup all write to that row too, and a second
 * writer cannot join them safely without an ownership protocol none of them
 * share.
 *
 * A RECEIVING duplicate is no exception, however old it looks. The browser
 * tab opens proposals through the same query and its staging capabilities
 * stay valid for an hour, so no age this request could pick would be safe to
 * reject on — a person still uploading in the tab would lose their live row
 * to a CLI push of the same content. The reaper's window is the only one
 * every surface honours, and the reaper is what applies it.
 */
describe("a replayed change set", () => {
	function duplicate(overrides: Record<string, unknown> = {}) {
		return {
			ok: false,
			reason: "duplicate_proposal",
			existing: {
				id: "snap_existing",
				version: 8,
				status: "VALIDATING",
				proposalStatus: "PENDING",
				fileCount: 3,
				inheritedCount: 2,
				staged: [{ id: "file_1", path: "AGENTS.md" }],
				...overrides,
			},
		};
	}

	it("returns the existing proposal untouched", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(duplicate());

		const result = await submit();

		expect(result).toMatchObject({
			snapshotId: "snap_existing",
			version: 8,
			baseSnapshotId: BASE_ID,
			baseVersion: 7,
			fileCount: 3,
			inheritedCount: 2,
			putCount: 1,
			deleteCount: 0,
			proposalStatus: "PENDING",
			status: "VALIDATING",
		});
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});

	/**
	 * The audit row says "this caller started an upload". A replay started
	 * nothing — the original request's row already says it — so a second one
	 * would turn one agent's flaky network into a log that claims two
	 * proposals were opened.
	 */
	it("records no second audit row for a replay", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(duplicate());

		await submit();

		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	/**
	 * A RECEIVING duplicate is reported like any other, at any age. Nothing
	 * here may close one out: the browser tab creates proposals through the
	 * same query and holds writable staging capabilities for an hour, so a
	 * row that looks stalled from here may be one a person is still uploading
	 * to. Only the reaper's six-hour window is a judgement every surface
	 * shares.
	 */
	it("leaves a RECEIVING duplicate alone rather than closing it out", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			duplicate({ status: "RECEIVING" }),
		);

		const result = await submit();

		expect(result).toMatchObject({
			snapshotId: "snap_existing",
			status: "RECEIVING",
			proposalStatus: "PENDING",
		});
		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledOnce();
	});

	/**
	 * FAILED keeps `proposalStatus: "PENDING"`, so it goes on matching the
	 * dedup — but its staged objects belong to a validation run that already
	 * touched them, and the tab's "Try again" is the path that restarts it.
	 * Reported, and the surfaces point at that button rather than at another
	 * push the dedup would swallow.
	 */
	it("reports a FAILED duplicate rather than retrying it", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			duplicate({ status: "FAILED" }),
		);

		const result = await submit();

		expect(result).toMatchObject({
			snapshotId: "snap_existing",
			status: "FAILED",
			proposalStatus: "PENDING",
		});
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});
});

/**
 * What comes back is the ROW, not what the request assumed about it.
 *
 * A small change set can reach a terminal verdict before the finalizer's own
 * status write lands — which is why `finalizeInstructionSnapshot` re-reads the
 * status for its answer. `proposalStatus` moves with that verdict, so pairing
 * the finalizer's real status with a hard-coded PENDING produced a result that
 * said "rejected, but awaiting review" and sent the surfaces to offer a cancel
 * nobody can perform.
 */
describe("the state a fresh proposal reports", () => {
	it("re-reads the row after the finalizer rather than asserting PENDING", async () => {
		m.finalizeInstructionSnapshot.mockResolvedValue({ status: "REJECTED" });
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: {
				id: "snap_new",
				version: 8,
				status: "REJECTED",
				proposalStatus: "REJECTED",
				baseVersion: 7,
			},
			publishedPointer: published(),
		});

		const result = await submit();

		expect(
			m.getInstructionSnapshotWithPublishedPointer,
		).toHaveBeenCalledWith("snap_new", PROJECT, ORG);
		expect(result.status).toBe("REJECTED");
		// The pair the CLI and the tool read as "closed out, push again" — a
		// new push is the right action and the dedup will not swallow it.
		expect(result.proposalStatus).toBe("REJECTED");
	});

	it("reports a row that vanished as having no review state left", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: null,
			publishedPointer: published(),
		});

		const result = await submit();

		expect(result.status).toBe("VALIDATING");
		expect(result.proposalStatus).toBeNull();
	});
});

/**
 * `published` — the field a review finding added because `status: "READY"`
 * does not by itself prove a version landed.
 *
 * `mode: "publish"` auto-publishes as a fast-forward
 * (`publishInstructionSnapshotActivity`, `requireBaseUnmoved`), and that
 * activity runs strictly AFTER the one that writes `status: READY` — a
 * separate, later Temporal activity, not the same commit. The response can
 * therefore return before the publish has landed, before it has landed AND
 * been rolled back again, or after it landed and something else has since
 * moved the pointer on. A delta review rejected classifying any of that as
 * "pending" or "superseded" at response time — the true outcome usually has
 * not happened yet, so no wording chosen now can be correct later.
 *
 * `published` instead reports an observed fact, gated on `!proposal`:
 * `current.publishedAt != null` (the durable column
 * `publishInstructionSnapshot` sets once, on the write that moves the
 * pointer to this snapshot, and never clears) OR `publishedPointer?.id ===
 * current.id` (the fresher of the two reads
 * `getInstructionSnapshotWithPublishedPointer` makes, for a publish that
 * commits in the gap between them). `false` means "not yet confirmed",
 * never "refused".
 */
describe("the publication verdict", () => {
	it("reports published: true from the durable publishedAt column", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: {
				id: "snap_new",
				version: 8,
				status: "READY",
				proposalStatus: null,
				baseVersion: 7,
				publishedAt: new Date("2024-01-01T00:00:00Z"),
			},
			// The pointer has since moved past this snapshot — a later edit's
			// own fast-forward, or a deliberate History rollback. This snapshot
			// WAS published; a live pointer check alone would wrongly call that
			// "not published", which is exactly the bug this signal fixes.
			publishedPointer: { ...published(), id: "snap_other", version: 9 },
		});

		const result = await submit({ mode: "publish" });

		expect(result.published).toBe(true);
	});

	// The gap case: the pointer moved to this snapshot in the window between
	// this function's two reads, before `publishedAt` on the first read could
	// reflect it. `publishedPointer` is the fresher signal and catches it.
	it("reports published: true from a pointer match when publishedAt has not caught up", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: {
				id: "snap_new",
				version: 8,
				status: "READY",
				proposalStatus: null,
				baseVersion: 7,
				publishedAt: null,
			},
			publishedPointer: { ...published(), id: "snap_new", version: 8 },
		});

		const result = await submit({ mode: "publish" });

		expect(result.published).toBe(true);
	});

	// READY, but neither signal shows a publish: the ordinary shape of "the
	// fast-forward activity has not committed yet", not a refusal.
	it("reports published: false when neither the durable column nor the pointer shows a publish", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: {
				id: "snap_new",
				version: 8,
				status: "READY",
				proposalStatus: null,
				baseVersion: 7,
				publishedAt: null,
			},
			// Still the original base — nothing has published yet.
			publishedPointer: published(),
		});

		const result = await submit({ mode: "publish" });

		expect(result.published).toBe(false);
	});

	// The proposal path never asks the workflow to publish, so a proposal
	// that validates quickly and reaches READY while still PENDING must not
	// be reported as published. Both signals are set here — as if a reviewer
	// had approved and published it independently in the window between this
	// request's reads — so the test is not vacuous: either signal alone would
	// say `published: true`, and only the `!proposal` gate in the computation
	// keeps the answer `false` for a call that never asked the workflow to
	// publish anything.
	it("never reports a proposal as published, even when both signals show one", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: {
				id: "snap_new",
				version: 8,
				status: "READY",
				proposalStatus: "PENDING",
				baseVersion: 7,
				publishedAt: new Date("2024-01-01T00:00:00Z"),
			},
			publishedPointer: { ...published(), id: "snap_new", version: 8 },
		});

		const result = await submit();

		expect(result.mode).toBe("proposal");
		expect(result.published).toBe(false);
	});
});

/**
 * A failed inline push must not leave a RECEIVING, PENDING proposal sitting in
 * the five-per-proposer admission set for the whole six-hour abandonment
 * window. The tab's flow can afford that: a person is looking at it, can retry
 * or cancel, and the reaper catches the rest. An agent's push has neither.
 *
 * What the compensation does is make the row TERMINAL immediately, carrying
 * the same "staging pending" cleanup mark the reaper writes. It does not free
 * the slot on the spot — `activeProposalFilter` counts a terminal proposal
 * until the reaper's sweep phase clears that mark, which is the existing
 * invariant and what keeps a half-written staging prefix discoverable. The
 * difference is hours versus the next sweep.
 */
describe("compensation for a half-created snapshot", () => {
	it("closes the snapshot out when the upload fails before the workflow start", async () => {
		m.uploadFile.mockRejectedValue(new Error("storage unavailable"));

		await expect(submit()).rejects.toThrow("storage unavailable");

		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			source: "inline_submit_compensation",
		});
		// No `cutoff`: age is not the question for a row this request created
		// seconds ago, and the RECEIVING predicate is the guard that matters.
		expect(
			m.rejectAbandonedInstructionSnapshot.mock.calls[0]?.[0],
		).not.toHaveProperty("cutoff");
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("closes the snapshot out when the staging claim is lost", async () => {
		m.claimInstructionFileStagingKey.mockResolvedValue({ moved: false });

		await expect(submit()).rejects.toMatchObject({ code: "CONFLICT" });

		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: "snap_new" }),
		);
	});

	// The boundary is `workflow.start` itself, not the finalizer's entry.
	//
	// The finalizer reaches Temporal before it starts anything, and THAT is
	// the failure a misconfigured or unreachable cluster produces. No workflow
	// exists, so the row is closed out. The marker comes from the real
	// factory: it is branded with a module-private Symbol, so a test cannot
	// fake one any more than a stray error can.
	it("closes the snapshot out when Temporal could not be reached at all", async () => {
		const cause = new Error("getaddrinfo ENOTFOUND temporal");
		m.finalizeInstructionSnapshot.mockRejectedValue(
			instructionWorkflowNotStarted(cause),
		);

		// The wrapper is transport for the verdict; the caller sees the
		// failure that actually happened.
		await expect(submit()).rejects.toThrow("getaddrinfo ENOTFOUND");

		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshotId: "snap_new",
				source: "inline_submit_compensation",
			}),
		);
	});

	// Once `workflow.start` has been CALLED the row may already be owned by a
	// validation run this request cannot see — the start can succeed and only
	// the acknowledgement be lost. Rejecting it from here would race that run;
	// the reaper's stale-VALIDATING sweep asks Temporal first, which is the
	// question this code cannot answer.
	// R2: the marker is branded with a module-private Symbol, not matched by
	// `name`. An error that merely CARRIES that name — a wrapped third-party
	// failure, something deserialised across a boundary — must not be read as
	// a promise that no execution exists, because acting on it means
	// rejecting a row a validation run may already own.
	it("does not trust a foreign error that only borrows the marker's name", async () => {
		m.finalizeInstructionSnapshot.mockRejectedValue(
			Object.assign(new Error("something else entirely"), {
				name: "InstructionWorkflowNotStartedError",
			}),
		);

		await expect(submit()).rejects.toThrow("something else entirely");

		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("leaves the snapshot alone when the workflow start itself fails", async () => {
		m.finalizeInstructionSnapshot.mockRejectedValue(
			new Error("workflow start rejected by the server"),
		);

		await expect(submit()).rejects.toThrow(
			"workflow start rejected by the server",
		);

		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("does not let a failed release mask the original error", async () => {
		const logged = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		m.uploadFile.mockRejectedValue(new Error("storage unavailable"));
		m.rejectAbandonedInstructionSnapshot.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(submit()).rejects.toThrow("storage unavailable");
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});

	// The race the pre-read cannot see: the published pointer moved between
	// this call reading it and the create transaction writing the row. The
	// database decides it under the project row lock and both refusals reach
	// the caller in the same shape, so the CLI's `PULL_FIRST` branch and the
	// tab's banner need no new vocabulary.
	it("maps a pointer that moved mid-transaction to the same refusal as the pre-read", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue({
			ok: false,
			reason: "base_not_published",
		});

		await expect(submit()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "BASE_NOT_PUBLISHED" },
		});
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});
});

/**
 * The same portable-name contract the folder upload enforces, on the path an
 * AGENT drives. An agent generating a filename has no person looking at it,
 * so a name that stores fine and then refuses to install is exactly the kind
 * of thing that reaches production.
 *
 * `@repo/instructions` is not mocked in this suite, so these run the real
 * validator — the one the CLI's own guard is held to by
 * `packages/instructions/__tests__/portable-names-agree-with-cli.test.ts`.
 */
describe("portable file names", () => {
	it.each([
		["CON.md", "a Windows device name"],
		["docs/nul.txt", "a device name in a subdirectory"],
		["AGENTS.md.", "a trailing dot Windows strips"],
		["AGENTS.md ", "a trailing space Windows strips"],
		["AGENTS.md:stream", "an NTFS alternate data stream"],
		["AGENTS*.md", "a character Windows refuses in a filename"],
		["docs/a|b.md", "a redirection operator in a name"],
	])("refuses %j — %s — before a row is written", async (path) => {
		await expect(
			submit({ changes: [put("x\n", path)] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	// A path already in the published version was admitted before these rules
	// existed and is inherited untouched. The one operation that must still
	// work on it is DELETE — that IS the repair — so a delete is exempt.
	// Refusing it for the very name it is being deleted for would leave the
	// file stuck in every future version, with no way to remove it from any
	// surface.
	it("allows a delete of a grandfathered unportable name", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			created({ staged: [] }),
		);
		m.listInstructionFiles.mockResolvedValue([]);

		await submit({ changes: [{ op: "delete", path: "CON.md" }] });

		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [{ op: "delete", path: "CON.md" }],
			}),
		);
	});

	// Structural safety is NOT exempt: a delete still cannot name a path
	// outside the tree, whatever the base contains.
	it("still refuses a structurally unsafe delete", async () => {
		await expect(
			submit({ changes: [{ op: "delete", path: "../../etc/passwd" }] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("names the file and what to change in the refusal", async () => {
		const error = await submit({
			changes: [put("x\n", "CON.md")],
		}).catch((e: unknown) => e);

		expect((error as { message: string }).message).toContain("CON.md");
		expect((error as { message: string }).message).toContain("Rename");
	});

	it("accepts a name that only looks like a device", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			created({ staged: [{ id: "file_1", path: "connection.md" }] }),
		);
		m.listInstructionFiles.mockResolvedValue([
			stagedRow({ path: "connection.md" }),
		]);

		await submit({ changes: [put("x\n", "connection.md")] });

		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalled();
	});

	// One file, two Unicode spellings. Lowercasing alone does not catch it,
	// so the duplicate check uses the collision key the CLI uses.
	it("refuses two spellings of one name that differ only by Unicode normalisation", async () => {
		await expect(
			submit({
				changes: [
					put("one\n", "caf\u00e9.md"),
					put("two\n", "cafe\u0301.md"),
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});
});

/**
 * A repository-backed project's proposal opens a pull request (Fizzy #2563
 * spec §5.1): admission freezes the destination, the create transaction
 * writes it with its one `upload_started` row, and the operation's workflow
 * starts after commit. The response carries the row's `pullRequest` block.
 */
describe("repository proposals", () => {
	const NOTE = { title: "Tighten the review skill", body: "Why: flaky" };
	const CONTEXT = {
		v: 1,
		syncId: "sync_1",
		syncGeneration: 4,
		branch: "fabric/instructions/op_1",
	};
	const PULL_REQUEST = {
		operationId: "op_1",
		state: "QUEUED",
		url: null,
		externalId: null,
		failure: null,
		lastCheckedAt: null,
	};

	function repositoryAdmission(overrides: Record<string, unknown> = {}) {
		return {
			destination: "REPOSITORY",
			note: NOTE,
			operationId: "op_1",
			context: CONTEXT,
			syncId: "sync_1",
			syncGeneration: 4,
			...overrides,
		};
	}

	beforeEach(() => {
		m.admit.mockResolvedValue(repositoryAdmission());
		m.createDerivedInstructionSnapshot.mockResolvedValue(
			created({ auditWritten: true }),
		);
		m.readProposalPullRequest.mockResolvedValue(PULL_REQUEST);
	});

	it("asks admission with the mode, the raw note, the proposer's name and the change count", async () => {
		await submit({
			note: NOTE,
			audit: { user: { id: USER, email: "", name: "Pat Example" } },
			changes: [put("new\n"), { op: "delete", path: "old.md" }],
		});

		expect(m.admit).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			mode: "proposal",
			note: NOTE,
			proposerName: "Pat Example",
			fileCount: 2,
		});
	});

	it("creates the row with the frozen destination and writes upload_started only inside the create", async () => {
		const result = await submit({ note: NOTE, via: "mcp-gateway" });

		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				proposal: true,
				note: NOTE,
				destination: expect.objectContaining({
					kind: "REPOSITORY",
					operationId: "op_1",
					context: CONTEXT,
					syncId: "sync_1",
					syncGeneration: 4,
					branch: "fabric/instructions/op_1",
					uploadStartedAudit: expect.objectContaining({
						actor: { type: "user", userId: USER },
						organizationId: ORG,
						projectId: PROJECT,
						metadata: {
							mode: "proposal",
							baseSnapshotId: BASE_ID,
							baseVersion: 7,
							putCount: 1,
							deleteCount: 0,
							via: "mcp-gateway",
						},
					}),
				}),
			}),
		);
		// None from the outer call: the transaction wrote the one row.
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		// The upload and the validation run are the same as any proposal's.
		expect(m.uploadFile).toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).toHaveBeenCalled();
		expect(result.pullRequest).toEqual(PULL_REQUEST);
		// Read from the row, tenant-scoped, after the validation run started.
		expect(m.readProposalPullRequest).toHaveBeenCalledWith({
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
		});
	});

	it("starts the operation's workflow after the row commits", async () => {
		await submit();

		expect(m.startAdmittedProposalPullRequest).toHaveBeenCalledTimes(1);
		expect(m.startAdmittedProposalPullRequest).toHaveBeenCalledWith({
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			operationId: "op_1",
		});
		expect(
			m.createDerivedInstructionSnapshot.mock.invocationCallOrder[0],
		).toBeLessThan(
			m.startAdmittedProposalPullRequest.mock.invocationCallOrder[0]!,
		);
	});

	it("starts the pull-request workflow before the upload and compensates with inline_submit_compensation when the upload fails", async () => {
		m.uploadFile.mockRejectedValue(new Error("storage unavailable"));

		await expect(submit()).rejects.toThrow("storage unavailable");

		// The pull-request workflow had already started, before any byte was
		// written; the validation workflow never did.
		expect(m.startAdmittedProposalPullRequest).toHaveBeenCalledTimes(1);
		expect(
			m.startAdmittedProposalPullRequest.mock.invocationCallOrder[0],
		).toBeLessThan(m.uploadFile.mock.invocationCallOrder[0]!);
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
		// The failed upload is compensated all the same, through the
		// conditional write that, for a repository proposal, also cancels its
		// operation in the same transaction. This suite mocks that write; what
		// it leaves on Postgres (a REJECTED snapshot and a CANCELED operation)
		// is pinned in instruction-proposal-pull-requests.integration.test.ts.
		// Neither test runs the readiness activity.
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledTimes(1);
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			source: "inline_submit_compensation",
		});
		expect(m.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
			m.rejectAbandonedInstructionSnapshot.mock.invocationCallOrder[0]!,
		);
	});

	it("admits an attribution-refused row BLOCKED and starts no workflow", async () => {
		const blocked = {
			phase: "admission",
			code: "ATTRIBUTION_REJECTED",
			retryable: false,
			at: "2026-09-24T12:00:00.000Z",
			params: {},
		};
		m.admit.mockResolvedValue(repositoryAdmission({ blocked }));
		m.readProposalPullRequest.mockResolvedValue({
			...PULL_REQUEST,
			state: "BLOCKED",
			failure: blocked,
		});

		const result = await submit();

		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				destination: expect.objectContaining({ blocked }),
			}),
		);
		expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
		expect(result.pullRequest).toMatchObject({
			state: "BLOCKED",
			failure: blocked,
		});
	});

	it("returns a duplicate's existing proposal and pull request and starts nothing", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue({
			ok: false,
			reason: "duplicate_proposal",
			existing: {
				id: "snap_existing",
				version: 8,
				status: "READY",
				proposalStatus: "PENDING",
				fileCount: 3,
				inheritedCount: 2,
				staged: [],
			},
		});
		m.readProposalPullRequest.mockResolvedValue({
			...PULL_REQUEST,
			operationId: "op_earlier",
			state: "OPEN",
		});

		const result = await submit();

		expect(result).toMatchObject({
			snapshotId: "snap_existing",
			pullRequest: { operationId: "op_earlier", state: "OPEN" },
		});
		expect(m.readProposalPullRequest).toHaveBeenCalledWith({
			snapshotId: "snap_existing",
			projectId: PROJECT,
			organizationId: ORG,
		});
		expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("a FABRIC proposal keeps its note and its post-commit audit, and has no pull request", async () => {
		m.admit.mockResolvedValue({ destination: "FABRIC", note: NOTE });
		m.createDerivedInstructionSnapshot.mockResolvedValue(created());

		const result = await submit({ note: NOTE });

		const call = m.createDerivedInstructionSnapshot.mock.calls[0]![0];
		expect(call).toMatchObject({ note: NOTE });
		expect(call).not.toHaveProperty("destination");
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
		expect(m.readProposalPullRequest).not.toHaveBeenCalled();
		expect(result.pullRequest).toBeNull();
	});
});
