import { afterEach, expect, it, vi } from "vitest";
import { orchestratorApprovalProtocol } from "../src/lib/approval-rollout";

afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "false", "TRUE", "1", "true"])(
	"opts in only for exact true: %s",
	(value) => {
		vi.stubEnv("ORCHESTRATOR_APPROVAL_UPDATES_ENABLED", value);
		expect(orchestratorApprovalProtocol()).toEqual(
			value === "true" ? { approvalProtocol: 2 } : {},
		);
	},
);
