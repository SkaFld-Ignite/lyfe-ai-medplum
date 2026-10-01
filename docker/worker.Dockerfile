# Image for the Lyfe import worker (services/lyfe-worker).
#
# Built from the repository root, not the service directory: the worker imports
# the importers from examples/medplum-provider/bots, and those import workspace
# packages. A context scoped to the service would resolve none of it.
#
# The workspace packages are BUILT here rather than copied in. That is not a
# preference — `dist/` is gitignored, so any build context that comes from a git
# checkout or a `railway up` upload simply does not contain it. Copying prebuilt
# output produces an image that builds on a developer's laptop, where dist
# happens to exist, and fails everywhere else.
#
# The worker itself runs TypeScript directly through tsx. The importers are
# ~4000 lines of .ts that the Medplum bot bundler also reads as source, and a
# second, different build of the same files is a way for the two to drift
# without anyone noticing.

# ---- Stage 1: build the workspace packages the worker depends on -------------
FROM node:22-slim AS build

WORKDIR /app

# Build tooling is needed because some workspace packages compile native deps.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json turbo.json ./
COPY packages ./packages
COPY examples/medplum-provider/package.json ./examples/medplum-provider/
COPY services/lyfe-worker/package.json ./services/lyfe-worker/

# Dev dependencies are required: these packages are compiled from source here.
RUN npm ci --ignore-scripts

# Only what the worker imports, rather than the whole monorepo.
RUN npx turbo run build --filter=@medplum/core --filter=@medplum/fhirtypes

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# node_modules and the freshly built package output, from the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json

COPY services/lyfe-worker ./services/lyfe-worker
COPY examples/medplum-provider/package.json ./examples/medplum-provider/
COPY examples/medplum-provider/bots ./examples/medplum-provider/bots

EXPOSE 3020

# tsx is invoked by its entry point rather than through npx or a .bin symlink.
# In a workspace install the binary lands under the service's own node_modules,
# not the root one npx searches, and the image then builds cleanly and fails to
# start — which is a slow way to learn this.
#
# Inngest calls /api/inngest; the app calls /api/imports/bulk.
CMD ["node", "services/lyfe-worker/node_modules/tsx/dist/cli.mjs", "services/lyfe-worker/src/server.ts"]
