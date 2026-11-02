import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { useDetailLoadFeedback } from "../use-detail-load-feedback";

const error = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error } }));
it("closes a failed detail action, toasts, and permits another click to load it", async () => {
	let reject!: (reason: Error) => void;
	const load = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise((_resolve, r) => {
					reject = r;
				}),
		)
		.mockResolvedValue({ description: "full" });
	function Action() {
		const [open, setOpen] = useState(false);
		const query = useQuery({
			queryKey: ["detail"],
			queryFn: load,
			enabled: open,
			retry: false,
		});
		useDetailLoadFeedback(open, query, () => setOpen(false), "Load failed");
		return (
			<>
				<button type="button" onClick={() => setOpen(true)}>
					Open
				</button>
				{open && query.isFetching && <output>Loading</output>}
				{open && query.data && (
					<div role="dialog">{query.data.description}</div>
				)}
			</>
		);
	}
	render(
		<QueryClientProvider client={new QueryClient()}>
			<Action />
		</QueryClientProvider>,
	);
	await userEvent.click(screen.getByRole("button"));
	expect(screen.getByRole("status")).toHaveTextContent("Loading");
	await act(async () => reject(new Error("offline")));
	await waitFor(() => expect(error).toHaveBeenCalledWith("Load failed"));
	expect(screen.queryByRole("dialog")).toBeNull();
	await userEvent.click(screen.getByRole("button"));
	expect(await screen.findByRole("dialog")).toHaveTextContent("full");
	expect(load).toHaveBeenCalledTimes(2);
});
