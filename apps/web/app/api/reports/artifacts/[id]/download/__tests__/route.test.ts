import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	session: vi.fn(),
	artifact: vi.fn(),
	download: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: m.session } } }));
vi.mock("@repo/database", () => ({ getTemplateInstanceArtifact: m.artifact }));
vi.mock("@repo/storage", () => ({ downloadFile: m.download }));

import { GET } from "../route";

const invoke = () =>
	GET(
		new Request(
			"http://example.com/api/reports/artifacts/example-artifact/download",
		) as never,
		{ params: Promise.resolve({ id: "example-artifact" }) },
	);
const artifact = {
	userId: "another-user",
	organizationId: "example-org",
	mimeType: "text/plain",
	name: 'Example "report".txt',
	content: "Verified output",
	s3Path: null,
	s3Bucket: null,
};
beforeEach(() => {
	vi.clearAllMocks();
	m.session.mockResolvedValue({
		user: { id: "example-user" },
		session: { activeOrganizationId: "example-org" },
	});
	m.artifact.mockResolvedValue(artifact);
	m.download.mockResolvedValue({ data: Buffer.from("Stored output") });
});
describe("authorized report artifact download", () => {
	it("allows an authorized teammate through the shared project-aware reader", async () => {
		const r = await invoke();
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("Verified output");
		expect(m.artifact).toHaveBeenCalledWith("example-artifact", {
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(r.headers.get("cache-control")).toBe("private, no-store");
		expect(r.headers.get("content-disposition")).toContain("%22report%22");
	});
	it("does not fetch stored bytes after audience denial", async () => {
		m.artifact.mockResolvedValue(null);
		expect((await invoke()).status).toBe(404);
		expect(m.download).not.toHaveBeenCalled();
	});
	it("returns S3-backed content through the same authorization boundary", async () => {
		m.artifact.mockResolvedValue({
			...artifact,
			content: null,
			s3Path: "example/report.txt",
			s3Bucket: "example-reports",
		});
		const r = await invoke();
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("Stored output");
		expect(m.download).toHaveBeenCalledWith("example/report.txt", {
			bucket: "example-reports",
		});
	});
	it("reauthorizes after storage I/O before disclosing bytes", async () => {
		m.artifact
			.mockResolvedValueOnce({
				...artifact,
				content: null,
				s3Path: "example/report.txt",
				s3Bucket: "example-reports",
			})
			.mockResolvedValueOnce(null);
		const r = await invoke();
		expect(r.status).toBe(404);
		expect(await r.text()).not.toContain("Stored output");
	});
	it("requires a current organization before any artifact lookup", async () => {
		m.session.mockResolvedValue({
			user: { id: "example-user" },
			session: { activeOrganizationId: null },
		});
		expect((await invoke()).status).toBe(404);
		expect(m.artifact).not.toHaveBeenCalled();
	});
});
