# Medplum AWS production Dockerfile
#
# Identical to server.Dockerfile except it builds from the public node:24-slim
# image instead of dhi.io's Docker Hardened Images, which require a paid DHI
# entitlement this account doesn't have. Same app, same entrypoint; slightly
# less hardened base image since it isn't vendor-minimized the way DHI is.

# This Dockerfile depends on files created by scripts/build-docker-server.sh:
#  1. `medplum-server-metadata.tar.gz` - contains package.json and package-lock.json files
#  2. `medplum-server-runtime.tar.gz` - contains the compiled JavaScript files and other runtime assets

# The archive files are decompressed and extracted into the specified destinations.
# We do this to preserve the folder structure in a single layer.
# See: https://docs.docker.com/reference/dockerfile/#adding-local-tar-archives

# Stage 1: Build the application and install production dependencies
FROM node:24.18-slim AS build-stage
ENV NODE_ENV=production
WORKDIR /usr/src/medplum
ADD ./medplum-server-metadata.tar.gz ./
RUN npm ci --omit=dev && \
  rm package-lock.json

# Stage 2: Create the runtime image
FROM node:24.18-slim AS runtime-stage
ENV NODE_ENV=production
WORKDIR /usr/src/medplum
COPY --from=build-stage /usr/src/medplum/ ./
ADD ./medplum-server-runtime.tar.gz ./

EXPOSE 5000 8103

ENTRYPOINT [ "node", "--experimental-loader=@opentelemetry/instrumentation/hook.mjs", "--import", "./packages/server/dist/otel/instrumentation.js", "packages/server/dist/index.js" ]
