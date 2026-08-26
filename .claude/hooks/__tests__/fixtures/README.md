# Hook test fixtures

Prefer **inline JSON in test files** for simple cases — a `{ command: "rm -rf /" }`
object reads better right next to the assertion than a separate file.

Externalize to a `.json` file in this directory only when:

- the payload is large or has nontrivial nesting, or
- the same payload is reused across multiple test files.

Each fixture is a literal PreToolUse `tool_input` payload (just the inner
object — the test helper wraps it in `{ session_id, tool_name, tool_input }`).
