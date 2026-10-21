# Ikkala frontend (admin + ochiq reyting) ni yig'ib, Caddy ichida statik beradi.
# Build konteksti: uchala repo ning ota papkasi (serverda /opt/yuksalish) —
# docker-compose.prod.yml da `context: ..` va `dockerfile: Yuksalish_backend/deploy/web.Dockerfile`.
# Ignore qoidalari: web.Dockerfile.dockerignore (BuildKit talab qilinadi).

FROM node:22-alpine AS admin
WORKDIR /app
COPY Yuksalish_Front/admin/package.json Yuksalish_Front/admin/package-lock.json ./
RUN npm ci
COPY Yuksalish_Front/admin/ ./
ARG VITE_PUBLIC_URL
# Vite da process.env dagi VITE_* o'zgaruvchilar .env.production fayldagidan ustun turadi
ENV VITE_API_BASE_URL=/api/v1 \
    VITE_PUBLIC_URL=$VITE_PUBLIC_URL
RUN npm run build

FROM node:22-alpine AS publik
WORKDIR /app
COPY Yuksalish-publik/package.json Yuksalish-publik/package-lock.json ./
RUN npm ci
COPY Yuksalish-publik/ ./
ENV VITE_API_BASE_URL=/api/v1
RUN npm run build

FROM caddy:2-alpine
COPY Yuksalish_backend/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=admin /app/dist /srv/admin
COPY --from=publik /app/dist /srv/public
