# AgentCore Runtime requires an ARM64 image.
FROM --platform=linux/arm64 node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM --platform=linux/arm64 node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Only runtime dependencies — tsx and typescript stay in the build stage.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Contract: host 0.0.0.0, port 8080.
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
