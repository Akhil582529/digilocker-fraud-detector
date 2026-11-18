# ---------- build the React frontend ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# '/api' means the browser calls the same server that served the page (no CORS needed).
# For a frontend hosted elsewhere, build with: --build-arg VITE_API_BASE=https://your-api.example.com/api
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# ---------- runtime: API + built frontend ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY --from=build /app/dist ./dist

USER node
EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["sh", "-c", "wget -qO- http://localhost:${PORT:-5001}/api/health || exit 1"]

# bootstrap creates missing tables (never drops data), optionally seeds demo users, then starts the API
CMD ["node", "server/bootstrap.js"]
