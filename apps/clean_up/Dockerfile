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

RUN pnpm install --node-linker=hoisted --frozen-lockfile

COPY apps/clean_up ./apps/clean_up

RUN pnpm --filter credo-mediator-cleanup-ts build && \
  pnpm prune --prod

FROM node:22 AS final

WORKDIR /app

RUN addgroup --system --gid 1001 agent && \
  adduser --system --uid 1001 --ingroup agent agent

COPY --from=build --chown=agent:agent /workspace/node_modules ./node_modules
COPY --from=build --chown=agent:agent /workspace/apps/clean_up/package.json ./apps/clean_up/package.json
COPY --from=build --chown=agent:agent /workspace/apps/clean_up/build ./apps/clean_up/build

WORKDIR /app/apps/clean_up

USER agent

CMD ["node", "build/main.js"]