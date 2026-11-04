import { createHash } from "node:crypto";
import { Permissions } from "@repo/permissions";
import { describe, expect, it, vi } from "vitest";
import {
	ContextReadError,
	createProjectContextReader,
	MAX_CONTEXT_QUALITY_SOURCE_BYTES,
	type ProjectContextReadInput,
} from "../context-reader";

type Dependencies = Parameters<typeof createProjectContextReader>[0];
type Row = NonNullable<Awaited<ReturnType<Dependencies["getContext"]>>>;

const input: ProjectContextReadInput = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-reader",
	sourceId: "example-source",
};

function fixture(overrides: Partial<Row> = {}): Row {
	return {
		id: input.sourceId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		type: "TEXT",
		urlScope: null,
		content: "# Reviewed\r\n\nSource text 🌱",
		extractionStatus: "COMPLETED",
		indexingExcluded: false,
		updatedAt: new Date("2026-11-02T00:00:00Z"),
		sourceTitle: "Synthetic example",
		metadata: { hiddenConnectionCredential: "synthetic-hidden-value" },
		...overrides,
	};
}

function harness(row = fixture()) {
	const world = {
		row: row as Row | null,
		visible: true,
		deleted: false,
		organizationDeleted: false,
		permissions: [Permissions.CONTEXT_READ],
		organizationId: input.organizationId,
	};
	const dependencies = {
		resolveAccess: vi.fn(async () => ({
			organizationId: world.organizationId,
			organizationDeleted: world.organizationDeleted,
			permissions: world.permissions,
		})),
		hasProjectAccess: vi.fn(async () => world.visible),
		isProjectSoftDeleted: vi.fn(async () => world.deleted),
		getContext: vi.fn(async (sourceId, projectId, tenant) => {
			const candidate = world.row;
			return candidate &&
				candidate.id === sourceId &&
				candidate.projectId === projectId &&
				candidate.organizationId === tenant.organizationId
				? { ...candidate }
				: null;
		}) as Dependencies["getContext"],
		readBody: vi.fn(async (candidate: Row) => ({
			content: candidate.content ?? "",
			truncated: false,
			hasReadableText: (candidate.content ?? "").trim().length > 0,
		})),
	} satisfies Dependencies;
	return {
		world,
		dependencies,
		read: createProjectContextReader(dependencies),
	};
}

