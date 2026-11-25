FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache git docker-cli docker-cli-compose curl caddy

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/server ./server

ENV NODE_ENV=production
EXPOSE 3000

CMD ["./node_modules/.bin/tsx", "server.ts"]
