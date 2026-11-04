import en from "@repo/i18n/translations/en.json";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	save: vi.fn(),
	disable: vi.fn(),
	delete: vi.fn(),
	onSaved: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		contextQuality: {
			bindings: {
				get: m.get,
				save: m.save,
				disable: m.disable,
				delete: m.delete,
			},
		},
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		(en.projects.contexts.quality.setup as Record<string, string>)[key] ??
		key,
}));

import { ContextQualitySettings } from "../ContextQualitySettings";

const copy = en.projects.contexts.quality.setup;
const binding = {
	id: "example-binding",
	integrationId: "example-connection",
	workspaceOrigin: "https://example.cloud.databricks.com",
	jobId: "123",
	experimentId: "456",
	volumeRoot: "/Volumes/example_catalog/example_schema/example_volume",
	enabled: true,
};
const configuration = {
	binding,
	connections: [{ id: "example-connection", name: "Example connection" }],
};
const scope = { projectId: "example-project", organizationId: "example-org" };

async function setup() {
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(
			<ContextQualitySettings {...scope} onSaved={m.onSaved} />,
		);
	});
	return view;
}

function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise((accept, refuse) => {
		resolve = accept;
		reject = refuse;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.resetAllMocks();
	m.get.mockResolvedValue(configuration);
	m.save.mockResolvedValue(configuration);
	m.disable.mockResolvedValue({
		...configuration,
		binding: { ...binding, enabled: false },
	});
	m.delete.mockResolvedValue({ deleted: true });
});

it("requires explicit export approval and resets consent after a destination change", async () => {
	await setup();
	const button = screen.getByRole("button", { name: copy.save });
	expect(button).toBeDisabled();
	fireEvent.click(screen.getByRole("checkbox", { name: copy.approval }));
	expect(button).toBeEnabled();
	fireEvent.change(screen.getByLabelText(copy.job), {
		target: { value: "124" },
	});
	expect(button).toBeDisabled();
	fireEvent.click(screen.getByRole("checkbox", { name: copy.approval }));
	await act(async () => {
		fireEvent.click(button);
	});
	expect(m.save).toHaveBeenCalledWith({
		...scope,
		integrationId: binding.integrationId,
		workspaceOrigin: binding.workspaceOrigin,
		experimentId: binding.experimentId,
		volumeRoot: binding.volumeRoot,
		enabled: true,
		exportApproved: true,
		jobId: "124",
	});
	expect(screen.getByRole("status")).toHaveTextContent(copy.saved);
	expect(m.onSaved).toHaveBeenCalledTimes(1);
});

it("does not leak provider failure text into the setup error", async () => {
	m.get.mockRejectedValue(new Error("Example confidential provider detail"));
	await setup();
	expect(screen.getByRole("alert")).toHaveTextContent(copy.error);
	expect(
		screen.queryByText("Example confidential provider detail"),
	).not.toBeInTheDocument();
});

it("offers reload only for a failed settings load", async () => {
	m.get.mockRejectedValueOnce(
		new Error("Example confidential provider detail"),
	);
	await setup();
	expect(screen.queryByLabelText(copy.job)).not.toBeInTheDocument();
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: copy.retry }));
	});
	expect(m.get).toHaveBeenCalledTimes(2);
	expect(screen.getByLabelText(copy.job)).toHaveValue("123");
	expect(
		screen.queryByRole("button", { name: copy.retry }),
	).not.toBeInTheDocument();
});

it("discards an old project's delayed configuration response", async () => {
	const response = deferred();
	m.get.mockReturnValueOnce(response.promise);
	const view = render(
		<ContextQualitySettings
			projectId="example-old"
			organizationId="example-org"
			onSaved={m.onSaved}
		/>,
	);
	await act(async () => {
		view.rerender(
			<ContextQualitySettings {...scope} onSaved={m.onSaved} />,
		);
	});
	await act(async () => {
		response.resolve({
			binding: { ...binding, jobId: "999" },
			connections: [],
		});
	});
	expect(screen.getByLabelText(copy.job)).toHaveValue("123");
});

