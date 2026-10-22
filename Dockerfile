FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951

LABEL org.opencontainers.image.title="Netzplaner" \
      org.opencontainers.image.description="Statischer Netzwerkplaner mit lokaler Speicherung im Browser" \
      org.opencontainers.image.version="1.2.1"

COPY nginx.conf /etc/nginx/nginx.conf
COPY public/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080
STOPSIGNAL SIGQUIT
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
