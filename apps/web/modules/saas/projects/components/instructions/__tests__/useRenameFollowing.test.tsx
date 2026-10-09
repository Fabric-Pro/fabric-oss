import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRenameFollowing } from "../useRenameFollowing";

const OLD = { generation: 1, commitSha: "a".repeat(40) };
const NEW = { generation: 1, commitSha: "b".repeat(40) };

type Input = { paths: string[] | undefined; pin: typeof OLD };

describe("useRenameFollowing", () => {
	it("keeps the old file on screen until the list names the new path, then moves once", () => {
		const onLanded = vi.fn();
		const { result, rerender } = renderHook(
			(input: Input) => useRenameFollowing({ ...input, onLanded }),
			{ initialProps: { paths: ["AGENTS.md", "a.md"], pin: OLD } },
		);

		act(() => result.current.begin("a.md", "b.md"));
		expect(result.current.waiting).toMatchObject({
			from: "a.md",
			pin: OLD,
		});
		expect(result.current.landedPath).toBeNull();

		rerender({ paths: undefined, pin: NEW });
		expect(result.current.waiting).toMatchObject({
			from: "a.md",
			pin: OLD,
		});
		expect(onLanded).not.toHaveBeenCalled();

		rerender({ paths: ["AGENTS.md", "b.md"], pin: NEW });
		expect(onLanded).toHaveBeenCalledTimes(1);
		expect(onLanded).toHaveBeenCalledWith("b.md");
		expect(result.current.waiting).toBeNull();

		rerender({ paths: ["AGENTS.md", "b.md"], pin: NEW });
		expect(onLanded).toHaveBeenCalledTimes(1);
	});

	it("stops waiting when the list for the new commit arrives without the new path", () => {
		const onLanded = vi.fn();
		const { result, rerender } = renderHook(
			(input: Input) => useRenameFollowing({ ...input, onLanded }),
			{ initialProps: { paths: ["a.md"], pin: OLD } },
		);
		act(() => result.current.begin("a.md", "b.md"));

		rerender({ paths: ["AGENTS.md"], pin: NEW });

		expect(result.current.waiting).toBeNull();
		expect(onLanded).not.toHaveBeenCalled();
	});
});
