#!/usr/bin/env node

// Compatibility entrypoint copied to /app/run-standalone.mjs in Docker images.
// Railway services created with the old Start Command can keep running while
// the canonical launcher remains at /app/dev/run-standalone.mjs.
await import("./dev/run-standalone.mjs");
