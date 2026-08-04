# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# ArdaLink Marketing site — static HTML/CSS/JS, no build step (see README.md).
# Single-stage nginx image, same runtime base + conventions as ardalink-web's
# Dockerfile (nginx:1.27-alpine, /healthz, security headers, asset caching).
# -----------------------------------------------------------------------------

FROM nginx:1.27-alpine
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
EXPOSE 80
