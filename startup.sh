#!/bin/sh
set -e

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Starting Remix server..."
exec npx remix-serve ./build/server/index.js
