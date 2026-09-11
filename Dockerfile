# Chromium-only runtime image.  The former Playwright base image bundles
# Chromium, Firefox, WebKit and their full development environment; Page Watch
# only uses Chromium for browser-rendered checks.
FROM node:22-bookworm-slim

WORKDIR /app

# Keep the downloaded browser outside the npm cache and make the same location
# available at runtime.  This must be set before `playwright install`.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3030
ENV PLAYWRIGHT_HEADLESS=true
EXPOSE 3030
CMD ["npm", "run", "all-in-one"]
