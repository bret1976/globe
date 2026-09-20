FROM node:24.20.0-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    npm_config_audit=false \
    npm_config_fund=false

COPY package.json package-lock.json ./
# Vite is a devDependency but the hosted process still needs it for `vite preview`.
RUN npm ci --include=dev

# Client-exposed keys are baked into the Vite bundle at build time.
# Railway passes service variables as Docker build-args only when declared.
ARG CESIUM_ION_TOKEN=
ARG GOOGLE_MAPS_API_KEY=
ENV CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN \
    GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY

COPY . .
RUN npm run build

EXPOSE 8080

CMD ["node", "scripts/start-hosted.mjs"]
