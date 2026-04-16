FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY server/ server/
COPY client/ client/
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && rm -rf /root/.npm

COPY server/ server/
COPY --from=build /app/client/dist client/dist

ENV PORT=4000
ENV DB_PATH=/app/data/parser.db
EXPOSE 4000

CMD ["node", "server/index.js"]
