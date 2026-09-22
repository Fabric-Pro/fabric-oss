/**
 * The capability gate on codebase question answering (Fizzy #1930).
 *
 * Same door as `analyze-capability-gate.test.ts`, different key — and one extra
 * thing worth pinning here. The assert sits ABOVE this handler's `try`, whose
 * catch ends in `mapAtlasError`. That function rethrows a non-Atlas error
 * unchanged today, so the refusal would survive either way; the placement is
 * what keeps that true if the mapping ever grows a catch-all. The last test
 * below asserts the code and message the caller actually receives, which is the
 * property that matters however the error travels.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		isFeatureEnabled: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		chat: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
	// The flag is resolved for the project's own organization (Fizzy #1930).
	db: {
		project: {
			findUnique: async () => ({
				organizationId: "organization_example",
			}),
		},
	},
}));

vi.mock("../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return { AIProviderNotConfiguredError };
});

vi.mock("@repo/atlas", () => {
	class AtlasError extends Error {
		readonly code: string;
		constructor(code: string, message: string) {
			super(message);
			this.code = code;
			this.name = "AtlasError";
		}
	}
	return {
		AtlasError,
		AtlasService: class {
			chat = mocks.chat;
		},
		atlasChatInputSchema: {},
	};
});

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.chat = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

process.env.FABRIC_FEATURE_ATLAS = "true";

await import("../chat");

import {
	evidenceWith,
	healthyEvidence,
} from "../../../capabilities/__tests__/evidence-fixture";

const ctx = {
	user: { id: "user_example" },
	session: { id: "session_example", activeOrganizationId: null },
};

function runChat() {
	return handlers.chat({
		input: {
			projectId: "project_example",
			organizationId: null,
			mode: "TECHNICAL",
			messages: [],
		},
		context: ctx,
	}) as Promise<unknown>;
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected the handler to throw");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.gatherCapabilityEvidence.mockResolvedValue(healthyEvidence());
	mocks.chat.mockResolvedValue({
		textStream: (async function* () {
			yield "answer";
		})(),
		persistOutcome: Promise.resolve({
			persisted: true,
			interrupted: false,
		}),
	});
});

describe("atlasChatProcedure — the capability door", () => {
	it("refuses with PRECONDITION_FAILED naming the repository it needs", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		const err = await errorFrom(runChat());

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain("a connected repository");
	});

	it("refuses before the chat is ever started", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		await errorFrom(runChat());

		expect(mocks.chat).not.toHaveBeenCalled();
	});

	it("proceeds when the index is usable", async () => {
		await expect(runChat()).resolves.toBeDefined();
		expect(mocks.chat).toHaveBeenCalledTimes(1);
	});

	it("is inert with the flag off — no evidence read, no refusal", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		await expect(runChat()).resolves.toBeDefined();
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("survives the handler's own error mapping unmodified", async () => {
		// `mapAtlasError` is the catch-all this refusal has to pass through
		// intact. A remapped code here would hand the caller "bad request" for a
		// condition their input had no part in.
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({
				codebase: { integrationStatus: "TOKEN_EXPIRED" },
			}),
		);

		const err = await errorFrom(runChat());

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain("valid repository credentials");
	});
});
