import { describe, expect, it } from "vitest";
import {
	formatProjectContext,
	formatProjectContextCompact,
} from "../context-formatter";

const base = {
	name: "Booking",
	techStack: [],
	features: [],
	repositoryUrl: "https://github.com/example-org/booking-app",
	repositoryOwner: "example-org",
	repositoryName: "booking-app",
};

describe("project context: the repository's branch", () => {
	it("names the repository's own branch when it is known", () => {
		const ctx = { ...base, defaultBranch: "master" };

		expect(formatProjectContext(ctx)).toContain(
			"**Repository:** example-org/booking-app (branch: master)",
		);
		expect(formatProjectContextCompact(ctx)).toContain(
			"Repository: example-org/booking-app (master)",
		);
	});

	it("names no branch rather than inventing main when none is known", () => {
		const full = formatProjectContext(base);
		const compact = formatProjectContextCompact(base);

		expect(full).toContain("**Repository:** example-org/booking-app\n");
		expect(full).not.toContain("main");
		expect(compact).toContain("Repository: example-org/booking-app");
		expect(compact).not.toContain("(main)");
	});
});
