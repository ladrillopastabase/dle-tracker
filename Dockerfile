# Imagen para cualquier hosting con contenedores (Koyeb, Fly.io, Cloud Run, un VPS…).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY templates ./templates

RUN useradd --create-home dle && mkdir -p data && chown dle data
USER dle

EXPOSE 8000
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips '*'