it("disables locally without approval, valid destination fields or an available connection", async () => {
	m.get.mockResolvedValue({ ...configuration, connections: [] });
	await setup();
	fireEvent.change(screen.getByLabelText(copy.workspace), {
		target: { value: "not a URL" },
	});
	fireEvent.change(screen.getByLabelText(copy.job), {
		target: { value: "" },
	});
	fireEvent.change(screen.getByLabelText(copy.experiment), {
		target: { value: "-1" },
	});
	fireEvent.change(screen.getByLabelText(copy.volume), {
		target: { value: "" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: copy.enabled }));
	expect(
		screen.getByRole("checkbox", { name: copy.approval }),
	).not.toBeChecked();
	expect(
		screen.getByRole("combobox", { name: copy.connection }),
	).toBeDisabled();
	for (const label of [
		copy.workspace,
		copy.job,
		copy.experiment,
		copy.volume,
	]) {
		expect(screen.getByLabelText(label)).toBeDisabled();
		expect(screen.getByLabelText(label)).not.toBeRequired();
	}
	expect(screen.getByLabelText(copy.job)).not.toHaveAttribute("pattern");
	expect(screen.getByLabelText(copy.experiment)).not.toHaveAttribute(
		"pattern",
	);
	const button = screen.getByRole("button", { name: copy.disable });
	expect(button).toBeEnabled();
	expect(button).toHaveAttribute("formnovalidate");
	await act(async () => {
		fireEvent.click(button);
	});
	expect(m.disable).toHaveBeenCalledExactlyOnceWith(scope);
	expect(m.save).not.toHaveBeenCalled();
	expect(m.delete).not.toHaveBeenCalled();
	expect(m.get).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("status")).toHaveTextContent(copy.disabled);
	expect(m.onSaved).toHaveBeenCalledTimes(1);
});

it("shows pending and safe failure states for local revocation without reloading edits", async () => {
	const response = deferred();
	m.disable.mockReturnValueOnce(response.promise);
	await setup();
	fireEvent.change(screen.getByLabelText(copy.job), {
		target: { value: "124" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: copy.enabled }));
	fireEvent.click(screen.getByRole("button", { name: copy.disable }));
	expect(screen.getByRole("button", { name: copy.disabling })).toBeDisabled();
	expect(screen.getByRole("checkbox", { name: copy.enabled })).toBeDisabled();
	await act(async () => {
		response.reject(new Error("Example confidential provider detail"));
	});
	expect(screen.getByRole("alert")).toHaveTextContent(copy.disableError);
	expect(
		screen.queryByText("Example confidential provider detail"),
	).not.toBeInTheDocument();
	expect(screen.getByLabelText(copy.job)).toHaveValue("124");
	expect(
		screen.getByRole("checkbox", { name: copy.enabled }),
	).not.toBeChecked();
	expect(screen.getByRole("button", { name: copy.disable })).toBeEnabled();
	expect(
		screen.queryByRole("button", { name: copy.retry }),
	).not.toBeInTheDocument();
	expect(m.onSaved).not.toHaveBeenCalled();
	expect(m.get).toHaveBeenCalledTimes(1);
});

it("retains all edits and explicit approval after a save refusal without a reload action", async () => {
	m.get.mockResolvedValue({
		...configuration,
		connections: [
			...configuration.connections,
			{
				id: "example-other-connection",
				name: "Other example connection",
			},
		],
	});
	m.save.mockRejectedValue({
		code: "PRECONDITION_FAILED",
		message: "Example confidential provider detail",
	});
	const user = userEvent.setup();
	await setup();
	await user.click(screen.getByRole("combobox", { name: copy.connection }));
	await user.click(
		screen.getByRole("option", { name: "Other example connection" }),
	);
	const edits = [
		[copy.workspace, "https://example-other.cloud.databricks.com"],
		[copy.job, "789"],
		[copy.experiment, "987"],
		[copy.volume, "/Volumes/example_other/example_schema/example_volume"],
	] as const;
	for (const [label, value] of edits) {
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	}
	fireEvent.click(screen.getByRole("checkbox", { name: copy.approval }));
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: copy.save }));
	});
	expect(screen.getByRole("alert")).toHaveTextContent(
		copy.errorQualification,
	);
	expect(
		screen.queryByText("Example confidential provider detail"),
	).not.toBeInTheDocument();
	for (const [label, value] of edits) {
		expect(screen.getByLabelText(label)).toHaveValue(value);
	}
	expect(
		screen.getByRole("combobox", { name: copy.connection }),
	).toHaveTextContent("Other example connection");
	expect(screen.getByRole("checkbox", { name: copy.approval })).toBeChecked();
	expect(screen.getByRole("button", { name: copy.save })).toBeEnabled();
	expect(
		screen.queryByRole("button", { name: copy.retry }),
	).not.toBeInTheDocument();
	expect(m.get).toHaveBeenCalledTimes(1);
	expect(m.onSaved).not.toHaveBeenCalled();
});

