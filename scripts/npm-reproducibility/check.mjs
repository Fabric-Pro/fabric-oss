import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	globSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org";
const provenanceType = "https://slsa.dev/provenance/v1";

export function listPublishedPackages(manifests) {
	const names = manifests
		.filter(
			({ name, private: isPrivate }) =>
				!isPrivate && name.startsWith("@fabricorg/"),
		)
		.map(({ name }) => name)
		.sort();
	if (names.length === 0) {
		throw new Error("No publishable @fabricorg/* packages found");
	}
	return names;
}

export function parseProvenance(body) {
	const attestation = body.attestations?.find(
		(entry) => entry.predicateType === provenanceType,
	);
	if (!attestation) {
		throw new Error("Missing SLSA provenance attestation");
	}
	const payload = attestation.bundle.dsseEnvelope.payload;
	const decoded = Buffer.from(payload, "base64");
	if (decoded.toString("base64") !== payload) {
		throw new Error("Malformed base64 provenance payload");
	}
	const statement = JSON.parse(decoded.toString("utf8"));
	if (statement.predicateType !== provenanceType) {
		throw new Error("Unexpected provenance statement type");
	}
	const definition = statement.predicate?.buildDefinition;
	const workflow = definition?.externalParameters?.workflow;
	if (workflow?.repository !== "https://github.com/Fabric-Pro/fabric-oss") {
		throw new Error("Unexpected provenance workflow repository");
	}
	if (workflow.path !== ".github/workflows/release.yml") {
		throw new Error("Unexpected provenance workflow path");
	}
	const commit = definition.resolvedDependencies?.[0]?.digest?.gitCommit;
	if (typeof commit !== "string" || !/^[a-f0-9]{40}$/i.test(commit)) {
		throw new Error("Expected a 40-hex provenance commit");
	}
	return commit.toLowerCase();
}

export function computeIntegrity(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function groupByCommit(packages) {
	return Map.groupBy(packages, ({ commit }) => commit);
}

export function resultExitCode(rows) {
	return rows.every(({ verdict }) => verdict === "pass") ? 0 : 1;
}

async function readRegistry(fetchJsonResponse, path) {
	const response = await fetchJsonResponse(`${registry}${path}`);
	if (!response.ok) {
		throw new Error(
			`Registry returned HTTP ${response.status} for ${path}`,
		);
	}
	return response.json();
}

function couldNotCheck(row, error) {
	row.verdict = "could not check";
	row.reason = error.message.split("\n")[0];
}

export async function checkPackages(names, { fetchJsonResponse, rebuild }) {
	const rows = names.map((name) => ({ name }));
	const ready = [];
	for (const row of rows) {
		try {
			const encodedName = encodeURIComponent(row.name)
				.replace("%40", "@")
				.replace("%2F", "%2f");
			const metadata = await readRegistry(
				fetchJsonResponse,
				`/${encodedName}/latest`,
			);
			const { version } = metadata;
			if (typeof version !== "string" || !version) {
				throw new Error("Missing or invalid latest version");
			}
			row.version = version;
			const integrity = metadata.dist?.integrity;
			if (
				typeof integrity !== "string" ||
				!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
			) {
				throw new Error("Missing or invalid npm SHA-512 integrity");
			}
			row.expected = integrity;
			const attestation = await readRegistry(
				fetchJsonResponse,
				`/-/npm/v1/attestations/${encodedName}@${encodeURIComponent(version)}`,
			);
			row.commit = parseProvenance(attestation);
			ready.push(row);
		} catch (error) {
			couldNotCheck(row, error);
		}
	}

	for (const [commit, packages] of groupByCommit(ready)) {
		try {
			const rebuilt = await rebuild(commit, packages);
			for (const row of packages) {
				row.actual = rebuilt.get(row.name);
				if (row.actual === undefined) {
					couldNotCheck(row, new Error("Missing packed tarball"));
				} else {
					row.verdict = row.actual === row.expected ? "pass" : "fail";
				}
			}
		} catch (error) {
			for (const row of packages) {
				couldNotCheck(row, error);
			}
		}
	}
	return rows;
}

function run(command, args, cwd) {
	execFileSync(command, args, { cwd, stdio: "inherit" });
}

function rebuildAtCommit(commit, packages) {
	const scratch = mkdtempSync(
		join(process.env.RUNNER_TEMP, "npm-reproducibility-"),
	);
	try {
		const source = join(scratch, "source");
		const packed = join(scratch, "packed");
		mkdirSync(source);
		mkdirSync(packed);
		run("bash", [
			"-o",
			"pipefail",
			"-c",
			'git archive "$1" | tar -xf - -C "$2"',
			"bash",
			commit,
			source,
		]);
		run("pnpm", ["install", "--frozen-lockfile"], source);
		run("pnpm", ["turbo", "build", "--filter=@fabricorg/*"], source);
		run("pnpm", ["check:declaration-maps"], source);
		run("pnpm", ["turbo", "type-check", "--filter=@fabricorg/*"], source);
		run(
			"pnpm",
			[
				"-r",
				...packages.flatMap(({ name }) => ["--filter", name]),
				"pack",
				"--pack-destination",
				packed,
			],
			source,
		);
		const tarballs = new Map(
			readdirSync(packed).map((filename) => [
				filename,
				computeIntegrity(readFileSync(join(packed, filename))),
			]),
		);
		return new Map(
			packages.map(({ name, version }) => {
				const filename = `${name.slice(1).replace("/", "-")}-${version}.tgz`;
				return [name, tarballs.get(filename)];
			}),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function main() {
	const names = listPublishedPackages(
		globSync("packages/*/package.json").map((file) =>
			JSON.parse(readFileSync(file, "utf8")),
		),
	);
	const rows = await checkPackages(names, {
		fetchJsonResponse: (url) =>
			fetch(url, { signal: AbortSignal.timeout(30_000) }),
		rebuild: rebuildAtCommit,
	});
	console.log("Package\tCommit\tExpected\tActual\tVerdict\tReason");
	for (const {
		name,
		version,
		commit,
		expected,
		actual,
		verdict,
		reason,
	} of rows) {
		console.log(
			[
				`${name}@${version ?? "?"}`,
				commit ?? "-",
				expected ?? "-",
				actual ?? "-",
				verdict,
				reason ?? "",
			].join("\t"),
		);
	}
	process.exitCode = resultExitCode(rows);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`could not check: ${error.message}`);
		process.exitCode = 1;
	});
}
