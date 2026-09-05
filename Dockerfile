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
