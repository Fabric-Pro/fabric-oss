import path from "node:path";
import { describe, expect, it } from "vitest";
import { isMicrofrontendsBuild } from "../../lib/microfrontends-build";

const repo = path.resolve("/work/release-src");
const web = path.join(repo, "apps/web");

/** A filesystem holding only the given `.vercel/project.json` files. */
function files(entries: Record<string, string>) {
	return (file: string) => {
		const hit = entries[file];
		if (hit === undefined) {
			throw Object.assign(new Error(`ENOENT: ${file}`), {
				code: "ENOENT",
			});
		}
		return hit;
	};
}
const projectJson = (dir: string) => path.join(dir, ".vercel", "project.json");
const linked = (projectName: string) =>
	JSON.stringify({
		projectId: "prj_example",
		orgId: "team_example",
		projectName,
	});

describe("isMicrofrontendsBuild", () => {
	it("joins the group on Vercel's own fabric-prod builder", () => {
		expect(
			isMicrofrontendsBuild({
				env: { VERCEL_PROJECT_NAME: "fabric-prod" },
				cwd: web,
				readFile: files({}),
			}),
		).toBe(true);
	});

	it("stays out on any other Vercel project, whatever is linked locally", () => {
		const readFile = files({ [projectJson(repo)]: linked("fabric-prod") });
		expect(
			isMicrofrontendsBuild({
				env: { VERCEL_PROJECT_NAME: "fabric" },
				cwd: web,
				readFile,
			}),
		).toBe(false);
	});

	// The release pipeline: `vercel pull` at the repository root, then `vercel build`, no VERCEL_PROJECT_NAME.
	it("joins the group on a prebuilt deploy linked to fabric-prod at the repository root", () => {
		const readFile = files({ [projectJson(repo)]: linked("fabric-prod") });
		expect(
			isMicrofrontendsBuild({
				env: { NODE_ENV: "production" },
				cwd: web,
				readFile,
			}),
		).toBe(true);
	});

	it("joins the group on a prebuilt deploy linked in apps/web", () => {
		const readFile = files({ [projectJson(web)]: linked("fabric-prod") });
		expect(isMicrofrontendsBuild({ env: {}, cwd: web, readFile })).toBe(
			true,
		);
	});

	// The regression: a sensitive project variable arrives from `vercel pull` as this literal.
	it("does not trust a sensitive flag pulled as [SENSITIVE]", () => {
		expect(
			isMicrofrontendsBuild({
				env: { FABRIC_MICROFRONTENDS: "[SENSITIVE]" },
				cwd: web,
				readFile: files({}),
			}),
		).toBe(false);
	});

	it("stays out on a prebuilt deploy of another project", () => {
		const readFile = files({ [projectJson(repo)]: linked("fabric") });
		expect(isMicrofrontendsBuild({ env: {}, cwd: web, readFile })).toBe(
			false,
		);
	});

	it("stays out in next dev, even in a checkout linked to fabric-prod", () => {
		const readFile = files({ [projectJson(repo)]: linked("fabric-prod") });
		expect(
			isMicrofrontendsBuild({
				env: { NODE_ENV: "development" },
				cwd: web,
				readFile,
			}),
		).toBe(false);
	});

	it("stays out with no link, or an unreadable one", () => {
		expect(
			isMicrofrontendsBuild({ env: {}, cwd: web, readFile: files({}) }),
		).toBe(false);
		expect(
			isMicrofrontendsBuild({
				env: {},
				cwd: web,
				readFile: files({ [projectJson(repo)]: "{not json" }),
			}),
		).toBe(false);
	});
});
