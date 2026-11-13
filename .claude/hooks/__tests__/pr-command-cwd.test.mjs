import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { leadingCdTarget } from "../lib/git-helpers.mjs";
import { prCommandCwd } from "../lib/pr-command-cwd.mjs";
import { PR, refusedPrCwdCommands } from "./pr-cwd-fixtures.mjs";

// The scanner takes the gate's predicate; hook tests exercise the real ones.
const invocation = (segment) => segment.includes(PR);
const cwd = path.resolve("payload");
const slot = path.join(cwd, "slot");

function withHome(home, fn) {
	const old = process.env.HOME;
	try {
		if (home === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = home;
		}
		fn();
	} finally {
		if (old === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = old;
		}
	}
}

describe("leadingCdTarget — bash HOME expansion", () => {
	it("expands bare tilde and tilde slash using HOME instead of the OS home", () => {
		withHome(cwd, () => {
			assert.equal(leadingCdTarget("cd ~ && true"), cwd);
			assert.equal(
				path.normalize(leadingCdTarget("cd ~/slot && true")),
				path.join(cwd, "slot"),
			);
		});
	});
	for (const target of [
		'"~/slot"',
		"'~/slot'",
		"~user",
		"~+",
		"~-",
		"a~/b",
	]) {
		it(`leaves ${target} unchanged`, () => {
			withHome(cwd, () => {
				assert.equal(
					leadingCdTarget(`cd ${target} && true`),
					target.replace(/^["']|["']$/g, ""),
				);
			});
		});
	}
	for (const home of ["", undefined]) {
		it(`leaves tilde unchanged with ${home === "" ? "empty" : "unset"} HOME`, () => {
			withHome(home, () => {
				assert.equal(leadingCdTarget("cd ~/slot && true"), "~/slot");
			});
		});
	}
	it("preserves a quoted Windows path", () => {
		assert.equal(
			leadingCdTarget('cd "C:\\Users\\example\\slot-2" && true'),
			"C:\\Users\\example\\slot-2",
		);
	});
});

describe("prCommandCwd — conservative invocation scanner", () => {
	for (const prefix of [
		"",
		"true\n",
		"true;",
		"true&&",
		"true&",
		"true &&\n",
		"true;\n",
		"true \\\n;",
	]) {
		it(`accepts certain cd after ${JSON.stringify(prefix)}`, () => {
			assert.equal(
				prCommandCwd(`${prefix}cd '${slot}' && ${PR}`, cwd, invocation),
				slot,
			);
		});
	}
	for (const delimiter of ["EOF", "'EOF'", '"EOF"', "-EOF"]) {
		it(`skips heredoc ${delimiter} including fake shell syntax`, () => {
			const tabs = delimiter === "-EOF" ? "\t" : "";
			assert.equal(
				prCommandCwd(
					`cat <<${delimiter}\n${tabs}if $(bad) \`bad\` { (\n${tabs}cd /fake && ${PR}\n${tabs}EOF\ncd '${slot}' && ${PR}`,
					cwd,
					invocation,
				),
				slot,
			);
		});
	}
	it("reads a whole-word heredoc delimiter before the real cd", () => {
		assert.equal(
			prCommandCwd(
				`cat <<EOF-X\nEOF\ncd /fake && ${PR}\nEOF-X\ncd '${slot}' && ${PR}`,
				cwd,
				invocation,
			),
			slot,
		);
	});
	it("accepts a literal double-quoted path", () => {
		assert.equal(
			path.normalize(
				prCommandCwd(
					`true; cd "${slot.replaceAll("\\", "/")}" && ${PR}`,
					cwd,
					invocation,
				),
			),
			slot,
		);
	});
	it("takes single-quoted shell metacharacters literally", () => {
		const literal = "literal$`\\*?![]{}()";
		assert.equal(
			prCommandCwd(`cd '${literal}' && ${PR}`, cwd, invocation),
			path.resolve(cwd, literal),
		);
	});
	it("retains redirection ampersands", () => {
		assert.equal(
			prCommandCwd(
				`true 2>&1 &>out; cd '${slot}' && ${PR}`,
				cwd,
				invocation,
			),
			slot,
		);
	});

	it("handles multiple queued heredocs", () => {
		assert.equal(
			prCommandCwd(
				`cat <<A <<'B'\na\nA\nb\nB\ncd '${slot}' && ${PR}`,
				cwd,
				invocation,
			),
			slot,
		);
	});
	it("resolves relative cd against payload cwd", () => {
		assert.equal(prCommandCwd(`cd slot && ${PR}`, cwd, invocation), slot);
	});
	it("refuses relative cd after a non-cd segment", () => {
		assert.equal(
			prCommandCwd(`true; cd ../slot-worktree && ${PR}`, cwd, invocation),
			null,
		);
	});
	it("refuses relative cd after an earlier absolute cd", () => {
		assert.equal(
			prCommandCwd(
				`cd '${slot}' && cd apps/web && gh pr create --fill`,
				cwd,
				(segment) => segment.includes("gh pr create"),
			),
			null,
		);
	});
	for (const prefix of [
		"pnpm lint || # lint may fail\n",
		"pnpm lint ||\n# lint may fail\n",
		"echo y | # feed\n",
	]) {
		it(`refuses commented operator ${JSON.stringify(prefix)}`, () => {
			assert.equal(
				prCommandCwd(
					`${prefix}cd '${slot}' && gh pr create --fill`,
					cwd,
					(segment) => segment.includes("gh pr create"),
				),
				null,
			);
		});
	}
	for (const redirect of [">&2", "2>&1", "&>out"]) {
		it(`retains ${redirect} inside the PR segment`, () => {
			assert.equal(
				prCommandCwd(
					`cd '${slot}' && open-pr.sh ${redirect} --title t --body-file b`,
					cwd,
					(segment) =>
						segment.includes("open-pr.sh") &&
						segment.includes("--title"),
				),
				slot,
			);
		});
	}
	for (const text of ["a#b", "'# quoted'", '"# quoted"']) {
		it(`allows literal hash in ${text}`, () => {
			assert.equal(
				prCommandCwd(
					`echo ${text}; cd '${slot}' && ${PR}`,
					cwd,
					invocation,
				),
				slot,
			);
		});
	}
	it("ignores comment syntax inside a heredoc body", () => {
		assert.equal(
			prCommandCwd(
				`cat <<EOF\n# <<NOPE\nEOF\ncd '${slot}' && ${PR}`,
				cwd,
				invocation,
			),
			slot,
		);
	});

	it("refuses relative cd without payload cwd", () => {
		assert.equal(
			prCommandCwd(`true; cd slot && ${PR}`, undefined, invocation),
			null,
		);
	});
	it("refuses absolute cd without payload cwd", () => {
		assert.equal(
			prCommandCwd(`true; cd '${slot}' && ${PR}`, undefined, invocation),
			null,
		);
	});
	it("expands only bare tilde in a later cd", () => {
		withHome(cwd, () =>
			assert.equal(
				path.normalize(
					prCommandCwd(`true; cd ~/slot && ${PR}`, cwd, invocation),
				),
				slot,
			),
		);
	});
	for (const target of ['"~/slot"', "'~/slot'"]) {
		it(`takes ${target} literally`, () => {
			withHome(cwd, () =>
				assert.equal(
					prCommandCwd(`cd ${target} && ${PR}`, cwd, invocation),
					path.join(cwd, "~", "slot"),
				),
			);
		});
	}
	it("leaves bare tilde literal with empty HOME", () => {
		withHome("", () =>
			assert.equal(
				prCommandCwd(`cd ~/slot && ${PR}`, cwd, invocation),
				path.join(cwd, "~", "slot"),
			),
		);
	});
	for (const [name, command] of refusedPrCwdCommands(slot)) {
		it(`refuses ${name}`, () =>
			assert.equal(prCommandCwd(command, cwd, invocation), null));
	}
	for (const keyword of [
		"if",
		"then",
		"else",
		"elif",
		"fi",
		"for",
		"while",
		"until",
		"do",
		"done",
		"case",
		"esac",
		"select",
		"function",
	]) {
		it(`refuses command-position keyword ${keyword}`, () =>
			assert.equal(
				prCommandCwd(
					`${keyword} true; cd '${slot}' && ${PR}`,
					cwd,
					invocation,
				),
				null,
			));
	}
	it("allows keywords and grouping characters inside quoted arguments", () => {
		assert.equal(
			prCommandCwd(
				`echo 'if () {} \`'; cd '${slot}' && ${PR}`,
				cwd,
				invocation,
			),
			slot,
		);
	});
});
