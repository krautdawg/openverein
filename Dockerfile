# One image: API + built web app. Node 24 runs the TypeScript sources directly (type stripping).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3300
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY src/server ./src/server
COPY src/shared ./src/shared
USER node
EXPOSE 3300
CMD ["node", "src/server/index.ts"]
