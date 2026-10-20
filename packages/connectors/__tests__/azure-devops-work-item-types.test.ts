import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAzureDevOpsWorkItemTypes } from "../src/azure-devops/work-item-types";

const target = { organization: "example-org", projectId: "project-1" };
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});
const type = { name: "Bug", referenceName: "Example.WorkItemTypes.Bug" };
const discover = () => listAzureDevOpsWorkItemTypes(target, "example-pat");

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	fetchMock.mockResolvedValueOnce(
		json({ id: "project-1", name: "Example Project" }),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("bounded connected-project type discovery", () => {
	it("returns actual enabled names only, using fixed-origin GET with redirects refused", async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				count: 2,
				value: [
					{
						...type,
						xmlForm: "<FORM>private</FORM>",
						fields: [{ name: "private" }],
					},
					{
						name: "Disabled",
						referenceName: "Example.Disabled",
						isDisabled: true,
					},
				],
			}),
		);
		expect(await discover()).toEqual({
			workItemTypes: [type],
			complete: true,
			incompleteReason: null,
		});
		const [url, options] = fetchMock.mock.calls[1];
		expect(String(url)).toBe(
			"https://dev.azure.com/example-org/project-1/_apis/wit/workitemtypes?api-version=7.1",
		);
		expect(options).toMatchObject({ method: "GET", redirect: "error" });
	});

	it.each([
		{ count: 2, value: [type] },
		{ count: 1, value: [{ ...type, referenceName: "" }] },
		{ count: 1, value: [{ ...type, name: " " }] },
		{ count: 1, value: [{ ...type, name: "<FORM>" }] },
		{ count: 1, value: [{ ...type, name: "x".repeat(129) }] },
	])(
		"marks malformed or incomplete metadata incomplete without inventing options",
		async (body) => {
			fetchMock.mockResolvedValueOnce(json(body));
			expect(await discover()).toEqual({
				workItemTypes: [],
				complete: false,
				incompleteReason: "invalid_response",
			});
		},
	);

	it("bounds the actual type count", async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				count: 101,
				value: Array.from({ length: 101 }, () => type),
			}),
		);
		expect(await discover()).toMatchObject({
			workItemTypes: [],
			complete: false,
			incompleteReason: "item_limit",
		});
	});

	it("bounds the response body before decoding metadata", async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				count: 1,
				value: [{ ...type, xmlForm: "x".repeat(2 * 1024 * 1024) }],
			}),
		);
		expect(await discover()).toMatchObject({
			complete: false,
			incompleteReason: "response_limit",
		});
	});

	it.each([401, 403])(
		"keeps authentication/permission failures explicit: %s",
		async (status) => {
			fetchMock.mockResolvedValueOnce(new Response("", { status }));
			await expect(discover()).rejects.toMatchObject({
				code: status === 401 ? "authentication" : "permission",
			});
		},
	);

	it("does not follow a redirect or forward credentials to its target", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("", {
				status: 302,
				headers: { location: "https://other.example/types" },
			}),
		);
		expect(await discover()).toMatchObject({
			complete: false,
			incompleteReason: "unavailable",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][1]?.redirect).toBe("error");
	});

	it("rejects a different canonical project before loading types", async () => {
		fetchMock
			.mockReset()
			.mockResolvedValueOnce(
				json({ id: "other-project", name: "Other Project" }),
			);
		await expect(discover()).rejects.toMatchObject({
			code: "project_mismatch",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects URL-shaped organizations before credentialed requests", async () => {
		fetchMock.mockReset();
		await expect(
			listAzureDevOpsWorkItemTypes(
				{ ...target, organization: "https://other.example" },
				"example-pat",
			),
		).rejects.toMatchObject({ code: "invalid_response" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
