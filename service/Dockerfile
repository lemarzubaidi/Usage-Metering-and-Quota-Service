# ---- stage 1: compile TypeScript (also used to run the tests: it has the dev dependencies) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations
RUN npm run build

# ---- stage 2: the small image that actually runs (no TypeScript, no test tools) ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/server.js"]
