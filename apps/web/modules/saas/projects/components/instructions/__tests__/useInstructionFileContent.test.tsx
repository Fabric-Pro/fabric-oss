import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useInstructionFileContent } from "../useInstructionFileContent";

const read = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repository: {
					getFile: {
						queryOptions: ({
							input,
						}: {
							input: { offset: number };
						}) => ({
							queryKey: ["native-page", input],
							queryFn: () => read(input),
						}),
					},
				},
			},
		},
	},
}));

describe("native file paging", () => {
	it("retries a failed next page without losing the already loaded bytes or adding a duplicate page", async () => {
		let failNext = true;
		read.mockImplementation(async ({ offset }) => {
			if (offset === 0)
				return {
					state: "found",
					body: "first\r\n",
					nextOffset: 7,
					size: 14,
				};
			if (failNext) {
				failNext = false;
				throw new Error("Transient provider failure");
			}
			return {
				state: "found",
				body: "second\n",
				nextOffset: null,
				size: 14,
			};
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
		const { result, unmount } = renderHook(
			() =>
				useInstructionFileContent({
					projectId: "project-1",
					path: "AGENTS.md",
					nativeBase: { generation: 7, commitSha: "a".repeat(40) },
				}),
			{ wrapper },
		);
		await waitFor(() =>
			expect(result.current.data?.body).toBe("first\r\n"),
		);
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.pageError).not.toBeNull());
		expect(result.current.data?.body).toBe("first\r\n");
		act(() => result.current.loadMore());
		await waitFor(() =>
			expect(result.current.data?.body).toBe("first\r\nsecond\n"),
		);
		expect(result.current.data?.nextOffset).toBeNull();
		expect(read.mock.calls.map(([input]) => input.offset)).toEqual([
			0, 7, 7,
		]);
		unmount();
		client.clear();
	});
});