describe("authorized current project context snapshots", () => {
	it.each([
		{ type: "LINK", urlScope: "PATH_PREFIX" },
		{ type: "INTEGRATION", urlScope: null },
	])(
		"refuses changed child body even when parent metadata is unchanged: %j",
		async (kind) => {
			const { read, dependencies } = harness(fixture(kind));
			dependencies.readBody
				.mockResolvedValueOnce({
					content: "old captured content",
					truncated: false,
					hasReadableText: true,
				})
				.mockResolvedValueOnce({
					content: "new captured content",
					truncated: false,
					hasReadableText: true,
				});
			await expect(
				read({
					...input,
					expectedRevision: createHash("sha256")
						.update("old captured content")
						.digest("hex"),
				}),
			).rejects.toMatchObject({ code: "STALE_REVISION" });
			expect(dependencies.readBody).toHaveBeenCalledTimes(2);
		},
	);
	it("pins exact UTF-8 bytes and returns only the source DTO", async () => {
		const { read, dependencies } = harness();
		const result = await read(input);
		expect(result).toEqual({
			sourceId: input.sourceId,
			sourceKind: "project_context",
			projectId: input.projectId,
			organizationId: input.organizationId,
			title: "Synthetic example",
			content: fixture().content,
			revision: createHash("sha256")
				.update(fixture().content ?? "")
				.digest("hex"),
			byteLength: Buffer.byteLength(fixture().content ?? "", "utf8"),
			indexingExcluded: false,
			readMode: "direct",
		});
		expect(JSON.stringify(result)).not.toContain("synthetic-hidden-value");
		expect(result).not.toHaveProperty("metadata");
		expect(result).not.toHaveProperty("updatedAt");
		expect(dependencies.getContext).toHaveBeenCalledWith(
			input.sourceId,
			input.projectId,
			{
				userId: input.userId,
				organizationId: input.organizationId,
			},
		);
		expect(dependencies.readBody).toHaveBeenCalledWith(
			expect.anything(),
			{
				userId: input.userId,
				organizationId: input.organizationId,
			},
			{ offset: 0, maxLength: MAX_CONTEXT_QUALITY_SOURCE_BYTES },
		);
	});

	it("reads a teammate's source through project access without a source-creator filter", async () => {
		const { read, dependencies } = harness();
		await expect(
			read({ ...input, userId: "example-project-guest" }),
		).resolves.toHaveProperty("content");
		expect(dependencies.hasProjectAccess).toHaveBeenCalledWith(
			input.projectId,
			"example-project-guest",
			input.organizationId,
		);
	});

	it("does not exclude STORE_ONLY rows from an explicit direct read", async () => {
		const { read } = harness(fixture({ indexingExcluded: true }));
		await expect(read(input)).resolves.toMatchObject({
			indexingExcluded: true,
			readMode: "direct",
		});
	});

	it.each(["", " ", "a".repeat(129)])(
		"fails closed before I/O for invalid organization scope %j",
		async (organizationId) => {
			const { read, dependencies } = harness();
			await expect(
				read({ ...input, organizationId }),
			).rejects.toMatchObject({ code: "INVALID_SCOPE" });
			expect(dependencies.resolveAccess).not.toHaveBeenCalled();
			expect(dependencies.getContext).not.toHaveBeenCalled();
		},
	);

	it("requires a nonempty authenticated subject", async () => {
		const { read, dependencies } = harness();
		await expect(read({ ...input, userId: "" })).rejects.toMatchObject({
			code: "INVALID_SCOPE",
		});
		expect(dependencies.resolveAccess).not.toHaveBeenCalled();
	});

	it("does not reveal an existing project when the explicit organization is different", async () => {
		const { read, dependencies } = harness();
		await expect(
			read({ ...input, organizationId: "example-other-org" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dependencies.getContext).not.toHaveBeenCalled();
	});

	it("refuses an inaccessible project even if the organization role has context permission", async () => {
		const { read, dependencies, world } = harness();
		world.visible = false;
		await expect(read(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dependencies.getContext).not.toHaveBeenCalled();
	});

	it("rechecks live role permission on every read", async () => {
		const { read, dependencies, world } = harness();
		await read(input);
		world.permissions = [];
		vi.mocked(dependencies.getContext).mockClear();
		await expect(read(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(dependencies.getContext).not.toHaveBeenCalled();
	});

	it.each(["deleted", "organizationDeleted"] as const)(
		"hides a source whose project scope is %s",
		async (field) => {
			const { read, dependencies, world } = harness();
			world[field] = true;
			await expect(read(input)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(dependencies.getContext).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ projectId: "example-other-project" },
		{ organizationId: "example-other-org" },
	])("hides cross-scope source addresses %j", async (overrides) => {
		const { read, dependencies } = harness(fixture(overrides));
		await expect(read(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dependencies.readBody).not.toHaveBeenCalled();
	});

	it.each(["PENDING", "EXTRACTING", "FAILED", "CANCELLED"])(
		"refuses %s extraction state",
		async (extractionStatus) => {
			const { read, dependencies } = harness(
				fixture({ extractionStatus }),
			);
			await expect(read(input)).rejects.toMatchObject({
				code: "NOT_READY",
			});
			expect(dependencies.readBody).not.toHaveBeenCalled();
		},
	);

	it.each(["SLACK", "MICROSOFT_TEAMS"])(
		"reads captured %s content when its lifecycle-less pointer remains PENDING",
		async (provider) => {
			const { read, dependencies } = harness(
				fixture({
					type: "INTEGRATION",
					extractionStatus: "PENDING",
					content: "",
					metadata: { provider, channelId: "example-channel" },
				}),
			);
			dependencies.readBody.mockResolvedValue({
				content: "Stored, neutralized captured channel text.",
				truncated: false,
				hasReadableText: true,
			});
			await expect(read(input)).resolves.toMatchObject({
				content: "Stored, neutralized captured channel text.",
			});
		},
	);

	it("does not treat a lifecycle-less pointer without captured text as ready", async () => {
		const { read } = harness(
			fixture({
				type: "INTEGRATION",
				extractionStatus: "PENDING",
				content: "",
				metadata: { provider: "SLACK", channelId: "example-channel" },
			}),
		);
		await expect(read(input)).rejects.toMatchObject({ code: "NOT_READY" });
	});

	it("still requires completed extraction for a Google Docs integration", async () => {
		const { read, dependencies } = harness(
			fixture({
				type: "INTEGRATION",
				extractionStatus: "PENDING",
				metadata: { source: "google-docs" },
			}),
		);
		await expect(read(input)).rejects.toMatchObject({ code: "NOT_READY" });
		expect(dependencies.readBody).not.toHaveBeenCalled();
	});

	it("does not return stale content after deletion during the body read", async () => {
		const { read, dependencies, world } = harness();
		dependencies.readBody.mockImplementationOnce(async () => {
			world.row = null;
			return {
				content: "private old content",
				truncated: false,
				hasReadableText: true,
			};
		});
		await expect(read(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("does not return content after access is revoked during a body read", async () => {
		const { read, dependencies, world } = harness();
		dependencies.readBody.mockImplementationOnce(async () => {
			world.permissions = [];
			return {
				content: "private old content",
				truncated: false,
				hasReadableText: true,
			};
		});
		await expect(read(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses a changed parent after an asynchronous child read", async () => {
		const { read, dependencies, world } = harness();
		dependencies.readBody.mockImplementationOnce(async () => {
			world.row = fixture({
				content: "changed source",
				updatedAt: new Date("2026-11-02T00:00:01Z"),
			});
			return {
				content: "old source",
				truncated: false,
				hasReadableText: true,
			};
		});
		await expect(read(input)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
	});

	it("refuses a changed STORE_ONLY projection flag during a read", async () => {
		const { read, dependencies, world } = harness();
		dependencies.readBody.mockImplementationOnce(async () => {
			world.row = fixture({ indexingExcluded: true });
			return {
				content: "old source",
				truncated: false,
				hasReadableText: true,
			};
		});
		await expect(read(input)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
	});

	it("pins the shared canonical body for URL-page and conversation sources", async () => {
		for (const source of [
			fixture({ type: "LINK", urlScope: "PATH_PREFIX", content: "" }),
			fixture({ type: "INTEGRATION", content: "" }),
		]) {
			const { read, dependencies } = harness(source);
			const canonicalBody =
				"# Full child/bundle content\n\nSynthetic text.";
			dependencies.readBody.mockResolvedValue({
				content: canonicalBody,
				truncated: false,
				hasReadableText: true,
			});
			await expect(read(input)).resolves.toMatchObject({
				content: canonicalBody,
				revision: createHash("sha256")
					.update(canonicalBody)
					.digest("hex"),
			});
		}
	});

	it("refuses a truncated canonical body instead of hashing an incomplete snapshot", async () => {
		const { read, dependencies } = harness();
		dependencies.readBody.mockResolvedValueOnce({
			content: "part of a body",
			truncated: true,
			hasReadableText: true,
		});
		await expect(read(input)).rejects.toMatchObject({ code: "TOO_LARGE" });
	});

	it("measures Unicode UTF-8 bytes separately from reader character bounds", async () => {
		const { read } = harness(
			fixture({
				content: "🌱".repeat(MAX_CONTEXT_QUALITY_SOURCE_BYTES / 4 + 1),
			}),
		);
		await expect(read(input)).rejects.toMatchObject({ code: "TOO_LARGE" });
	});

	it("accepts a source exactly at the byte bound", async () => {
		const { read } = harness(
			fixture({ content: "a".repeat(MAX_CONTEXT_QUALITY_SOURCE_BYTES) }),
		);
		await expect(read(input)).resolves.toHaveProperty(
			"byteLength",
			MAX_CONTEXT_QUALITY_SOURCE_BYTES,
		);
	});

	it("does not report whitespace-only extraction as a readable snapshot", async () => {
		const { read } = harness(fixture({ content: " \r\n\t" }));
		await expect(read(input)).rejects.toMatchObject({ code: "NOT_READY" });
	});

	it("returns the same revision for unchanged bytes and refuses an old pin after update", async () => {
		const { read, world } = harness();
		const first = await read(input);
		await expect(
			read({ ...input, expectedRevision: first.revision }),
		).resolves.toHaveProperty("revision", first.revision);
		world.row = fixture({ content: "new reviewed text" });
		await expect(
			read({ ...input, expectedRevision: first.revision }),
		).rejects.toMatchObject({ code: "STALE_REVISION" });
	});

	it("refuses malformed pins before looking up source data", async () => {
		const { read, dependencies } = harness();
		await expect(
			read({ ...input, expectedRevision: "latest" }),
		).rejects.toMatchObject({ code: "INVALID_REVISION" });
		expect(dependencies.getContext).not.toHaveBeenCalled();
	});

	it("error messages contain no source content, private title or provider metadata", async () => {
		const { read } = harness(
			fixture({
				extractionStatus: "FAILED",
				sourceTitle: "private source title",
			}),
		);
		try {
			await read(input);
			throw new Error("Expected a source refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ContextReadError);
			expect(error).toMatchObject({
				message: "Context source has no completed readable content.",
			});
			expect(String(error)).not.toContain("private source title");
			expect(String(error)).not.toContain("synthetic-hidden-value");
		}
	});
});
