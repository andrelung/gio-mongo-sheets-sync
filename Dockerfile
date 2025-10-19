# Multi-stage Dockerfile: build TypeScript then run production image

FROM node:20-alpine AS builder
WORKDIR /app

# Install build deps
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY . ./
RUN npm run build

# Production image
FROM node:20-alpine
WORKDIR /app

# Only install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy credentials only if you want them baked in (recommended to mount at runtime)
# COPY ./credentials ./credentials

ENV NODE_ENV=production

# Run the compiled JS
CMD ["node", "dist/main.js"]
