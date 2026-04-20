FROM node:20-alpine

RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/community" >> /etc/apk/repositories \
    && apk add --no-cache nginx nginx-mod-http-headers-more nginx-mod-http-brotli \
    && mkdir -p /usr/share/nginx/html /run/nginx /etc/nginx/http.d \
    && rm -rf /usr/share/nginx/html/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js logger.js app-config.js request-services.js whatsapp-sender.js app-startup.js operational-alerts.js lumina-billing.js customer-auth.js admin-observability.js admin-routes.js public-routes.js course-routes.js stripe-routes.js course-reminders.js course-engagement.js auth-utils.js health-routes.js site-helpers.js course-catalog.js course-access.js customer-store.js ./
COPY public/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
COPY admin/ /usr/share/nginx/html/admin/
RUN chmod -R a+rX /usr/share/nginx/html/admin
COPY nginx-main.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
CMD ["/entrypoint.sh"]
