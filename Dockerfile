# bookworm-slim (glibc): bcrypt tayyor binar fayli ishlaydi; alpine (musl) da native build muammosi bo'lishi mumkin
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# dist/src/server.js va dist/scripts/seed.js (superadmin yaratish) shu yerda hosil bo'ladi
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json package.json
COPY --from=build --chown=node:node /app/dist dist
# PDF hisobotlar uchun Unicode shriftlar (DejaVu Sans, ochiq litsenziya)
COPY --from=build --chown=node:node /app/assets assets
EXPOSE 4000
USER node
CMD ["node", "dist/src/server.js"]
