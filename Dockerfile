# ---- Stage 1: Install dependencies ----
FROM node:22-alpine AS deps

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# ---- Stage 2: Build the application ----
FROM node:22-alpine AS build

RUN apk add --no-cache openssl

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client and build the Remix app
RUN npx prisma generate
RUN npm run build

# ---- Stage 3: Production image ----
FROM node:22-alpine AS production

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package files and install production-only dependencies
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci --omit=dev && npm cache clean --force

# Remove the Shopify CLI -- not needed in production and it's large
RUN npm remove @shopify/cli 2>/dev/null || true

# Copy the generated Prisma client from the build stage
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy the built Remix app
COPY --from=build /app/build ./build

# Copy the startup script
COPY startup.sh ./startup.sh
RUN chmod +x ./startup.sh

EXPOSE 3000

# Run migrations and start the server
CMD ["./startup.sh"]
