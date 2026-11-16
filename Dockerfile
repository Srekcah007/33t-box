FROM node:20-alpine

# Dépendances de compilation natives requises pour better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++

COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data /app/covers

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
