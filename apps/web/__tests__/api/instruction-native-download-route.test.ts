import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ download: vi.fn(), session: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock(
	"@repo/api/modules/projects/procedures/instructions/repository/download",
	() => ({
		downloadDirectRepository: mocks.download,
	}),
);

import { GET } from "../../app/api/projects/[projectId]/instructions/repository/download/route";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({ user: { id: "member-1" } });
	mocks.download.mockImplementation(async () => new Response("exact bytes"));
});

describe("native repository download HTTP boundary", () => {
	it.each(["", "generation=-1", "generation=1.5", "generation=garbage"])(
		"rejects an absent or malformed generation: %s",
		async (query) => {
			const response = await GET(
				new NextRequest(`https://fabric.example/download?${query}`),
				{
					params: Promise.resolve({ projectId: "project-1" }),
				},
			);
			expect(response.status).toBe(400);
			expect(mocks.download).not.toHaveBeenCalled();
		},
	);
	it("passes the captured Git version, path and cancellation signal to the reader", async () => {
		const request = new NextRequest(
			`https://fabric.example/download?generation=7&commitSha=${"a".repeat(40)}&path=CLAUDE.md`,
		);
		const response = await GET(request, {
			params: Promise.resolve({ projectId: "project-1" }),
		});
		expect(await response.text()).toBe("exact bytes");
		expect(mocks.download).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "member-1",
			generation: 7,
			commitSha: "a".repeat(40),
			path: "CLAUDE.md",
			signal: request.signal,
		});
	});
	it("denies anonymous requests before opening the repository", async () => {
		mocks.session.mockResolvedValue(null);
		const response = await GET(
			new NextRequest("https://fabric.example/download?generation=7"),
			{
				params: Promise.resolve({ projectId: "project-1" }),
			},
		);
		expect(response.status).toBe(401);
		expect(mocks.download).not.toHaveBeenCalled();
	});
});
