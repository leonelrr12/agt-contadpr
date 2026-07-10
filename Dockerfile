FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/agents/package.json packages/agents/
COPY packages/prisma-schema/package.json packages/prisma-schema/
COPY apps/web/package.json apps/web/
COPY turbo.json tsconfig.json ./

RUN npm ci

COPY . .

RUN npm run build
RUN npm run db:generate

FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl netcat-openbsd

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/agents/package.json packages/agents/
COPY packages/prisma-schema/package.json packages/prisma-schema/
COPY apps/web/package.json apps/web/
COPY turbo.json tsconfig.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/src ./packages/shared/src
COPY --from=builder /app/packages/agents/dist ./packages/agents/dist
COPY --from=builder /app/packages/agents/src ./packages/agents/src
COPY --from=builder /app/packages/prisma-schema/dist ./packages/prisma-schema/dist
COPY --from=builder /app/packages/prisma-schema/src ./packages/prisma-schema/src
COPY --from=builder /app/packages/prisma-schema/prisma ./packages/prisma-schema/prisma
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/src ./apps/api/src
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/apps/api/tsconfig.json ./apps/api/tsconfig.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["/entrypoint.sh"]
