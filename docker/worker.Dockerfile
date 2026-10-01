# Image for the Lyfe import worker (services/lyfe-worker).
#
# Built from the repository root, not the service directory: the worker imports
# the importers from examples/medplum-provider/bots, and those import workspace
# packages. A context scoped to the service would resolve none of it.
#
# The worker runs TypeScript directly through tsx rather than being compiled.
# The importers are ~4000 lines of .ts that the Medplum bot bundler also reads
# as source; adding a second, different build of the same files is a way for
# the two to drift without anyone noticing.
FROM node:22-slim

WORKDIR /app

# Dependency manifests first, so a code change does not reinstall the world.
COPY package.json package-lock.json turbo.json ./
COPY services/lyfe-worker/package.json ./services/lyfe-worker/
COPY examples/medplum-provider/package.json ./examples/medplum-provider/
COPY packages ./packages

RUN npm ci --omit=dev --ignore-scripts --workspace @lyfe/worker --include-workspace-root \
  || npm install --omit=dev --ignore-scripts

COPY services/lyfe-worker ./services/lyfe-worker
COPY examples/medplum-provider/bots ./examples/medplum-provider/bots

ENV NODE_ENV=production
EXPOSE 3020

# tsx is invoked by its entry point rather than through npx or a .bin symlink.
# In a workspace install the binary lands under the service's own node_modules,
# not the root one npx searches, and the image then builds cleanly and fails to
# start — which is a slow way to learn this.
#
# Inngest calls /api/inngest; the app calls /api/imports/bulk.
CMD ["node", "services/lyfe-worker/node_modules/tsx/dist/cli.mjs", "services/lyfe-worker/src/server.ts"]
