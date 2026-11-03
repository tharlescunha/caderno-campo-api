# Etapa 1: compila o TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Etapa 2: imagem final, só o necessário e sem root
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
# photos, audios and attachments (a Docker volume is mounted here; docs/banco-de-dados.md, section 8)
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
