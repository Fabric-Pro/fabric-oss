import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	mutate: vi.fn(),
	push: vi.fn(),
	invalidate: vi.fn(),
	success: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("sonner", () => ({
	toast: { success: m.success, info: m.info, error: m.error },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			instances: {
				list: { key: () => ["reports", "instances", "list"] },
				generateFromTemplate: { mutationOptions: () => ({}) },
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: m.mutate }),
	useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));

import { useOneClickReport } from "@saas/reports/hooks/use-one-click-report";

const template = { id: "example-template", name: "Example status" };

const STARTED = {
	outcome: "started",
	instanceId: "report-1",
	executionId: "run-1",
	startConfirmed: true,
};
const REFUSED = {
	outcome: "refused",
	instanceId: "report-1",
	reason: "Example server could not be reached.",
};

function settleWith(result: unknown) {
	m.mutate.mockImplementation((_input, handlers) => {
		handlers.onSuccess(result);
	});
}

function clickGenerate(onNeedsSetup = vi.fn()) {
	const { result } = renderHook(() =>
		useOneClickReport<typeof template>({
			projectId: "example-project",
			organizationId: "example-org",
			reportTemplatesPath: "/app/example-org/report-templates",
			onNeedsSetup,
		}),
	);
	act(() => result.current.generate(template));
	return { result, onNeedsSetup };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("useOneClickReport", () => {
	it("asks the server for this template in this project", () => {
		settleWith({ outcome: "needs-setup", missing: [] });

		clickGenerate();

		expect(m.mutate.mock.calls[0][0]).toEqual({
			templateId: "example-template",
			projectId: "example-project",
			organizationId: "example-org",
		});
	});

	it("opens the run history when the run started", () => {
		settleWith(STARTED);

		const { onNeedsSetup } = clickGenerate();

		expect(m.success).toHaveBeenCalled();
		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/report-templates/instances/report-1?tab=history",
		);
		expect(m.invalidate).toHaveBeenCalled();
		expect(onNeedsSetup).not.toHaveBeenCalled();
	});

	it("says the run is queued when its start is not confirmed yet", () => {
		settleWith({ ...STARTED, startConfirmed: false });

		clickGenerate();

		expect(m.info).toHaveBeenCalled();
		expect(m.success).not.toHaveBeenCalled();
	});

	it("opens the dialog when something is missing, and moves nowhere", () => {
		settleWith({ outcome: "needs-setup", missing: ["Connect a tool"] });

		const { onNeedsSetup } = clickGenerate();

		expect(onNeedsSetup).toHaveBeenCalledWith(template);
		expect(m.push).not.toHaveBeenCalled();
	});

	it("routes a refusal to the report, with the reason kept on screen", () => {
		settleWith(REFUSED);

		clickGenerate();

		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/report-templates/instances/report-1",
		);
		expect(m.error).toHaveBeenCalledWith(
			expect.stringContaining("Example server could not be reached."),
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			}),
		);
	});

	it.each([
		["started", STARTED],
		["refused", REFUSED],
	])(
		"stays pending until the route changes when the run is %s",
		(_name, outcome) => {
			settleWith(outcome);

			const { result } = clickGenerate();

			expect(result.current.generatingTemplateId).toBe(
				"example-template",
			);
			act(() => result.current.generate(template));
			expect(m.mutate).toHaveBeenCalledTimes(1);
		},
	);

	it("ignores a second click while the first is on its way", () => {
		m.mutate.mockImplementation(() => {});

		const { result } = clickGenerate();
		expect(result.current.generatingTemplateId).toBe("example-template");

		act(() => result.current.generate(template));

		expect(m.mutate).toHaveBeenCalledTimes(1);
	});

	it("clears the mark when the dialog takes over, and allows another click", () => {
		settleWith({ outcome: "needs-setup", missing: [] });

		const { result } = clickGenerate();
		expect(result.current.generatingTemplateId).toBeNull();

		act(() => result.current.generate(template));
		expect(m.mutate).toHaveBeenCalledTimes(2);
	});

	it("shows a failed request, moves nowhere and allows another click", () => {
		m.mutate.mockImplementation((_input, handlers) => {
			handlers.onError(new Error("Example refusal"));
		});

		const { result } = clickGenerate();

		expect(m.error).toHaveBeenCalledWith("Example refusal");
		expect(m.push).not.toHaveBeenCalled();
		expect(result.current.generatingTemplateId).toBeNull();

		act(() => result.current.generate(template));
		expect(m.mutate).toHaveBeenCalledTimes(2);
	});
});
