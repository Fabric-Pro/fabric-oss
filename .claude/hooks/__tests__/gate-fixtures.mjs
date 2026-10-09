/**
 * Commands that the pr-quality-gate must gate. Shared by the gate test and
 * the settings-routing test, so the settings.json prefilter is checked against
 * exactly the inputs the script gates.
 */
export const GATED_GH_API_COMMANDS = [
	"gh api -X POST repos/o/r/pulls --input body.json",
	`jq -n '{title:"t"}' | gh api repos/o/r/pulls --input -`,
	"gh api repos/o/r/pulls -f title=t -f head=x -f base=staging",
	"gh api --method=POST /repos/{owner}/{repo}/pulls -f title=t",
	"timeout 60 gh api -X POST repos/o/r/pulls --input -",
	"gh api -X PATCH repos/o/r/pulls/5 -f body=x",
	"gh api -X PATCH repos/o/r/pulls/5 --input -",
	"gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
	"GH_TOKEN=x gh api -XPOST repos/o/r/pulls -fbase=staging",
	"cd /tmp && gh api --method POST repos/o/r/pulls?x=1 --input -",
	"gh api -X PATCH repos/o/r/pulls/5 -F body=@body.md",
	"bash -c 'gh api -X POST repos/o/r/pulls --input -'",
	"gh api -X=PATCH repos/o/r/pulls/5 -f body=x",
	"gh api repos/o/r/pulls/5 -X PATCH -f=body=x",
	"gh api -iX PATCH repos/o/r/pulls/5 -f body=x",
	"gh api -iXPATCH repos/o/r/pulls/5 -f body=x",
	"gh api -X=POST repos/o/r/pulls --input -",
	"gh api graphql --input payload.json",
	"gh api graphql --input -",
	"gh api graphql -F query=@q.graphql",
	"gh\tapi -X POST repos/o/r/pulls --input -",
	"gh  api -X POST repos/o/r/pulls --input -",
	"gh \\\napi -X POST repos/o/r/pulls --input -",
];
