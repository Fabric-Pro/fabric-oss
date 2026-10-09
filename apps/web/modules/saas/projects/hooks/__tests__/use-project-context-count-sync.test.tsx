import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				key: ({ input }: { input: unknown }) => ["projects.get", input],
			},
		},
	},
}));

import { useProjectContextCountSync } from "../use-project-context-count-sync";

function setup(initial: string | undefined) {
	const client = new QueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const view = renderHook(
		({ count }: { count: string | undefined }) =>
			useProjectContextCountSync("p1", count),
		{ wrapper, initialProps: { count: initial } },
	);
	return { invalidate, view };
}

describe("useProjectContextCountSync", () => {
	it("reads the project again when the list gains a context the header has not counted", () => {
		const { invalidate, view } = setup("");
		expect(invalidate).not.toHaveBeenCalled();

		view.rerender({ count: "a:COMPLETED" });

		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["projects.get", { id: "p1" }],
		});
	});

	it("does the same when a row finishes extracting, as the first repository sync does", () => {
		const { invalidate, view } = setup("a:EXTRACTING");

		view.rerender({ count: "a:COMPLETED" });

		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("does the same when the list loses one", () => {
		const { invalidate, view } = setup("a:COMPLETED,b:COMPLETED");

		view.rerender({ count: "a:COMPLETED" });

		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("only records the first length it sees, and ignores an unchanged one", () => {
		const { invalidate, view } = setup(undefined);

		view.rerender({ count: "a:COMPLETED" });
		view.rerender({ count: "a:COMPLETED" });

		expect(invalidate).not.toHaveBeenCalled();
	});
});
