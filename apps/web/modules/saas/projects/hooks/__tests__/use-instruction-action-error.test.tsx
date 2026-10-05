/**
 * A failed Coding Instructions action reads its line from the error's code. A
 * write refused because the uploaded instructions are being moved into a
 * repository (Fizzy #2878 §9) names the repository and the pull request, which
 * the refusal alone does not carry: the repository comes from the tab.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { InstructionMigrationRepositoryProvider } from "../instruction-migration-repository";
import { useInstructionActionError } from "../use-instruction-action-error";
import { useSyncActionError } from "../use-sync-action-error";

vi.mock("next-intl", async () =>
	(await import("../../__tests__/en-copy")).nextIntlMock(),
);

function frozen(data: Record<string, unknown>) {
	return {
		code: "CONFLICT",
		message: "TEXT THAT MUST NOT BE SHOWN",
		data: { reason: "MIGRATION_OPEN", ...data },
	};
}

const OPEN = frozen({
	state: "PROPOSING",
	pullRequest: { url: "https://example.com/pull/12", externalId: "12" },
});

function within(repository: string | null) {
	return ({ children }: { children: ReactNode }) => (
		<InstructionMigrationRepositoryProvider repository={repository}>
			{children}
		</InstructionMigrationRepositoryProvider>
	);
}

describe("useInstructionActionError during a move into a repository", () => {
	it("names the repository and the pull request that is open", () => {
		const { result } = renderHook(() => useInstructionActionError(), {
			wrapper: within("example-org/instructions"),
		});

		expect(result.current(OPEN)).toBe(
			"Moving to example-org/instructions: pull request #12 is open. Changes are paused until it is merged and synced, or the move is canceled.",
		);
	});

	it("says the pull request is being prepared before it has a number", () => {
		const { result } = renderHook(() => useInstructionActionError(), {
			wrapper: within("example-org/instructions"),
		});

		expect(
			result.current(frozen({ state: "PROPOSING", pullRequest: null })),
		).toBe(
			"Moving to example-org/instructions: the pull request is still being prepared. Changes are paused until it is merged and synced, or the move is canceled.",
		);
	});

	it("says a merged move is switching, not that its pull request is open", () => {
		const { result } = renderHook(() => useInstructionActionError(), {
			wrapper: within("example-org/instructions"),
		});

		expect(
			result.current(
				frozen({
					state: "SWITCHING",
					pullRequest: {
						url: "https://example.com/pull/12",
						externalId: "12",
					},
				}),
			),
		).toBe(
			"Moving to example-org/instructions: the pull request was merged and the project is switching to the repository. Changes are paused until that finishes.",
		);
	});

	it("says 'the repository' when the tab has not told it which one", () => {
		const { result } = renderHook(() => useInstructionActionError());

		expect(result.current(OPEN)).toMatch(
			/^Moving to the repository: pull request #12 is open\./,
		);
	});

	it("never shows the server's own text", () => {
		const { result } = renderHook(() => useInstructionActionError(), {
			wrapper: within("example-org/instructions"),
		});

		expect(result.current(OPEN)).not.toContain("MUST NOT BE SHOWN");
	});

	it("still words every other conflict as before", () => {
		const { result } = renderHook(() => useInstructionActionError(), {
			wrapper: within("example-org/instructions"),
		});

		expect(
			result.current({
				code: "CONFLICT",
				data: { reason: "PUBLISHED_CHANGED" },
			}),
		).toBe("This changed while you were working. Refresh and try again.");
	});
});

describe("useSyncActionError", () => {
	it("words a sync action frozen by a move with the shared sentence", () => {
		const { result } = renderHook(() => useSyncActionError(), {
			wrapper: within("example-org/instructions"),
		});

		expect(result.current(OPEN, "syncNow")).toMatch(
			/^Moving to example-org\/instructions: pull request #12 is open\./,
		);
	});

	it("keeps the sync action's own sentence for any other failure", () => {
		const { result } = renderHook(() => useSyncActionError(), {
			wrapper: within(null),
		});

		expect(result.current(new Error("boom"), "syncNow")).toBe(
			"Couldn't start the sync. Try again in a moment.",
		);
	});

	it("keeps the configure dialog's own words for a branch that is gone", () => {
		const { result } = renderHook(() => useSyncActionError(), {
			wrapper: within(null),
		});

		expect(
			result.current(
				{ code: "NOT_FOUND", data: { code: "BRANCH_NOT_FOUND" } },
				"syncNow",
				"release",
			),
		).toContain("release");
	});
});
