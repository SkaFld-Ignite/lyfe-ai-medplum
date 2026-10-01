# Image for the Lyfe import worker (services/lyfe-worker).
#
# Deliberately NOT a monorepo build.
#
# The worker needs @medplum/core and @medplum/fhirtypes, and the obvious move
# is to build them from the workspace. Two attempts at that were wrong in
# different ways: copying their prebuilt `dist` produces an image that only
# builds on a machine that happens to have it, because `dist/` is gitignored
# and absent from any git checkout; and building them in the image drags in
# `tsc && esbuild && api-extractor && api-documenter` per package, for output
# identical to what is already on npm.
#
# This fork has never modified either package, so the published 5.1.42 is the
# same code. The image installs those two from npm and copies only the worker
# and the importers it runs — which is why the build context here is small
# enough to matter and the build has nothing in it that can drift.
#
# If the fork ever does patch @medplum/core, this stops being true and the
# dependency has to go back to the workspace. The pin below is what makes that
# break loudly rather than silently.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY services/lyfe-worker/package.json ./package.json

# Pinned exactly, not by range: the worker runs importers written against this
# API, and a silent minor bump is not something a deploy should decide.
RUN npm install --omit=dev --no-audit --no-fund \
      @medplum/core@5.1.42 \
      @medplum/fhirtypes@5.1.42 \
      inngest \
      tsx

# The worker, and the importers it runs. The repository's directory shape is
# kept rather than flattened, because the worker imports the importers by
# relative path — a flat layout would mean rewriting those paths for the image
# only, so the source would read one way and run another.
#
# The importers stay TypeScript source rather than being compiled: the Medplum
# bot bundler reads the same files, and a second, different build of them is a
# way for the two to drift unnoticed.
COPY services/lyfe-worker/src ./services/lyfe-worker/src
COPY examples/medplum-provider/bots ./examples/medplum-provider/bots

EXPOSE 3020

# tsx by its entry point rather than through npx: npx searches a .bin that a
# workspace install does not populate where you expect, and the image then
# builds cleanly and fails to start.
#
# Inngest calls /api/inngest; the app calls /api/imports/bulk.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "services/lyfe-worker/src/server.ts"]
