FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=10000 FLUXO_MULTI=1 FLUXO_TRUST_PROXY=1 FLUXO_DB=/data/fluxo.db
EXPOSE 10000
CMD ["node", "--no-warnings", "server/src/index.js"]
