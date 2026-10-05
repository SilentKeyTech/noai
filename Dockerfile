# NOAI gateway. Untested image: no Docker on the machine this was written on.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NOAI_HOME=/data NOAI_GATEWAY_HOST=0.0.0.0 NOAI_GATEWAY_PORT=7794
VOLUME /data
EXPOSE 7794
# Set at run time, never in the image: NOAI_PASSPHRASE, NOAI_GATEWAY_TOKENS, NOAI_GATEWAY_UPSTREAM, NOAI_GATEWAY_KEY, NOAI_MODEL
CMD ["node", "src/gateway-serve.ts"]
