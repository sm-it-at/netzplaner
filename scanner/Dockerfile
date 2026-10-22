FROM python:3.13-alpine

RUN apk add --no-cache nmap
WORKDIR /app
COPY server.py /app/server.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 101:101
EXPOSE 8090
CMD ["python", "-u", "/app/server.py"]
