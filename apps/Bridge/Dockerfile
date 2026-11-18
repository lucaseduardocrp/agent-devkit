FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
# The AI CLIs the bridge can drive. Remove one to slim the image; add others (and register them
# in src/cli) as needed. Pin versions here for reproducible builds.
ARG BRIDGE_CLIS="@anthropic-ai/claude-code @openai/codex @google/gemini-cli"
# `upgrade` brings the Debian packages of the base image to their latest security fixes.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g ${BRIDGE_CLIS} \
    && mkdir -p /workspace /homes /data \
    && chmod 755 /workspace /homes \
    && chmod 700 /data

ENV NODE_ENV=production \
    BRIDGE_WORKDIR=/workspace \
    BRIDGE_HOMES_DIR=/homes \
    BRIDGE_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
# The bridge runs as root only to give every user their own OS user (uid 20001+): each CLI runs
# as that user, with a 0700 HOME and project directory, so users cannot read each other. The
# credentials file in /data is 0600 root and never reaches a CLI. Claude Code accepts
# --dangerously-skip-permissions because the CLI itself is not root.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "process.exit(Date.now()-require('fs').statSync((process.env.BRIDGE_DATA_DIR||'/data')+'/heartbeat').mtimeMs<120000?0:1)"
CMD ["node", "dist/src/main.js"]
