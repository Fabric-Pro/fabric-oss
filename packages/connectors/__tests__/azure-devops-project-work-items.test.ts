import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AzureDevOpsProjectReadError,
	azureDevOpsOrganization,
	getAzureDevOpsProjectWorkItemCounts,
	listAzureDevOpsProjectMembers,
} from "../src/azure-devops/project-work-items";

const target = { organization: "example-org", projectId: "example-project" };
const asOf = "2026-01-01T12:00:00.000Z";
const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
	});
const member = (id: string) => ({
	identity: {
		id,
		uniqueName: `${id}@example.com`,
		displayName: `Member ${id}`,
	},
});
const workItems = (length: number, offset = 0) =>
	Array.from({ length }, (_, index) => ({ id: offset + index + 1 }));
const count = (state = "Active", assignee?: string) =>
	getAzureDevOpsProjectWorkItemCounts(target, "example-pat", {
		state,
		assignee,
	});
const queries = () =>
	fetchMock.mock.calls.map(
		([, options]) => JSON.parse(String(options?.body)).query,
	);

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("fixed-origin Azure DevOps project reads", () => {
	it.each([".", "..", "team\u0000name"])(
		"refuses malformed provider team paths before member requests: %j",
		async (id) => {
			fetchMock.mockResolvedValueOnce(json({ value: [{ id }] }));
			await expect(
				listAzureDevOpsProjectMembers(target, "example-pat"),
			).rejects.toMatchObject({ code: "invalid_response" });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it.each([".", "..", "project\u0000name"])(
		"refuses stored project paths that normalize out of the route: %j",
		async (projectId) => {
			await expect(
				listAzureDevOpsProjectMembers(
					{ ...target, projectId },
					"example-pat",
				),
			).rejects.toMatchObject({ code: "invalid_response" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://other.example",
		"example/other",
		"..",
		"example?token=x",
		"example#x",
	])(
		"refuses invalid stored organizations before sending credentials: %s",
		async (organization) => {
			expect(azureDevOpsOrganization([organization])).toBeNull();
			await expect(
				listAzureDevOpsProjectMembers(
					{ ...target, organization },
					"example-pat",
				),
			).rejects.toBeInstanceOf(AzureDevOpsProjectReadError);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("paginates teams and members and includes zero-work members", async () => {
		const teamPage = Array.from({ length: 100 }, () => ({ id: "team-1" }));
		const memberPage = Array.from({ length: 100 }, () =>
			member("zero-work-member"),
		);
		fetchMock
			.mockResolvedValueOnce(json({ value: teamPage }))
			.mockResolvedValueOnce(json({ value: [{ id: "team-2" }] }))
			.mockResolvedValueOnce(json({ value: memberPage }))
			.mockResolvedValueOnce(json({ value: [member("other-member")] }))
			.mockResolvedValueOnce(
				json({ value: [member("zero-work-member")] }),
			);
		const result = await listAzureDevOpsProjectMembers(
			target,
			"example-pat",
		);
		expect(result).toMatchObject({
			complete: true,
			membershipScope: "project_teams",
		});
		expect(result.members.map((item) => item.id).sort()).toEqual([
			"other-member",
			"zero-work-member",
		]);
		const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
		expect(urls[1].searchParams.get("$skip")).toBe("100");
		expect(urls[3].searchParams.get("$skip")).toBe("100");
		expect(
			urls.every((url) => url.origin === "https://dev.azure.com"),
		).toBe(true);
		expect(
			fetchMock.mock.calls.every(
				([, options]) => options?.redirect === "error",
			),
		).toBe(true);
		expect(urls.some((url) => url.pathname.includes("wiql"))).toBe(false);
	});

	it("marks missing identity selection fields as incomplete", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ value: [{ id: "team-1" }] }))
			.mockResolvedValueOnce(
				json({
					value: [
						{
							identity: {
								id: "no-unique-name",
								displayName: "Unknown",
							},
						},
					],
				}),
			);
		expect(
			await listAzureDevOpsProjectMembers(target, "example-pat"),
		).toMatchObject({ members: [], complete: false });
	});

	it("excludes group and deleted identities from the member selector", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ value: [{ id: "team-1" }] }))
			.mockResolvedValueOnce(
				json({
					value: [
						{
							identity: {
								...member("group").identity,
								isContainer: true,
							},
						},
						{
							identity: {
								...member("deleted").identity,
								isDeletedInOrigin: true,
							},
						},
						member("active"),
					],
				}),
			);
		const result = await listAzureDevOpsProjectMembers(
			target,
			"example-pat",
		);
		expect(result.members.map((item) => item.id)).toEqual(["active"]);
		expect(result.complete).toBe(true);
	});

	it("bounds the roster when a provider ignores pagination", async () => {
		fetchMock.mockImplementation(async () =>
			json({
				value: Array.from({ length: 100 }, () => ({ id: "team-1" })),
			}),
		);
		expect(
			await listAzureDevOpsProjectMembers(target, "example-pat"),
		).toMatchObject({ complete: false });
		expect(fetchMock).toHaveBeenCalledTimes(40);
	});

	it("counts zero correctly at one snapshot", async () => {
		fetchMock.mockImplementation(async () => json({ asOf, workItems: [] }));
		expect(await count("In Development")).toEqual({
			state: "In Development",
			assignee: null,
			asOf,
			total: 0,
			matchingState: 0,
			complete: true,
			observed: { total: 0, matchingState: 0 },
		});
	});

	it("uses increasing IDs, quoted filters and one snapshot", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ asOf, workItems: workItems(2_000) }))
			.mockResolvedValueOnce(json({ asOf, workItems: [{ id: 2_001 }] }))
			.mockResolvedValueOnce(json({ asOf, workItems: [{ id: 1 }] }));
		expect(
			await count("Owner's review", "o'neil@example.com"),
		).toMatchObject({
			total: 2_001,
			matchingState: 1,
			complete: true,
			asOf,
		});
		const sent = queries();
		expect(sent[0]).toContain("[System.TeamProject] = @project");
		expect(sent[0]).toContain(
			'[System.AssignedTo] = "o\'neil@example.com"',
		);
		expect(sent[1]).toContain("[System.Id] > 2000");
		expect(sent[1]).toContain(`ASOF '${asOf}'`);
		expect(sent[2]).toContain('[System.State] = "Owner\'s review"');
		expect(sent[2]).toContain(`ASOF '${asOf}'`);
	});

	it("preserves seven-digit snapshot precision", async () => {
		const precise = "2026-01-01T12:00:00.0001234Z";
		fetchMock
			.mockResolvedValueOnce(
				json({ asOf: precise, workItems: [{ id: 1 }] }),
			)
			.mockResolvedValueOnce(json({ asOf: precise, workItems: [] }));
		expect(await count()).toMatchObject({
			asOf: precise,
			total: 1,
			matchingState: 0,
		});
		expect(queries()[1]).toContain(`ASOF '${precise}'`);
	});

	it("refuses responses that change the requested snapshot", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ asOf, workItems: [] }))
			.mockResolvedValueOnce(
				json({ asOf: "2026-01-01T12:00:01.000Z", workItems: [] }),
			);
		await expect(count()).rejects.toMatchObject({
			code: "invalid_response",
		});
	});

	it.each(["both'\"quotes", "line\nbreak", "control\u0000character"])(
		"refuses ambiguous or control-character filters before requests: %j",
		async (state) => {
			await expect(count(state)).rejects.toMatchObject({
				code: "invalid_filter",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("reports unfinished counts as null with observed lower bounds", async () => {
		let page = 0;
		fetchMock.mockImplementation(async () => {
			const offset = (page++ % 20) * 2_000;
			return json({ asOf, workItems: workItems(2_000, offset) });
		});
		expect(await count()).toMatchObject({
			total: null,
			matchingState: null,
			complete: false,
			observed: { total: 40_000, matchingState: 40_000 },
		});
		expect(fetchMock).toHaveBeenCalledTimes(40);
	});

	it.each([
		{ asOf, workItems: [{ id: 2 }, { id: 1 }] },
		{ asOf, workItems: [{ id: 1 }, { id: 1 }] },
		{ asOf: "not-a-date", workItems: [] },
		{ asOf },
	])(
		"rejects malformed counts instead of claiming exactness: %j",
		async (body) => {
			fetchMock.mockResolvedValueOnce(json(body));
			await expect(count()).rejects.toMatchObject({
				code: "invalid_response",
			});
		},
	);

	it.each([203, 401, 403, 500])(
		"sanitizes provider failure bodies: %s",
		async (status) => {
			fetchMock.mockResolvedValueOnce(
				new Response("private provider body: example-secret", {
					status,
				}),
			);
			const result = count();
			await expect(result).rejects.toThrow(AzureDevOpsProjectReadError);
			await expect(result).rejects.not.toThrow("example-secret");
		},
	);

	it("rejects successful-status HTML sign-in and sanitizes network failures", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("private sign-in body", {
				headers: { "content-type": "text/html" },
			}),
		);
		await expect(
			listAzureDevOpsProjectMembers(target, "example-pat"),
		).rejects.toMatchObject({ code: "authentication" });
		fetchMock.mockRejectedValueOnce(
			new Error("example-private-pat failed"),
		);
		await expect(
			listAzureDevOpsProjectMembers(target, "example-pat"),
		).rejects.toThrow(
			"Azure DevOps could not complete the project read. Try again.",
		);
	});
});
