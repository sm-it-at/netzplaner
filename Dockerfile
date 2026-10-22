FROM nginx:1.30.6-alpine@sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576

LABEL org.opencontainers.image.title="Netzplaner" \
      org.opencontainers.image.description="Statischer Netzwerkplaner mit lokaler Speicherung im Browser" \
      org.opencontainers.image.version="1.1.0"

COPY nginx.conf /etc/nginx/nginx.conf
COPY public/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080
STOPSIGNAL SIGQUIT
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
