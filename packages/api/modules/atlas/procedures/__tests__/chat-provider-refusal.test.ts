/**
 * What the Atlas chat tells a tenant that has configured no provider.
 *
 * Every AI surface now refuses the same way — `generateTasksProcedure` sets the
 * shape: PRECONDITION_FAILED carrying the resolver's own message, which names
 * the settings page that fixes it. This procedure answered with BAD_REQUEST and
 * hand-written copy naming a DIFFERENT page ("Settings → AI Models"), so the
 * same condition produced two different instructions depending on which button
 * the user pressed (Fizzy #1875).
 *
 * Also pinned: anything else still goes through `mapAtlasError`, which is the
 * only thing standing between an unrecognised failure and a raw 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: { chat: vi.fn() },
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
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

process.env.FABRIC_FEATURE_ATLAS = "true";

await import("../chat");

const REFUSAL =
	"No AI provider configured. Please configure an AI provider in Settings → AI Providers.";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function runChat() {
	return handlers.chat({
		input: {
			projectId: "proj-1",
			organizationId: null,
			mode: "TECHNICAL",
			messages: [],
		},
		context: ctx,
	});
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
});

describe("atlasChatProcedure — no provider configured", () => {
	it("returns the same refusal every other AI procedure returns", async () => {
		const { AIProviderNotConfiguredError } = await import("@repo/ai");
		mocks.chat.mockRejectedValue(new AIProviderNotConfiguredError(REFUSAL));

		const err = await errorFrom(runChat() as Promise<unknown>);

		expect(err.code).toBe("PRECONDITION_FAILED");
		// The resolver's own words, so the remedy names one page across surfaces.
		expect(err.message).toBe(REFUSAL);
	});

	it("still maps an Atlas error through mapAtlasError", async () => {
		const { AtlasError } = await import("@repo/atlas");
		mocks.chat.mockRejectedValue(
			new AtlasError("NO_REPOSITORY", "No repository is connected."),
		);

		const err = await errorFrom(runChat() as Promise<unknown>);

		expect(err.code).toBe("BAD_REQUEST");
		expect(err.message).toBe("No repository is connected.");
	});
});