it.each([
	["FORBIDDEN", copy.errorDenied],
	["UNAUTHORIZED", copy.errorDenied],
	["NOT_FOUND", copy.errorUnavailable],
	["BAD_REQUEST", copy.errorInvalid],
	["CONFLICT", copy.errorConflict],
	["INTERNAL_SERVER_ERROR", copy.saveError],
	[undefined, copy.saveError],
] as const)("uses safe local save error text for %s", async (code, message) => {
	m.save.mockRejectedValue({
		code,
		message: "Example confidential provider detail",
	});
	await setup();
	fireEvent.click(screen.getByRole("checkbox", { name: copy.approval }));
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: copy.save }));
	});
	expect(screen.getByRole("alert")).toHaveTextContent(message);
	expect(
		screen.queryByText("Example confidential provider detail"),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: copy.retry }),
	).not.toBeInTheDocument();
});

it.each([copy.job, copy.experiment])(
	"rejects unsafe or non-positive decimal %s values before save",
	async (label) => {
		await setup();
		for (const value of [
			"0",
			"-1",
			"1.5",
			"1e3",
			"01",
			"9007199254740992",
		]) {
			fireEvent.change(screen.getByLabelText(label), {
				target: { value },
			});
			fireEvent.click(
				screen.getByRole("checkbox", { name: copy.approval }),
			);
			// Submit directly to also prove the handler protects callers bypassing native validation.
			const form = screen
				.getByRole("button", { name: copy.save })
				.closest("form");
			expect(form).not.toBeNull();
			await act(async () => {
				fireEvent.submit(form!);
			});
			expect(screen.getByRole("alert")).toHaveTextContent(
				copy.invalidIds,
			);
			expect(screen.getByLabelText(label)).toHaveValue(value);
			expect(m.save).not.toHaveBeenCalled();
		}
	},
);

it("accepts positive decimal IDs through Number.MAX_SAFE_INTEGER", async () => {
	await setup();
	fireEvent.change(screen.getByLabelText(copy.job), {
		target: { value: "9007199254740991" },
	});
	fireEvent.change(screen.getByLabelText(copy.experiment), {
		target: { value: "1" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: copy.approval }));
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: copy.save }));
	});
	expect(m.save).toHaveBeenCalledWith(
		expect.objectContaining({
			jobId: "9007199254740991",
			experimentId: "1",
		}),
	);
});

it("requires an explicit destructive confirmation and preserves edits on cancel", async () => {
	await setup();
	fireEvent.change(screen.getByLabelText(copy.job), {
		target: { value: "124" },
	});
	fireEvent.click(screen.getByRole("button", { name: copy.disconnect }));
	const dialog = screen.getByRole("alertdialog", { name: copy.deleteTitle });
	expect(dialog).toHaveAccessibleDescription(copy.deleteDescription);
	expect(m.delete).not.toHaveBeenCalled();
	fireEvent.click(within(dialog).getByRole("button", { name: copy.cancel }));
	expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	expect(screen.getByLabelText(copy.job)).toHaveValue("124");
	expect(m.delete).not.toHaveBeenCalled();
	expect(m.get).toHaveBeenCalledTimes(1);
	expect(m.onSaved).not.toHaveBeenCalled();
});

it("reloads only after a confirmed unlink succeeds", async () => {
	const response = deferred();
	m.delete.mockReturnValueOnce(response.promise);
	await setup();
	fireEvent.click(screen.getByRole("button", { name: copy.disconnect }));
	fireEvent.click(screen.getByRole("button", { name: copy.confirmDelete }));
	expect(m.delete).toHaveBeenCalledExactlyOnceWith({
		...scope,
		confirmHistoryDeletion: true,
	});
	expect(screen.getByRole("button", { name: copy.deleting })).toBeDisabled();
	expect(screen.getByRole("button", { name: copy.cancel })).toBeDisabled();
	expect(m.get).toHaveBeenCalledTimes(1);
	m.get.mockResolvedValue({ ...configuration, binding: null });
	await act(async () => {
		response.resolve({ deleted: true });
	});
	expect(m.get).toHaveBeenCalledTimes(2);
	expect(m.get).toHaveBeenLastCalledWith(scope);
	expect(m.onSaved).toHaveBeenCalledTimes(1);
	expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: copy.disconnect }),
	).not.toBeInTheDocument();
	expect(screen.getByLabelText(copy.job)).toHaveValue("");
	expect(m.save).not.toHaveBeenCalled();
	expect(m.disable).not.toHaveBeenCalled();
});

