FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src/ ./src/
EXPOSE 3457
CMD ["bun", "run", "src/server.ts"]
