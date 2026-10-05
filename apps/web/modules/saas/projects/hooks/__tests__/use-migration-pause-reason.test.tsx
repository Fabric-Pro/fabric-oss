/**
 * The sentence the paused controls give, one per state a move can be read in
 * (Fizzy #2878 §9). It is looked up in the real copy, which throws on a key
 * nobody wrote, so a state added to the move without a sentence fails here.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryMigrationView } from "../../lib/instructions-migration";
import { InstructionMigrationRepositoryProvider } from "../instruction-migration-repository";
import { useMigrationPauseReason } from "../use-migration-pause-reason";

vi.mock("next-intl", async () =>
	(await import("../../__tests__/en-copy")).nextIntlMock(),
);

function move(
	overrides: Partial<RepositoryMigrationView> = {},
): RepositoryMigrationView {
	return {
		state: "OPEN",
		closing: false,
		startedAt: "2026-10-02T10:00:00.000Z",
		startedByUserId: "user-1",
		snapshotId: "snap-1",
		branchId: "branch-1",
		syncId: "sync-1",
		pullRequest: {
			url: "https://example.com/pull/12",
			externalId: "12",
			state: "OPEN",
		},
		targetMismatch: false,
		failure: null,
		...overrides,
	};
}

function wrapper({ children }: { children: ReactNode }) {
	return (
		<InstructionMigrationRepositoryProvider repository="example-org/instructions">
			{children}
		</InstructionMigrationRepositoryProvider>
	);
}

describe("useMigrationPauseReason", () => {
	it.each([
		[
			"a pull request awaiting its merge",
			move(),
			"Moving to example-org/instructions: pull request #12 is open. Changes are paused until it is merged and synced, or the move is canceled.",
		],
		[
			"a pull request being prepared",
			move({ state: "PROPOSING", pullRequest: null }),
			"Moving to example-org/instructions: the pull request is still being prepared. Changes are paused until it is merged and synced, or the move is canceled.",
		],
		[
			"a project switching over",
			move({ state: "SWITCHING" }),
			"Moving to example-org/instructions: the pull request was merged and the project is switching to the repository. Changes are paused until that finishes.",
		],
		[
			"a blocked move",
			move({
				state: "BLOCKED",
				pullRequest: null,
				failure: { code: "AUTHENTICATION_FAILED", retryable: true },
			}),
			"Moving to example-org/instructions: the move is stuck. Changes are paused until you retry it or cancel it.",
		],
		[
			"a project switched behind the move's back",
			move({
				state: "BLOCKED",
				pullRequest: null,
				failure: { code: "SOURCE_FLIPPED", retryable: false },
			}),
			"Moving to example-org/instructions: the project was switched to the repository outside the move. Changes are paused until you switch it back to upload mode.",
		],
		[
			"a pull request that ended",
			move({ state: "ABANDONED" }),
			"Moving to example-org/instructions: the pull request ended without merging. Changes are paused until you cancel the move.",
		],
		[
			"a pull request merged into another branch",
			move({ state: "ABANDONED", targetMismatch: true }),
			"Moving to example-org/instructions: the pull request was merged into another branch, so the move has ended. Changes are paused until you cancel the move.",
		],
	])("says, for %s, why changes are paused", (_label, view, sentence) => {
		const { result } = renderHook(
			() => useMigrationPauseReason(true, view),
			{ wrapper },
		);

		expect(result.current).toBe(sentence);
	});

	it("says only that changes are paused before the move has been read", () => {
		const { result } = renderHook(
			() => useMigrationPauseReason(true, null),
			{ wrapper },
		);

		expect(result.current).toBe(
			"Moving to example-org/instructions. Changes are paused until the pull request is merged and synced, or the move is canceled.",
		);
	});

	it("says nothing when no move is open", () => {
		const { result } = renderHook(
			() => useMigrationPauseReason(false, null),
			{ wrapper },
		);

		expect(result.current).toBeNull();
	});
});
