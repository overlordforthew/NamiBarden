FROM alpine:3.23
RUN apk add --no-cache nginx nginx-mod-http-headers-more \
    && mkdir -p /usr/share/nginx/html /run/nginx /etc/nginx/http.d \
    && rm -rf /usr/share/nginx/html/*
COPY public/ /usr/share/nginx/html/
COPY nginx-main.conf /etc/nginx/nginx.conf
COPY nginx.conf /etc/nginx/http.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