it.each([
	["CONFLICT", copy.deleteBlocked],
	["FORBIDDEN", copy.errorDenied],
	["INTERNAL_SERVER_ERROR", copy.deleteError],
] as const)(
	"keeps binding, history and edits on unlink failure %s without reloading",
	async (code, message) => {
		m.delete.mockRejectedValue({
			code,
			message: "Example confidential provider detail",
		});
		await setup();
		fireEvent.change(screen.getByLabelText(copy.job), {
			target: { value: "124" },
		});
		fireEvent.click(screen.getByRole("checkbox", { name: copy.approval }));
		fireEvent.click(screen.getByRole("button", { name: copy.disconnect }));
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: copy.confirmDelete }),
			);
		});
		const dialog = screen.getByRole("alertdialog", {
			name: copy.deleteTitle,
		});
		expect(within(dialog).getByRole("alert")).toHaveTextContent(message);
		expect(
			screen.queryByText("Example confidential provider detail"),
		).not.toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: copy.confirmDelete }),
		).toBeEnabled();
		expect(m.get).toHaveBeenCalledTimes(1);
		expect(m.onSaved).not.toHaveBeenCalled();
		fireEvent.click(
			within(dialog).getByRole("button", { name: copy.cancel }),
		);
		expect(screen.getByLabelText(copy.job)).toHaveValue("124");
		expect(
			screen.getByRole("checkbox", { name: copy.approval }),
		).toBeChecked();
		expect(
			screen.getByRole("button", { name: copy.disconnect }),
		).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: copy.retry }),
		).not.toBeInTheDocument();
	},
);

it.each(
	(["save", "disable", "delete"] as const).flatMap((operation) =>
		(["projectId", "organizationId"] as const).flatMap((changedScope) =>
			(["resolve", "reject"] as const).map((outcome) => ({
				operation,
				changedScope,
				outcome,
			})),
		),
	),
)(
	"ignores late $operation $outcome after $changedScope changes",
	async ({ operation, changedScope, outcome }) => {
		const response = deferred();
		m[operation].mockReturnValueOnce(response.promise);
		const view = await setup();
		if (operation === "save") {
			fireEvent.click(
				screen.getByRole("checkbox", { name: copy.approval }),
			);
			fireEvent.click(screen.getByRole("button", { name: copy.save }));
		} else if (operation === "disable") {
			fireEvent.click(
				screen.getByRole("checkbox", { name: copy.enabled }),
			);
			fireEvent.click(screen.getByRole("button", { name: copy.disable }));
		} else {
			fireEvent.click(
				screen.getByRole("button", { name: copy.disconnect }),
			);
			fireEvent.click(
				screen.getByRole("button", { name: copy.confirmDelete }),
			);
		}
		expect(m[operation]).toHaveBeenCalledTimes(1);
		m.get.mockResolvedValue({
			...configuration,
			binding: { ...binding, jobId: "777" },
		});
		await act(async () => {
			view.rerender(
				<ContextQualitySettings
					{...scope}
					{...{ [changedScope]: "example-other-scope" }}
					onSaved={m.onSaved}
				/>,
			);
		});
		await act(async () => {
			if (outcome === "resolve") {
				response.resolve(
					operation === "delete" ? { deleted: true } : configuration,
				);
			} else {
				response.reject({
					code: "CONFLICT",
					message: "Example confidential provider detail",
				});
			}
		});
		expect(screen.getByLabelText(copy.job)).toHaveValue("777");
		expect(
			screen.getByRole("checkbox", { name: copy.enabled }),
		).toBeChecked();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.retry }),
		).not.toBeInTheDocument();
		expect(m.onSaved).not.toHaveBeenCalled();
		expect(m.get).toHaveBeenCalledTimes(2);
	},
);
