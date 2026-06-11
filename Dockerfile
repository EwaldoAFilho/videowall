# VideoWall — servidor (painel administrativo + player web + API)
# Imagem mínima: o projeto usa apenas a biblioteca padrão do Python (sem pip).
FROM python:3.12-slim

WORKDIR /app

# Código da aplicação (dados ficam em /data, montado como volume)
COPY app/ ./app/
COPY static/ ./static/
COPY run.py ./run.py

# Configuração padrão para container:
#  - escuta em todas as interfaces do container (o mapeamento de porta controla a exposição)
#  - dados (banco, mídia, logs, backups) persistidos em /data
ENV VIDEOWALL_BIND=0.0.0.0 \
    VIDEOWALL_PORT=8777 \
    VIDEOWALL_DATA=/data \
    PYTHONUNBUFFERED=1

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8777/login', timeout=3)" || exit 1

CMD ["python3", "run.py"]
