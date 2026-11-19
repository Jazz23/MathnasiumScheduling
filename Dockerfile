FROM oven/bun:1.4.3-alpine
WORKDIR /app

# Install deps first so this layer is cached until the lockfile changes
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Only what the server needs at runtime; nothing else enters the image
COPY bunfig.toml tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# Bun.serve() listens on $PORT (defaults to 3000)
EXPOSE 3000
USER bun
CMD ["bun", "src/index.ts"]
