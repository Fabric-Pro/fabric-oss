import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
vi.mock("../prisma/client", () => ({
	db: {
		workflowIntegration: {
			findFirst: (args: unknown) => findFirstMock(args),
		},
	},
}));
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
}));

import { fetchCredentialsById } from "../prisma/queries/workflows/credential-fetcher";

function clickUpRow(config: Record<string, string>) {
	return {
		id: "int-1",
		provider: "CLICKUP",
		isActive: true,
		credentials: `enc:${JSON.stringify(config)}`,
	};
}

describe("CLICKUP credential mapper", () => {
	beforeEach(() => findFirstMock.mockReset());

	it("maps the token saved by the ClickUp form", async () => {
		findFirstMock.mockResolvedValue(
			clickUpRow({ apiToken: "clickup-token", teamId: "team-1" }),
		);

		expect(await fetchCredentialsById("int-1", "user-1")).toMatchObject({
			CLICKUP_API_TOKEN: "clickup-token",
			CLICKUP_TEAM_ID: "team-1",
		});
	});

	it("still maps an apiKey-only row", async () => {
		findFirstMock.mockResolvedValue(clickUpRow({ apiKey: "legacy-key" }));

		expect(await fetchCredentialsById("int-1", "user-1")).toMatchObject({
			CLICKUP_API_TOKEN: "legacy-key",
		});
	});
});
