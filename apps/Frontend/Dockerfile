# Static web app for Railway (or any container host). Vite inlines VITE_* variables at build
# time, so VITE_API_BASE_URL must be available while the image is built: Railway passes service
# variables to the build as build arguments with the same name.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts tailwind.config.ts postcss.config.js ./
COPY src ./src
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# Unprivileged nginx renders /etc/nginx/templates/*.template with the container environment on
# start, so the server listens on the PORT Railway injects.
FROM nginxinc/nginx-unprivileged:1.28-alpine AS runtime
ENV PORT=8080
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
