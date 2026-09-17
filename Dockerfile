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

COPY . .
RUN npm run build

EXPOSE 8080

CMD ["node", "scripts/start-hosted.mjs"]
