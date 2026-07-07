# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV COMPANION_HOME=/data
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && npm install -g @moxxy/cli \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
EXPOSE 8901
VOLUME ["/data"]
CMD ["pnpm", "--filter", "companiond", "start"]
