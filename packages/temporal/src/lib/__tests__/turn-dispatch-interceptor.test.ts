/**
 * The activity interceptor that installs a chat turn's dispatch guard. It is
 * what makes every model and embedding request of a turn-scoped activity
 * checked and abortable without per-call-site work, so it must set the guard
 * exactly when the activity's first argument carries a well-formed
 * `turnScope`, and never otherwise.
 */

import {
	type DispatchGuard,
	getDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkDispatchable } = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: checkDispatchable,
}));

import { turnScopeKey } from "../../activities/orchestrator/turn-dispatch";
import {
	extractTurnScope,
	TurnDispatchActivityInboundInterceptor,
} from "../turn-dispatch-interceptor";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

function makeInput(args: unknown[]) {
	// Only `args` is read by the interceptor.
	return { args, headers: {} } as never;
}

async function guardSeenBy(args: unknown[]) {
	const interceptor = new TurnDispatchActivityInboundInterceptor();
	let ran = false;
	let seen: DispatchGuard | undefined;
	await interceptor.execute(makeInput(args), () => {
		ran = true;
		seen = getDispatchGuard();
		return Promise.resolve(undefined);
	});
	expect(ran).toBe(true);
	return seen;
}

beforeEach(() => {
	checkDispatchable.mockReset();
});

describe("TurnDispatchActivityInboundInterceptor", () => {
	it("runs the activity inside the turn's guard when args[0] carries a turn scope", async () => {
		const guard = await guardSeenBy([
			{ query: "q", turnScope: TURN_SCOPE },
		]);

		expect(guard?.key).toBe(turnScopeKey(TURN_SCOPE));
	});

	it("wires the guard to the turn record check", async () => {
		checkDispatchable.mockResolvedValue({ ok: false, reason: "cancelled" });
		const guard = await guardSeenBy([{ turnScope: TURN_SCOPE }]);

		await expect(guard?.assertDispatchable()).rejects.toMatchObject({
			type: "TurnNotDispatchable",
			nonRetryable: true,
		});
		expect(checkDispatchable).toHaveBeenCalledWith(TURN_SCOPE);
	});

	it("wires rethrowIfStopped to the turn's stop detection", async () => {
		checkDispatchable.mockResolvedValue({ ok: false, reason: "cancelled" });
		const guard = await guardSeenBy([{ turnScope: TURN_SCOPE }]);
		const refusal = await guard
			?.assertDispatchable()
			.catch((error: unknown) => error);

		// Wrapped the way the AI SDK wraps a refusal on a retry.
		expect(() =>
			guard?.rethrowIfStopped({ lastError: refusal, errors: [refusal] }),
		).toThrow(refusal as Error);
		expect(() =>
			guard?.rethrowIfStopped(new Error("provider unavailable")),
		).not.toThrow();
	});

	it("sets no guard when the activity has no turn scope", async () => {
		expect(await guardSeenBy([{ query: "q" }])).toBeUndefined();
		expect(await guardSeenBy(["positional", "args"])).toBeUndefined();
		expect(await guardSeenBy([])).toBeUndefined();
	});

	it("sets no guard for a malformed turn scope", async () => {
		const { turnId: _turnId, ...withoutTurnId } = TURN_SCOPE;
		expect(
			await guardSeenBy([{ turnScope: withoutTurnId }]),
		).toBeUndefined();
		expect(
			await guardSeenBy([{ turnScope: { ...TURN_SCOPE, userId: "" } }]),
		).toBeUndefined();
		expect(await guardSeenBy([{ turnScope: "turn-1" }])).toBeUndefined();
		expect(await guardSeenBy([{ turnScope: null }])).toBeUndefined();
	});

	it("keeps a turn whose organization is empty, so its check fails closed", () => {
		expect(
			extractTurnScope(
				makeInput([
					{ turnScope: { ...TURN_SCOPE, organizationId: "" } },
				]),
			),
		).toEqual({ ...TURN_SCOPE, organizationId: "" });
	});

	it("does not carry the guard outside the activity body", async () => {
		await guardSeenBy([{ turnScope: TURN_SCOPE }]);
		expect(getDispatchGuard()).toBeUndefined();
	});
});
