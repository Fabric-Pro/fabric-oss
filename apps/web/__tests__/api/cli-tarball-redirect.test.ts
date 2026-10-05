// @vitest-environment node
/**
 * `GET /cli/<name>` for a tarball name this deployment no longer serves.
 *
 * The tarball's name carries the build, so a new deployment serves a new name
 * and `npx -y <old url>` would meet npm's "is not in this registry" error. The
 * route sends a name of the right shape to the current tarball, and answers
 * anything else with a plain 404 that says what is wrong.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/cli/[file]/route";

const CURRENT = "/cli/fabric-0.5.0-0123456789.tgz";

afterEach(() => {
	vi.unstubAllEnvs();
});

function get(file: string) {
	return GET(new Request(`https://fabric.example.com/cli/${file}`), {
		params: Promise.resolve({ file }),
	});
}

describe("/cli/<a tarball name that is not served any more>", () => {
	it("redirects to the current tarball, by path, so it works on whatever host asked", async () => {
		vi.stubEnv("FABRIC_CLI_TARBALL", CURRENT);

		const response = await get("fabric-0.5.0-ffffffffff.tgz");

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(CURRENT);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("redirects a name from before builds were named, too", async () => {
		vi.stubEnv("FABRIC_CLI_TARBALL", CURRENT);

		const response = await get("fabric-0.4.0.tgz");

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(CURRENT);
	});

	it.each([
		["a file of another kind", "evil.sh"],
		["a name with a path in it", "../fabric-0.5.0-0123456789.tgz"],
		["a build that is not ten hex digits", "fabric-0.5.0-XYZ.tgz"],
		["something after the name", "fabric-0.5.0-0123456789.tgz.exe"],
	])(
		"answers %s with a 404 and sends nobody anywhere",
		async (_label, file) => {
			vi.stubEnv("FABRIC_CLI_TARBALL", CURRENT);

			const response = await get(file);

			expect(response.status).toBe(404);
			expect(response.headers.get("location")).toBeNull();
			expect(await response.json()).toEqual({
				error: "not_found",
				message: "There is no such file under /cli.",
			});
		},
	);

	it("says this deployment serves no CLI when it was built without one", async () => {
		vi.stubEnv("FABRIC_CLI_TARBALL", "");

		const response = await get("fabric-0.5.0-0123456789.tgz");

		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("cli_not_served");
	});

	it("will not redirect to a target that is not a tarball path", async () => {
		vi.stubEnv("FABRIC_CLI_TARBALL", "https://evil.example/x.tgz");

		const response = await get("fabric-0.5.0-0123456789.tgz");

		expect(response.status).toBe(404);
		expect(response.headers.get("location")).toBeNull();
	});
});
