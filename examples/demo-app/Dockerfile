FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY examples ./examples
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /repo/examples/demo-app/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
ENV PORT=3000
ENV ARGUS_DEMO_DB=/data/demo.db
EXPOSE 3000
CMD ["node", "dist/server.js"]
