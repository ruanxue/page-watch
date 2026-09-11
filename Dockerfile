FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3030
EXPOSE 3030
CMD ["npm", "run", "start"]
