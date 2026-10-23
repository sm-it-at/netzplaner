FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951

LABEL org.opencontainers.image.title="Netzplaner" \
      org.opencontainers.image.description="Netzwerkplaner mit lokaler Speicherung im Browser und optionalem Nmap-Scanner" \
      org.opencontainers.image.version="1.3.1"

# Alpine 3.24: python3 3.14, nmap 7.99, tini 0.19.
RUN apk add --no-cache python3 nmap tini

COPY nginx.conf /etc/nginx/nginx.conf
COPY public/ /usr/share/nginx/html/
COPY scanner/server.py /opt/netzplaner/server.py
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/netzplaner-entrypoint
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/netzplaner-health

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 101:101
EXPOSE 8080
# The scanner shuts down cleanly on SIGTERM; tini -g passes it to every process.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["/usr/local/bin/netzplaner-health"]
ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/bin/netzplaner-entrypoint"]
