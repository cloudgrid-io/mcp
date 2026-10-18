# CloudGrid MCP server — web edition, for hosting (e.g. GKE).
# Serves the light, CLI-free toolset over MCP Streamable HTTP. No cloudgrid CLI
# needed in the image: the web edition never registers the CLI-wrapping tools.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=8080
# Production mode for Express and its dependencies. The server answers errors
# itself (src/web-errors.js); this keeps any library default terse as well.
ENV NODE_ENV=production
EXPOSE 8080
USER node

CMD ["node", "src/web.js"]
