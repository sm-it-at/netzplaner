FROM python:3.13.17-alpine3.24@sha256:fa0bb0d0cd7c7d6cef30a69094d32ac2b71c7304c87c6107fec100e1ee4eda02

LABEL org.opencontainers.image.title="Netzplaner Scanner" \
      org.opencontainers.image.description="Optionaler, eingeschränkter Nmap-Dienst für freigegebene private IPv4-Netze" \
      org.opencontainers.image.version="1.2.1"

RUN apk add --no-cache nmap
WORKDIR /app
COPY server.py /app/server.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 101:101
EXPOSE 8090
CMD ["python", "-u", "/app/server.py"]
