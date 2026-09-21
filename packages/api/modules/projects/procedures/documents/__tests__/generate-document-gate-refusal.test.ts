/**
 * A capability refusal has to survive this procedure's catch (Fizzy #1930).
 *
 * The gate is asserted inside `dispatchDocumentGeneration`, but everything this
 * handler calls is wrapped in a `try` whose `catch` deliberately generalizes:
 * token issuance, the Temporal client and `workflow.start` can all carry hosts,
 * connection strings and provider messages that must never reach a toast, so
 * the raw error is logged and a fixed INTERNAL_SERVER_ERROR is thrown instead.
 *
 * A gate refusal is the one thing in there that is not a fault. It is the
 * answer: it names the prerequisite, it carries the resolved gate the UI
 * renders, and flattening it to a 500 would make it unreadable to the client
 * and indistinguishable from a crash in the logs.
 *
 * This is exactly the wiring that rots silently — the assert keeps passing its
 * own unit test while the caller quietly swallows it — so both halves are
 * pinned here: the refusal passes through untouched, and every other failure
 * still generalizes exactly as before.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getDocumentById: vi.fn(),
		resolveEffectiveProjectPermissions: vi.fn(),
		dispatchDocumentGeneration: vi.fn(),
		loggerError: vi.fn(),
	},
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	getDocumentById: mocks.getDocumentById,
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: (granted: readonly string[], permission: string) =>
		granted.includes(permission),
}));

vi.mock("../../../lib/dispatch-document-generation", () => ({
	dispatchDocumentGeneration: mocks.dispatchDocumentGeneration,
	MAX_RUN_INSTRUCTIONS_CHARS: 10_000,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: mocks.loggerError,
		debug: vi.fn(),
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { generateDocumentProcedure } from "../generate-document";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const handler = (generateDocumentProcedure as unknown as { _handler: Handler })
	._handler;

/** The refusal the dispatcher's gate raises, verbatim. */
const REFUSAL =
	"Generate Technical Specification is not ready yet. It needs a PRD, architecture document or indexed codebase.";

function run() {
	return handler({
		input: { id: "document_example" },
		context: { user: { id: "user_example" } },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getDocumentById.mockResolvedValue({
		id: "document_example",
		projectId: "project_example",
		type: "TECHNICAL_SPEC",
		content: "existing content",
		project: { organizationId: "organization_example" },
	});
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "member",
		permissions: ["DOCUMENT_UPDATE"],
	});
});

describe("generateDocumentProcedure — a gate refusal survives the catch", () => {
	it("rethrows PRECONDITION_FAILED instead of flattening it to a 500", async () => {
		mocks.dispatchDocumentGeneration.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", { message: REFUSAL }),
		);

		await expect(run()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: REFUSAL,
		});
	});

	it("keeps the resolved gate attached for the client to render", async () => {
		const gate = {
			capabilityKey: "documents.generate-tech-spec",
			state: "SOFT_BLOCK",
			blockingDependency:
				"a PRD, architecture document or indexed codebase",
		};
		mocks.dispatchDocumentGeneration.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: REFUSAL,
				data: { gate },
			}),
		);

		const error = (await run().catch((e: unknown) => e)) as {
			data?: { gate?: unknown };
		};

		expect(error.data?.gate).toEqual(gate);
	});

	it("does not log a refusal as an operator error", async () => {
		// It is an answer, not a fault. Logging it at error level would put a
		// routine "connect a repository first" into the same channel as a
		// Temporal outage.
		mocks.dispatchDocumentGeneration.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", { message: REFUSAL }),
		);

		await run().catch(() => {});

		expect(mocks.loggerError).not.toHaveBeenCalled();
	});

	it("still generalizes every other failure, with the raw cause logged", async () => {
		// The half that must NOT change. An infrastructure error can carry a
		// host or a connection string, so the caller keeps getting the fixed
		// message and the detail stays in the log.
		mocks.dispatchDocumentGeneration.mockRejectedValue(
			new Error("temporal connection refused: internal-host:7233"),
		);

		await expect(run()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to start document generation",
		});
		expect(String(mocks.loggerError.mock.calls[0]?.[0])).toContain(
			"internal-host",
		);
	});
});
