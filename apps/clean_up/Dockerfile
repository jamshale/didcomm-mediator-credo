FROM node:22 AS base

RUN apt-get update && \
  apt-get upgrade -y && \
  npm install -g corepack@latest && \
  corepack enable && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

FROM base AS build

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/clean_up/package.json ./apps/clean_up/package.json

RUN pnpm install --frozen-lockfile

COPY apps/clean_up ./apps/clean_up

RUN pnpm --filter credo-mediator-cleanup-ts build

FROM node:22 AS final

WORKDIR /app

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/clean_up/package.json ./apps/clean_up/package.json
COPY --from=build /workspace/apps/clean_up/dist ./apps/clean_up/dist

WORKDIR /app/apps/clean_up

CMD ["node", "dist/main.js"]