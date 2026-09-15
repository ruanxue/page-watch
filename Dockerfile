# Chromium-only runtime image.  The former Playwright base image bundles
# Chromium, Firefox, WebKit and their full development environment; Page Watch
# only uses Chromium for browser-rendered checks.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:server && npm run build

FROM node:22-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3030
ENV PLAYWRIGHT_HEADLESS=true
EXPOSE 3030
CMD ["node", "build/server/all-in-one.js"]
