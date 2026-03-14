FROM node:20-alpine

RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/community" >> /etc/apk/repositories \
    && apk add --no-cache nginx nginx-mod-http-headers-more nginx-mod-http-brotli \
    && mkdir -p /usr/share/nginx/html /run/nginx /etc/nginx/http.d \
    && rm -rf /usr/share/nginx/html/*

WORKDIR /app
COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ /usr/share/nginx/html/
RUN find /usr/share/nginx/html -type d -exec chmod 755 {} ; && find /usr/share/nginx/html -type f -exec chmod 644 {} ;
COPY admin/ /usr/share/nginx/html/admin/
COPY nginx-main.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
CMD ["/entrypoint.sh"]
