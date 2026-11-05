import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
	ListSkillsOptions,
	SkillAssistInput,
	SkillCreateInput,
	SkillGovernanceUpdateInput,
	SkillImportCreateInput,
	SkillImportFileReadInput,
	SkillImportSource,
	SkillUpdateInput,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

interface Options {
	org?: string;
	personal?: boolean;
	format: string;
	tab?: string;
	search?: string;
	category?: string;
	limit?: string;
	offset?: string;
	cursor?: string;
	sortBy?: string;
	sortOrder?: string;
	expectedVersion?: string;
	availability?: string;
	confirmPermanent?: boolean;
	ref?: string;
	candidateKey?: string;
	expectedHash?: string;
	quiet?: boolean;
}
async function jsonFile<T>(file: string, maxBytes = 1024 * 1024): Promise<T> {
	const buffer = await readFile(file);
	if (buffer.byteLength > maxBytes) {
		throw Error(`Request file exceeds ${maxBytes} bytes.`);
	}
	return JSON.parse(buffer.toString("utf8")) as T;
}
async function importSource(
	source: string,
	ref?: string,
): Promise<SkillImportSource> {
	if (/^https:\/\//i.test(source)) {
		return { kind: "github", url: source, ...(ref ? { ref } : {}) };
	}
	const buffer = await readFile(source);
	if (buffer.byteLength > 8 * 1024 * 1024) {
		throw Error("Import files must not exceed 8 MiB.");
	}
	return {
		kind: "file",
		fileName: basename(source),
		base64: buffer.toString("base64"),
	};
}
function integer(
	value: string | undefined,
	label: string,
	min = 1,
	max = Number.MAX_SAFE_INTEGER,
): number | undefined {
	if (value === undefined) {
		return;
	}
	const result = Number(value);
	if (
		!/^\d+$/.test(value) ||
		!Number.isSafeInteger(result) ||
		result < min ||
		result > max
	) {
		throw Error(`${label} must be an integer from ${min} to ${max}.`);
	}
	return result;
}
export function buildSkillsCommand(): Command {
	const skills = new Command("skills").description(
		"Create, import, publish and govern reusable skills",
	);
	function add(
		parent: Command,
		name: string,
		description: string,
		action: (args: string[], options: Options) => Promise<unknown>,
		configure?: (command: Command) => void,
	) {
		const command = parent
			.command(name)
			.description(description)
			.option("--org <slug>", "Organization context")
			.option("--format <format>", "Output: table|json|yaml|csv", "json");
		configure?.(command);
		return command.action(async (...values: unknown[]) => {
			const current = values[values.length - 1] as Command;
			const options = current.opts<Options>();
			try {
				const context = resolveContext(
					options.personal,
					options.org,
					true,
				);
				if (!context || context.type !== "org") {
					throw Error("Choose an organization with --org <slug>.");
				}
				if (
					!["table", "json", "yaml", "csv"].includes(options.format)
				) {
					throw Error("--format must be table, json, yaml or csv.");
				}
				const result = await action(current.processedArgs.map(String), {
					...options,
					org: context.slug,
				});
				if (
					options.quiet &&
					result &&
					typeof result === "object" &&
					"skills" in result
				) {
					for (const skill of result.skills as Array<{
						slug: string;
					}>) {
						process.stdout.write(`${skill.slug}\n`);
					}
				} else {
					printOutput(result, {
						format: options.format as
							| "table"
							| "json"
							| "yaml"
							| "csv",
					});
				}
			} catch (error) {
				printError(
					error instanceof Error
						? error.message
						: "The skill action could not be confirmed. Inspect its current state before retrying.",
					1,
				);
			}
		});
	}
	const client = () => getClient().skills;
	add(
		skills,
		"list",
		"Browse built-ins, published organization skills or your own drafts",
		(_args, o) =>
			client().listPage({
				org: o.org,
				tab: o.tab as ListSkillsOptions["tab"],
				search: o.search,
				category: o.category,
				limit: integer(o.limit, "--limit", 1, 100),
				offset: integer(o.offset, "--offset", 0, 100000),
				cursor: o.cursor,
				sortBy: o.sortBy as ListSkillsOptions["sortBy"],
				sortOrder: o.sortOrder as ListSkillsOptions["sortOrder"],
			}),
		(command) =>
			command
				.option(
					"--personal",
					"Retired: organization context is required",
				)
				.option(
					"--tab <tab>",
					"all|organization|builtin|drafts|archived",
					"all",
				)
				.option("--search <query>", "Search skills")
				.option("--category <name>", "Category filter")
				.option("--limit <number>", "Page size, 1–100", "20")
				.option("--offset <number>", "Page offset", "0")
				.option("--cursor <id>", "Next-page cursor")
				.option(
					"--sort-by <field>",
					"name|createdAt|updatedAt|useCount",
					"updatedAt",
				)
				.option("--sort-order <order>", "asc|desc", "desc")
				.option("-q, --quiet", "Print slugs only"),
	);
	add(
		skills,
		"show <id>",
		"Read an authorized skill by ID or slug",
		([id], o) => client().get(id, { org: o.org }),
	);
	add(
		skills,
		"file <id> <path>",
		"Read an authorized skill file as bounded text or base64",
		([id, path], o) =>
			client().readFile(
				id,
				{
					path,
					expectedVersion: integer(
						o.expectedVersion,
						"--expected-version",
					),
				},
				{ org: o.org },
			),
		(command) =>
			command.option(
				"--expected-version <number>",
				"Expected current skill version",
			),
	);
	add(
		skills,
		"create <request-file>",
		"Create a private draft from JSON; publication requires an explicit grant",
		async ([file], o) =>
			client().create(await jsonFile<SkillCreateInput>(file), {
				org: o.org,
			}),
	);
	add(
		skills,
		"update <id> <request-file>",
		"Update your own skill using JSON with expectedVersion",
		async ([id, file], o) =>
			client().update(id, await jsonFile<SkillUpdateInput>(file), {
				org: o.org,
			}),
	);
	for (const operation of ["archive", "restore"] as const) {
		add(
			skills,
			`${operation} <id>`,
			`${operation === "archive" ? "Archive" : "Restore"} your own skill`,
			([id], o) =>
				client()[operation](
					id,
					{
						expectedVersion: integer(
							o.expectedVersion,
							"--expected-version",
						),
					},
					{ org: o.org },
				),
			(command) =>
				command.option(
					"--expected-version <number>",
					"Expected current skill version",
				),
		);
	}
	add(
		skills,
		"publish <id>",
		"Set your own skill availability within organization policy",
		([id], o) => {
			const version = integer(o.expectedVersion, "--expected-version");
			if (!version) {
				throw Error("--expected-version is required.");
			}
			if (
				!["members", "agents", "draft"].includes(o.availability ?? "")
			) {
				throw Error("--availability must be members, agents or draft.");
			}
			return client().publish(
				id,
				{
					expectedVersion: version,
					availability: o.availability as
						| "members"
						| "agents"
						| "draft",
				},
				{ org: o.org },
			);
		},
		(command) =>
			command
				.option(
					"--expected-version <number>",
					"Expected current skill version",
				)
				.option(
					"--availability <availability>",
					"members|agents|draft",
				),
	);
	add(
		skills,
		"delete <id>",
		"Permanently delete your own skill; use archive for reversible removal",
		([id], o) => {
			if (!o.confirmPermanent) {
				throw Error("Permanent deletion requires --confirm-permanent.");
			}
			return client().delete(id, {
				org: o.org,
				expectedVersion: integer(
					o.expectedVersion,
					"--expected-version",
				),
			});
		},
		(command) =>
			command
				.option("--confirm-permanent", "Confirm irreversible deletion")
				.option(
					"--expected-version <number>",
					"Expected current skill version",
				),
	);
	add(
		skills,
		"assist <request-file>",
		"Request an AI proposal from JSON; no changes are saved automatically",
		async ([file], o) =>
			client().assist(
				await jsonFile<SkillAssistInput>(file, 128 * 1024),
				{ org: o.org },
			),
	);
	const imports = skills
		.command("import")
		.description(
			"Inspect Markdown/ZIP files or public GitHub sources before importing a draft",
		);
	add(
		imports,
		"preview <source>",
		"Inspect an explicit local file or public GitHub URL",
		async ([source], o) =>
			client().previewImport(
				{ source: await importSource(source, o.ref) },
				{ org: o.org },
			),
		(command) =>
			command.option(
				"--ref <ref>",
				"GitHub revision; reuse the preview's resolved commit when creating",
			),
	);
	add(
		imports,
		"create <request-file>",
		"Create one inspected candidate using JSON source, candidateKey and expectedHash",
		async ([file], o) =>
			client().createImport(
				await jsonFile<SkillImportCreateInput>(file, 12 * 1024 * 1024),
				{ org: o.org },
			),
	);
	add(
		imports,
		"apply <source>",
		"Create an inspected file or pinned public GitHub candidate as a private draft",
		async ([source], o) => {
			if (!o.candidateKey || !o.expectedHash) {
				throw Error(
					"--candidate-key and --expected-hash from the inspected preview are required.",
				);
			}
			return client().createImport(
				{
					source: await importSource(source, o.ref),
					candidateKey: o.candidateKey,
					expectedHash: o.expectedHash,
				},
				{ org: o.org },
			);
		},
		(command) =>
			command
				.option(
					"--candidate-key <key>",
					"Candidate key from the preview",
				)
				.option(
					"--expected-hash <sha256>",
					"Source hash from the preview",
				)
				.option(
					"--ref <commit>",
					"Resolved public GitHub commit from the preview",
				),
	);
	add(
		imports,
		"read-file <request-file>",
		"Read one inspected import file using source, candidateKey, expectedHash and path",
		async ([file], o) =>
			client().readImportFile(
				await jsonFile<SkillImportFileReadInput>(
					file,
					12 * 1024 * 1024,
				),
				{ org: o.org },
			),
	);
	const governance = skills
		.command("governance")
		.description(
			"Read organization skill policies or update them as an administrator",
		);
	add(
		governance,
		"show",
		"Read creation, publication and agent discovery policies",
		(_args, o) => client().getGovernance({ org: o.org }),
	);
	add(
		governance,
		"update <request-file>",
		"Update policy using expectedRevision and the three policy settings",
		async ([file], o) =>
			client().updateGovernance(
				await jsonFile<SkillGovernanceUpdateInput>(file),
				{ org: o.org },
			),
	);
	return skills;
}
