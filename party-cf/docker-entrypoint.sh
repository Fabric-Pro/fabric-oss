#!/bin/sh
# Bridge container environment variables into workerd `env` bindings.
#
# Under wrangler, `this.env.X` is populated from wrangler.toml [vars], --var
# flags, or a .dev.vars file — NOT from the container's process environment. So
# we materialize the runtime config the server actually reads (FABRIC_API_URL,
# AGENT_SERVICE_SECRET, PARTYKIT_ENV) into .dev.vars at startup. Secrets stay in
# a file rather than argv (not visible via `ps`).
set -e

DEV_VARS=".dev.vars"
: > "$DEV_VARS"

for key in PARTYKIT_ENV FABRIC_API_URL AGENT_SERVICE_SECRET; do
  eval "value=\${$key:-}"
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$DEV_VARS"
  fi
done

exec npx wrangler dev --ip 0.0.0.0 --port "${PARTYKIT_PORT:-1999}" --persist-to /data
