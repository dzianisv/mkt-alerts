# mkt-alerts — containerized CLI + MCP server.
#
# Default command runs the MCP (Model Context Protocol) stdio server, so an MCP
# host can introspect and drive it in a container:
#
#   docker build -t mkt-alerts .
#   docker run --rm -i \
#     -v "$HOME/.config/mkt-watch:/root/.config/mkt-watch:ro" \
#     mkt-alerts            # runs `mcp` (stdio)
#
# The entrypoint is the CLI, so any subcommand works too:
#
#   docker run --rm mkt-alerts --help
#   docker run --rm -v "$HOME/.config/mkt-watch:/root/.config/mkt-watch:ro" mkt-alerts list
#
# initialize / tools/list need no auth (lazy auth); tool CALLS read the daemon
# URL + token from ~/.config/mkt-watch/auth.json, mounted at runtime.

# ── build stage: bundle mkt-alerts.ts -> dist/mkt-alerts.js (node target) ──────
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json mkt-alerts.ts ./
RUN bun build mkt-alerts.ts --outfile dist/mkt-alerts.js --target node

# ── runtime stage: tiny node image, no bun, no build tooling ───────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/mkt-alerts.js ./dist/mkt-alerts.js
COPY package.json ./
ENTRYPOINT ["node", "dist/mkt-alerts.js"]
CMD ["mcp"]
