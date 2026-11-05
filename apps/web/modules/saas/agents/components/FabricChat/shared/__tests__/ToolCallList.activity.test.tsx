import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallList } from "../ToolCallList";
import { effectiveToolStatus } from "../tool-activity";

afterEach(cleanup);

describe("Genie activity", () => {
	it("folds routine completed logs while preserving inspection", async () => {
		const user = userEvent.setup();
		render(
			<ToolCallList
				groupActivity
				toolCalls={[
					{
						id: "example-call",
						name: "Read example notes",
						status: "complete",
						args: {},
					},
				]}
			/>,
		);
		expect(
			screen.queryByText("Read example notes"),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /activity/ }));
		expect(await screen.findByText("Read example notes")).toBeVisible();
	});
	it("keeps a failed MCP envelope and its explanation visible", () => {
		render(
			<ToolCallList
				groupActivity
				expandable={false}
				toolCalls={[
					{
						id: "example-call",
						name: "Read notes",
						status: "complete",
						args: {},
						result: {
							isError: true,
							content: [
								{
									type: "text",
									text: "Example connection needs to be reconnected",
								},
							],
						},
					},
				]}
			/>,
		);
		expect(
			screen.getByText("Example connection needs to be reconnected"),
		).toBeVisible();
		expect(screen.queryByText("Completed")).not.toBeInTheDocument();
	});
	it("keeps a generated Frame actionable outside folded routine activity", async () => {
		const open = vi.fn();
		const user = userEvent.setup();
		render(
			<ToolCallList
				groupActivity
				onOpenFrame={open}
				toolCalls={[
					{
						id: "example-read",
						name: "Read example notes",
						status: "complete",
						args: {},
					},
					{
						id: "example-frame-call",
						name: "fabric_create_frame",
						status: "complete",
						args: {},
						result: {
							frameId: "example-frame",
							title: "Example delivery brief",
						},
					},
				]}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open interactive content" }),
		);
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({ frameId: "example-frame" }),
		);
		expect(
			screen.queryByText("Read example notes"),
		).not.toBeInTheDocument();
	});
	it("never labels an unfinished or failed Frame as ready", () => {
		render(
			<ToolCallList
				groupActivity
				toolCalls={[
					{
						id: "example-call",
						name: "fabric_create_frame",
						status: "running",
						args: {},
						result: { frameId: "example-frame" },
					},
				]}
			/>,
		);
		expect(
			screen.queryByText("Interactive content ready"),
		).not.toBeInTheDocument();
	});
	it("recognizes explicit failure envelopes without treating ordinary text as a failure", () => {
		expect(
			effectiveToolStatus({
				status: "complete",
				result: '{"isError":true}',
			}),
		).toBe("error");
		expect(
			effectiveToolStatus({
				status: "success",
				result: { success: false },
			}),
		).toBe("error");
		expect(
			effectiveToolStatus({
				status: "complete",
				result: "The report discusses error rates.",
			}),
		).toBe("complete");
	});
});

it("preserves explicit failure classification above the former serialized envelope threshold", () => {
	const explanation = `Example connection error ${"x".repeat(16400)}`;
	const result = JSON.stringify({
		isError: true,
		content: [{ type: "text", text: explanation }],
	});
	expect(effectiveToolStatus({ status: "complete", result })).toBe("error");
	render(
		<ToolCallList
			groupActivity
			expandable={false}
			toolCalls={[
				{
					id: "example-large",
					name: "Read notes",
					args: {},
					status: "complete",
					result,
				},
			]}
		/>,
	);
	expect(screen.getByText(explanation)).toBeVisible();
});

it("keeps string-encoded authority requests visible outside routine activity", () => {
	render(
		<ToolCallList
			groupActivity
			toolCalls={[
				{
					id: "example-authority",
					name: "example_tool",
					args: {},
					status: "complete",
					result: JSON.stringify({
						authorityRequired: true,
						providerKey: "example-provider",
						hint: "Example permission is required",
					}),
				},
			]}
		/>,
	);
	expect(screen.getByText("Runtime authority required")).toBeVisible();
	expect(screen.getByText("Example permission is required")).toBeVisible();
});

it("does not show a success result panel for a completed error envelope", async () => {
	const user = userEvent.setup();
	render(
		<ToolCallList
			groupActivity
			toolCalls={[
				{
					id: "example-error",
					name: "example_tool",
					args: {},
					status: "complete",
					result: {
						isError: true,
						content: [
							{ type: "text", text: "Example tool failed" },
						],
					},
				},
			]}
		/>,
	);
	await user.click(screen.getByRole("button", { name: /example_tool/ }));
	expect(screen.getByText("Example tool failed")).toBeVisible();
	expect(screen.queryByText("Result")).not.toBeInTheDocument();
});
