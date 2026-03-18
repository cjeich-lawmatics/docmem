FROM node:22-slim

WORKDIR /app

# Install git for branch detection and staleness checks
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

# Copy source and build, then prune dev dependencies
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Default: run MCP server on stdio
CMD ["node", "dist/server.js"]
