import { describe, expect, it } from "vitest";
import { createReportExecutionRequests } from "../report-execution-request";

describe("one manual report occurrence", () => {
	it("prevents a double click before React updates", () => {
		const requests = createReportExecutionRequests(() => "request-1");
		expect(requests.begin("report-1")).toBe("request-1");
		expect(requests.begin("report-1")).toBeNull();
	});
	it("keeps the identity and pending fence after an unconfirmed admitted start", () => {
		const requests = createReportExecutionRequests(() => "request-1");
		requests.begin("report-1");
		requests.settle("report-1", "PENDING");
		expect(requests.isPending("report-1")).toBe(true);
		expect(requests.begin("report-1")).toBeNull();
	});
	it("retries an uncertain HTTP failure with the original key", () => {
		let counter = 0;
		const requests = createReportExecutionRequests(
			() => `request-${++counter}`,
		);
		const first = requests.begin("report-1");
		requests.failed("report-1");
		expect(requests.begin("report-1")).toBe(first);
		expect(counter).toBe(1);
	});
	it("allows a deliberate new occurrence only after observing a terminal result", () => {
		let counter = 0;
		const requests = createReportExecutionRequests(
			() => `request-${++counter}`,
		);
		requests.begin("report-1");
		requests.settle("report-1", "RUNNING");
		requests.observe("report-1", "RUNNING");
		expect(requests.begin("report-1")).toBeNull();
		requests.observe("report-1", "COMPLETED");
		expect(requests.begin("report-1")).toBe("request-2");
	});
	it("keeps separate identities for different reports", () => {
		let counter = 0;
		const requests = createReportExecutionRequests(
			() => `request-${++counter}`,
		);
		expect(requests.begin("report-1")).toBe("request-1");
		expect(requests.begin("report-2")).toBe("request-2");
	});
});
