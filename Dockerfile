#################################################
# Common base image
#################################################
FROM node:22-alpine as common
# tini gives the container a real init, so SIGTERM reaches node and the
# graceful-shutdown handler in src/index.ts can drain connections.
RUN apk add --no-cache tini && mkdir /app && chown node:node /app
WORKDIR /app
USER node

# Cache node_modules installation as they change
# less than code over time.
COPY --chown=node:node package.json yarn.lock tsconfig.json ./
RUN yarn install --production --frozen-lockfile && \
    rm -rf ~/.cache /tmp/v8-compile-cache-1000

#################################################
# Compile stage
#################################################
FROM common as build
RUN yarn install --frozen-lockfile
COPY --chown=node:node src/ src/
# tsconfig.json includes types/, so it has to be present or the build fails
# under noEmitOnError.
COPY --chown=node:node types/ types/
RUN yarn compile

#################################################
# Web client stage (the page served at /app)
#################################################
# Debian rather than alpine: upstream pins .nvmrc 24.19.0 and its toolchain pulls
# prebuilt binaries that expect glibc.
FROM node:24-bookworm-slim as webclient
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# The client is cloned rather than vendored, so this repo stays a signaling server
# instead of carrying a second copy of an Angular app. Pinned to a commit: the
# patches are written against this exact tree, so moving it means re-checking them.
ARG WEBCLIENT_REPO=https://github.com/OhMyGuus/BetterCrewlink-mobile.git
ARG WEBCLIENT_COMMIT=8bc441fee5424c82431fc7b0c6fc73ff3ea99858
RUN git clone "$WEBCLIENT_REPO" app \
    && cd app && git -c advice.detachedHead=false checkout "$WEBCLIENT_COMMIT"
WORKDIR /build/app
COPY web/patches/ /build/patches/
RUN for p in /build/patches/*.patch; do echo "applying $p"; git apply "$p"; done
# bcl-mobile-overlay is a file: dependency whose entry point is dist/, which upstream
# does not commit -- game-helper.service.ts will not resolve without it. It is an
# Android overlay that does nothing on the web, but it still has to build.
RUN cd plugins/bcl-mobile-overlay && npm ci --ignore-scripts && npm run build
RUN npm ci --ignore-scripts
# --base-href has to match the mount point in src/index.ts.
RUN npx ng build --configuration production --base-href /app/

#################################################
# Production stage
#################################################
FROM common
# Enables the Express view cache and skips dev-mode checks.
ENV NODE_ENV=production
COPY views/ views/
# It's a toss up on which order offsets and src
# should be. Offsets are gauranteed to change
# over time, but src has more changes in `git log`.
COPY public/ public/
# Served at /app; src/index.ts detects its absence and hides the link rather than
# 404ing, so a build without this stage still runs.
COPY --from=webclient /build/app/www/ webclient/
COPY --from=build /app/dist/ dist
EXPOSE 9736
# Only needed when integratedRelay is enabled; must match minPort/maxPort in
# config/peerConfig.yml. Prefer --network host for the relay, since Docker
# bridge networking spawns a docker-proxy per published UDP port.
EXPOSE 3478/udp
EXPOSE 49152-50152/udp
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||9736)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
