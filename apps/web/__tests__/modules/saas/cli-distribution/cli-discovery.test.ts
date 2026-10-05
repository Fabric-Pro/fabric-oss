/**
 * What the Connect dialog accepts as "this deployment serves a CLI".
 *
 * A command goes on screen only for a document that is exactly what the route
 * writes, so a proxy's error page, a 200 with the wrong body, or a spec the
 * dialog does not know all read as "not served".
 */

import { describe, expect, it } from "vitest";
import {
	type CliDiscoveryDocument,
	discoveryDocumentFor,
	parseCliDiscoveryDocument,
	parseCliManifest,
	tarballUrlOnOrigin,
} from "../../../../modules/saas/cli-distribution/lib/cli-discovery";

const MANIFEST = {
	spec: 1,
	version: "0.4.0",
	minSupported: "0.4.0",
	nodeRange: ">=22",
	origin: "https://fabric.example.com" as string | null,
	tarball: "/cli/fabric-0.4.0.tgz",
	integrity:
		"sha512-gs0KTkSwaASijxIqwSDGS2+zgB7ztmUss3KGk2FSJtWwW1lV6xyxvhfPm30zh14w8/A1yEfFl+kz96Ujga5gDg==",
};

const DOCUMENT: CliDiscoveryDocument = {
	...MANIFEST,
	spec: 1,
	tarball: "https://fabric.example.com/cli/fabric-0.4.0.tgz",
};

describe("the discovery document", () => {
	it("is the manifest with the tarball made absolute on the host that answered, and reads back as itself", () => {
		const manifest = parseCliManifest(MANIFEST);
		expect(manifest).not.toBeNull();
		if (!manifest) {
			return;
		}

		const document = discoveryDocumentFor(
			manifest,
			"https://fabric.example.com/",
		);

		expect(document).toEqual(DOCUMENT);
		expect(parseCliDiscoveryDocument(document)).toEqual(DOCUMENT);
	});

	it("puts the tarball on the host that answered, whatever origin was baked in", () => {
		const manifest = parseCliManifest({
			...MANIFEST,
			origin: "https://baked.example.com",
		});

		expect(
			manifest &&
				discoveryDocumentFor(manifest, "https://staging.example.com"),
		).toMatchObject({
			origin: "https://baked.example.com",
			tarball: "https://staging.example.com/cli/fabric-0.4.0.tgz",
		});
	});

	it("says the origin is null when the build did not know its address", () => {
		const manifest = parseCliManifest({ ...MANIFEST, origin: null });
		expect(manifest).not.toBeNull();
		if (!manifest) {
			return;
		}

		const document = discoveryDocumentFor(
			manifest,
			"https://fabric.example.com",
		);

		expect(document.origin).toBeNull();
		expect(parseCliDiscoveryDocument(document)).toEqual(document);
	});

	it("keeps a port in the origin", () => {
		const manifest = parseCliManifest({
			...MANIFEST,
			origin: "http://localhost:3001",
		});

		expect(
			manifest &&
				discoveryDocumentFor(manifest, "http://localhost:3001").tarball,
		).toBe("http://localhost:3001/cli/fabric-0.4.0.tgz");
	});

	it.each([
		["null", null],
		["a string", "not found"],
		["an error body", { error: "cli_not_served" }],
		["a spec this dialog does not know", { ...DOCUMENT, spec: 2 }],
		[
			"a relative tarball",
			{ ...DOCUMENT, tarball: "/cli/fabric-0.4.0.tgz" },
		],
		[
			"a tarball that is not a served CLI",
			{
				...DOCUMENT,
				tarball: "https://fabric.example.com/elsewhere.tgz",
			},
		],
		[
			"a non-http tarball",
			{
				...DOCUMENT,
				tarball: "ftp://fabric.example.com/cli/fabric-0.4.0.tgz",
			},
		],
		[
			"an integrity that is not sha512",
			{ ...DOCUMENT, integrity: "md5-abc" },
		],
		["a version that is not x.y.z", { ...DOCUMENT, version: "latest" }],
		[
			"a tarball whose build is not ten hex digits",
			{
				...DOCUMENT,
				tarball: "https://fabric.example.com/cli/fabric-0.4.0-XYZ.tgz",
			},
		],
	])("is refused when it is %s", (_label, value) => {
		expect(parseCliDiscoveryDocument(value)).toBeNull();
	});

	it("reads a tarball named after its build, and hands its name through untouched", () => {
		const named = {
			...DOCUMENT,
			tarball:
				"https://fabric.example.com/cli/fabric-0.4.0-0123456789.tgz",
		};

		expect(parseCliDiscoveryDocument(named)).toEqual(named);
		expect(tarballUrlOnOrigin(named, "https://staging.example.com")).toBe(
			"https://staging.example.com/cli/fabric-0.4.0-0123456789.tgz",
		);
	});

	it.each([
		["a bare host", "fabric.example.com"],
		["carrying a path", "https://fabric.example.com/app"],
		["carrying a trailing slash", "https://fabric.example.com/"],
		["carrying credentials", "https://user:pass@fabric.example.com"],
		["not http", "ftp://fabric.example.com"],
		["empty", ""],
	])("is refused when its origin is %s", (_label, origin) => {
		expect(parseCliManifest({ ...MANIFEST, origin })).toBeNull();
		expect(parseCliDiscoveryDocument({ ...DOCUMENT, origin })).toBeNull();
	});

	it("is refused when it has no origin key at all, which a null one is not", () => {
		const { origin: _dropped, ...withoutOrigin } = MANIFEST;

		expect(parseCliManifest(withoutOrigin)).toBeNull();
		expect(
			parseCliDiscoveryDocument({
				...withoutOrigin,
				tarball: DOCUMENT.tarball,
			}),
		).toBeNull();
	});
});

describe("the tarball URL in a command", () => {
	it("keeps the document's path and takes the origin from the page", () => {
		expect(
			tarballUrlOnOrigin(DOCUMENT, "https://preview.example.com"),
		).toBe("https://preview.example.com/cli/fabric-0.4.0.tgz");
	});

	it("does not double a trailing slash on the origin", () => {
		expect(
			tarballUrlOnOrigin(DOCUMENT, "https://preview.example.com/"),
		).toBe("https://preview.example.com/cli/fabric-0.4.0.tgz");
	});
});
