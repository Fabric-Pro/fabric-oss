FROM docker.io/cloudflare/sandbox:0.6.7

# Install Claude Code CLI for AI-assisted code changes
RUN npm install -g @anthropic-ai/claude-code

# Install common development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Configure git defaults
RUN git config --global init.defaultBranch main \
    && git config --global user.email "fabric-sandbox@fabric.ai" \
    && git config --global user.name "Fabric Sandbox"

# Chromium + its shared libraries, for sandbox-executed browser tests (Mode B).
#
# This image previously had NO browser binary at all — it is
# `cloudflare/sandbox` plus the Claude Code CLI, git, curl and jq. That is the
# SAME trap the temporal worker shipped with: `playwright` is a Node library, so
# installing the package gets you an API and no browser, and a base image lacks
# the shared libraries Chromium needs regardless. Anything calling
# `chromium.launch()` in here failed at runtime with "Executable doesn't exist",
# which is why Mode A could not have worked no matter what was tested.
#
# Pinned to the version `@repo/temporal` depends on. A sandbox that runs a
# generated Playwright script against a DIFFERENT Playwright than the one the
# script was written for is a debugging problem nobody should be handed, and the
# browser build is downloaded by the same `playwright` that will import it.
#
# `install-deps` installs the apt packages and must run as root — it is, this
# image has no USER switch.
#
# PLAYWRIGHT_BROWSERS_PATH puts the browser in a shared, world-readable location
# rather than root's HOME, so a generated script run as any user can reach it.
#
# The `node -e` line then launches the browser the LIBRARY resolves and asserts
# it runs. Without it the two failure modes this layer exists to prevent — no
# binary, or a binary whose revision the library rejects — stay invisible until
# a run fails in production, which is exactly how the last one stayed hidden for
# the feature's entire life. A broken image now fails the BUILD, and the PR-time
# `docker-build-check.yml` gate runs that build.
#
# WHY THE HEADLESS SHELL AND NOT THE FULL BROWSER
# `playwright install chromium` fetches TWO builds — `chromium-<rev>` (357 MB)
# and `chromium_headless_shell-<rev>` (251 MB) — plus ffmpeg for video capture.
# Since Playwright 1.49 a `launch({ headless: true })` runs the headless shell,
# so on a container that can never open a display the full build is 357 MB that
# is downloaded, stored, and never executed.
#
# Verified rather than assumed: deleting `/ms-playwright/chromium-1200` from the
# built image and launching headless still works and still reports
# 143.0.7499.4. Nothing in this repo passes `headless: false`.
#
# The consequence to know: this image can ONLY run headless. If a caller ever
# needs a headed browser here, this line has to go back to `install chromium` —
# the failure would otherwise be the "Executable doesn't exist" one this whole
# layer exists to prevent.
#
# Cost after trimming, measured with `docker history` on the built image:
# **735 MB** for this layer (was 1.15 GB) and **2.52 GB** total (was 3.11 GB),
# from a 761 MB base. The image saves more than the layer because dropping the
# npm cache and /tmp shrinks earlier layers' contribution too.
#
# Cloudflare caps an image at the instance's disk size and `standard-3`
# (wrangler.toml) allows 16 GB, so this sits well under the ceiling — but on
# `basic` (4 GB) it would not deploy.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# `apt-get update` first: the tools layer above ends with `rm -rf
# /var/lib/apt/lists/*`, so `install-deps` — which is a wrapper around `apt-get
# install` — would otherwise run against an empty package index and fail to
# resolve a single Chromium library.
#
# The assertion LAUNCHES the browser headless rather than exec'ing `--version`.
# Same spirit, more of the truth: a version string proves a binary is executable,
# where a launch proves the shared libraries resolve, the sandbox is permitted
# and the exact call production makes actually works. It is also the only form
# that stays honest now that the full build is absent — `executablePath()` points
# at a binary this image deliberately no longer ships.
#
# `npm cache clean` matters here: `npm install -g` leaves the tarballs in
# /root/.npm, which is pure dead weight in a layer nothing will install into again.
RUN npm install -g playwright@1.57.0 \
    && apt-get update \
    && playwright install-deps chromium \
    && playwright install chromium-headless-shell \
    && node -e "const {chromium}=require('/usr/local/lib/node_modules/playwright');chromium.launch({headless:true}).then(async b=>{const p=await b.newPage();await p.setContent('<h1>ok</h1>');console.log('chromium launched headless:',b.version());await b.close();}).catch(e=>{console.error(e);process.exit(1)})" \
    && chmod -R a+rX /ms-playwright \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# Longer timeout for Claude Code operations (5 minutes)
ENV COMMAND_TIMEOUT_MS=300000

# Port 3000 is used by the sandbox SDK internally
EXPOSE 3000
