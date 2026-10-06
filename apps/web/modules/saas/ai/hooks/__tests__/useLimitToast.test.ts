/**
 * The toast for an `internal_budget` stop names the limit that tripped, and
 * offers Billing settings only for the token budget (Fizzy #2944).
 */
import type { LimitSignal } from "@repo/ai/limits";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { slug: "example-org" },
		isOrganizationAdmin: true,
	}),
}));

import { useLimitToast } from "../useLimitToast";

function show(signal: LimitSignal) {
	const { result } = renderHook(() => useLimitToast());
	result.current(signal);
	return toastError.mock.calls[0] as [
		string,
		{ description: string; action?: { label: string } },
	];
}

beforeEach(() => {
	toastError.mockClear();
});

describe("useLimitToast internal_budget copy", () => {
	it("names an iteration-limit stop as a step limit, without the billing action", () => {
		const [title, options] = show({
			kind: "internal_budget",
			message: "Iteration limit reached: 14/15",
			budgetLimit: "iterations",
		});

		expect(title).toBe("Response was cut short — step limit reached");
		expect(options.description).not.toMatch(/token/);
		expect(options.action).toBeUndefined();
	});

	it("names a token stop as a token budget, with the billing action", () => {
		const [title, options] = show({
			kind: "internal_budget",
			message: "Token budget exceeded: 492001/500000",
			budgetLimit: "tokens",
		});

		expect(title).toBe("Response was cut short — token budget reached");
		expect(options.action?.label).toBe("Billing settings");
	});
});
