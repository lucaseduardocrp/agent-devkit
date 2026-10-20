# Remote/team MCP server (Streamable HTTP on /mcp). Each request carries the user's own ADK token.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    ADK_MCP_HTTP_HOST=0.0.0.0 \
    ADK_MCP_TRUST_PROXY=true
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY skills ./skills
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-3333}/healthz" || exit 1
CMD ["node", "dist/src/bin/devkit-mcp.js", "http"]
