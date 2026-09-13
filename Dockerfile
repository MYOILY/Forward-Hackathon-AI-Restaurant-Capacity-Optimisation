FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TABLEWATCH_API_HOST=0.0.0.0 TABLEWATCH_API_PORT=8000 \
    TABLEWATCH_DATA_DIR=/data TABLEWATCH_MODEL_DIR=/models \
    TABLEWATCH_STATIC_DIR=/app/dist OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY requirements.lock.txt pyproject.toml ./
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY processor ./processor
COPY evaluator ./evaluator
COPY service ./service
COPY shared ./shared
COPY --from=frontend /app/node_modules ./node_modules
COPY scripts/start_service.py scripts/validate_deployment.py ./scripts/
COPY --from=frontend /app/package.json ./package.json
COPY --from=frontend /app/dist ./dist
COPY web/src ./web/src
RUN pip install --no-cache-dir --no-deps . \
    && groupadd --gid 10001 tablewatch && useradd --uid 10001 --gid tablewatch --no-create-home tablewatch \
    && mkdir /data /models && chown tablewatch:tablewatch /data
USER tablewatch
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/live', timeout=4)" || exit 1
CMD ["python", "scripts/start_service.py"]
