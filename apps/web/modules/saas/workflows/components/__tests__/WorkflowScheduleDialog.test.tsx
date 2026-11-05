import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	data: undefined as any,
	pending: false,
	fetching: false,
	error: false,
	save: vi.fn(),
	transition: vi.fn(),
	pause: vi.fn(),
	resume: vi.fn(),
	refetch: vi.fn(),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			schedule: {
				get: { queryOptions: () => ({}), key: () => ["schedule"] },
				configure: {
					mutationOptions: (options: unknown) => ({
						...(options as object),
						kind: "save",
					}),
				},
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { workflows: { pause: m.pause, resume: m.resume } },
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useQuery: () => ({
		data: m.data,
		isPending: m.pending,
		isFetching: m.fetching,
		isError: m.error,
		refetch: m.refetch,
	}),
	useMutation: (options: any) => ({
		isPending: false,
		isSuccess: false,
		mutate:
			options.kind === "save"
				? m.save
				: (intent: unknown) => options.mutationFn(intent),
	}),
}));

import { WorkflowScheduleDialog } from "../WorkflowScheduleDialog";

const props = {
	open: true,
	onOpenChange: vi.fn(),
	workflowId: "example-workflow",
	organizationId: "example-org",
};
beforeEach(() => {
	vi.clearAllMocks();
	m.pending = false;
	m.fetching = false;
	m.error = false;
	m.data = {
		state: "active",
		status: "PUBLISHED",
		draft: { cron: "0 9 * * 1", timezone: "UTC" },
		published: { description: "Every Monday at 09:00 UTC" },
		nextRunAt: "2026-01-05T09:00:00Z",
	};
});
it("shows actual live state and saves the selected cadence as a draft only", () => {
	render(<WorkflowScheduleDialog {...props} />);
	expect(screen.getByText("Schedule active")).toBeVisible();
	expect(screen.getByText(/Next run/)).toBeVisible();
	fireEvent.change(screen.getByLabelText("Time zone"), {
		target: { value: "Europe/Berlin" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Save schedule draft" }),
	);
	expect(m.save).toHaveBeenCalledWith({
		workflowId: props.workflowId,
		organizationId: props.organizationId,
		cron: "0 9 * * 1",
		timezone: "Europe/Berlin",
	});
	expect(m.pause).not.toHaveBeenCalled();
	expect(m.resume).not.toHaveBeenCalled();
});
it("retains typed edits when a background schedule refresh arrives", () => {
	const ui = render(<WorkflowScheduleDialog {...props} />);
	fireEvent.change(screen.getByLabelText("Time zone"), {
		target: { value: "Europe/Berlin" },
	});
	m.data = { ...m.data, draft: { cron: "0 9 * * *", timezone: "UTC" } };
	ui.rerender(<WorkflowScheduleDialog {...props} />);
	expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Berlin");
});
it.each(["PUBLISHED", "PAUSED"])(
	"uses the explicit future-trigger control for %s",
	(status) => {
		m.data.status = status;
		render(<WorkflowScheduleDialog {...props} />);
		fireEvent.click(
			screen.getByRole("button", {
				name:
					status === "PAUSED" ? "Resume triggers" : "Pause triggers",
			}),
		);
		expect(status === "PAUSED" ? m.resume : m.pause).toHaveBeenCalledWith({
			workflowId: props.workflowId,
			organizationId: props.organizationId,
		});
		expect(screen.getByText(/Current runs keep their state/)).toBeVisible();
	},
);
it("does not let a failed schedule read overwrite the draft", () => {
	m.error = true;
	render(<WorkflowScheduleDialog {...props} />);
	expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
	expect(
		screen.getByRole("button", { name: "Save schedule draft" }),
	).toBeDisabled();
});
it("waits for a fresh read before exposing cached draft settings", () => {
	m.fetching = true;
	const ui = render(<WorkflowScheduleDialog {...props} />);
	expect(screen.getByRole("status")).toHaveTextContent("Checking schedule");
	expect(
		screen.getByRole("button", { name: "Save schedule draft" }),
	).toBeDisabled();
	m.fetching = false;
	m.data = {
		...m.data,
		draft: { cron: "0 9 * * *", timezone: "Europe/Berlin" },
	};
	ui.rerender(<WorkflowScheduleDialog {...props} />);
	expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Berlin");
});
it.each(["PUBLISHED", "PAUSED"])(
	"retries synchronization without reversing %s intent",
	(status) => {
		m.data = {
			...m.data,
			status,
			state: status === "PUBLISHED" ? "missing" : "out-of-sync",
		};
		render(<WorkflowScheduleDialog {...props} />);
		fireEvent.click(
			screen.getByRole("button", { name: "Retry synchronization" }),
		);
		expect(
			status === "PUBLISHED" ? m.resume : m.pause,
		).toHaveBeenCalledWith({
			workflowId: props.workflowId,
			organizationId: props.organizationId,
		});
	},
);
it("labels next-run time with the published zone even when the draft zone differs", () => {
	m.data = {
		...m.data,
		draft: { cron: "0 9 * * 1", timezone: "Europe/Berlin" },
		published: {
			timezone: "UTC",
			description: "Every Monday at 09:00 UTC",
		},
	};
	render(<WorkflowScheduleDialog {...props} />);
	expect(screen.getByText(/Next run:/)).toHaveTextContent(/UTC/);
});
it("explains why scheduling cannot silently replace a webhook", () => {
	m.data = {
		...m.data,
		configurationIssue:
			"This workflow starts from a webhook. Duplicate it to create a scheduled workflow.",
	};
	render(<WorkflowScheduleDialog {...props} />);
	expect(
		screen.getByRole("button", { name: "Save schedule draft" }),
	).toBeDisabled();
	expect(screen.getByLabelText("Time zone")).toBeDisabled();
	expect(screen.getByText(/Duplicate it to create/)).toBeVisible();
});
