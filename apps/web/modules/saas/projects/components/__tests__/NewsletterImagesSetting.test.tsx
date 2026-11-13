/**
 * "Images in highlights" and "Capture from": choosing an environment asks
 * for the sample-data confirmation before anything is saved; turning
 * automatic capture off does not.
 *
 * The Radix select is replaced by a native one (as in
 * AdoReviewInstructionFields.test.tsx), which jsdom can drive.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryData } = vi.hoisted(() => ({
	queryData: { environments: [] as unknown[] },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			environments: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "environments",
						...o,
					}),
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { enabled?: boolean }) => ({
		data: opts.enabled === false ? undefined : queryData.environments,
		isLoading: false,
	}),
}));

vi.mock("@ui/components/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
		disabled,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		children: ReactNode;
		disabled?: boolean;
	}) => (
		<select
			aria-label="Capture from"
			value={value}
			disabled={disabled}
			onChange={(event) => onValueChange(event.target.value)}
		>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({
		value,
		children,
	}: {
		value: string;
		children: ReactNode;
	}) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}));

import { NewsletterImagesSetting } from "../NewsletterImagesSetting";

const onChange = vi.fn();

function renderSetting(
	props: Partial<Parameters<typeof NewsletterImagesSetting>[0]> = {},
) {
	return render(
		<NewsletterImagesSetting
			projectId="p-1"
			screenshotsEnabled
			requireApproval
			screenshotEnvironmentId={null}
			disabled={false}
			onChange={onChange}
			{...props}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	queryData.environments = [
		{ id: "env-1", name: "Staging", type: "STAGING" },
	];
});

describe("NewsletterImagesSetting", () => {
	it("hides the capture environment while images are off", () => {
		renderSetting({ screenshotsEnabled: false });

		expect(
			screen.queryByRole("combobox", { name: "Capture from" }),
		).not.toBeInTheDocument();
	});

	it("lists the project's environments to capture from", () => {
		renderSetting();

		const select = screen.getByRole("combobox", { name: "Capture from" });
		expect(
			within(select).getByRole("option", {
				name: "Don't capture automatically",
			}),
		).toBeInTheDocument();
		expect(
			within(select).getByRole("option", { name: "Staging" }),
		).toBeInTheDocument();
	});

	it("asks for the sample-data confirmation before saving an environment", () => {
		renderSetting();

		fireEvent.change(
			screen.getByRole("combobox", { name: "Capture from" }),
			{
				target: { value: "env-1" },
			},
		);

		expect(onChange).not.toHaveBeenCalled();
		const dialog = screen.getByRole("alertdialog");
		const use = within(dialog).getByRole("button", {
			name: "Use this environment",
		});
		expect(use).toBeDisabled();

		fireEvent.click(
			within(dialog).getByRole("checkbox", {
				name: "This environment shows sample data only",
			}),
		);
		fireEvent.click(use);

		expect(onChange).toHaveBeenCalledWith({
			screenshotEnvironmentId: "env-1",
			screenshotSampleDataConfirmed: true,
		});
	});

	it("saves nothing when the confirmation is cancelled", () => {
		renderSetting();

		fireEvent.change(
			screen.getByRole("combobox", { name: "Capture from" }),
			{
				target: { value: "env-1" },
			},
		);
		fireEvent.click(
			within(screen.getByRole("alertdialog")).getByRole("button", {
				name: "Cancel",
			}),
		);

		expect(onChange).not.toHaveBeenCalled();
	});

	it("turns automatic capture off without a confirmation", () => {
		renderSetting({ screenshotEnvironmentId: "env-1" });

		fireEvent.change(
			screen.getByRole("combobox", { name: "Capture from" }),
			{
				target: { value: "none" },
			},
		);

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(onChange).toHaveBeenCalledWith({
			screenshotEnvironmentId: null,
		});
	});

	it("points to the environment settings when the project has none", () => {
		queryData.environments = [];
		renderSetting();

		expect(
			screen.getByText(
				"Add an environment under Settings, Environments to capture screenshots from it.",
			),
		).toBeInTheDocument();
	});
});
