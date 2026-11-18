FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY . .
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.js"]
