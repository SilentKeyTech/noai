# The relay alone, for Nebius Serverless (or any container host).
# Build from the repo root:  docker build -f relay/Dockerfile -t noai-relay .
# Run with NEBIUS_API_KEY and NOAI_ALLOWED_ORIGINS set in the host's secret store.
FROM node:22-alpine
WORKDIR /app
COPY src/prompt.ts src/redact.ts src/types.ts ./src/
COPY relay/core.mjs relay/serve.mjs ./relay/
ENV NOAI_RELAY_ONLY=1 PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "relay/serve.mjs"]
