FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir Telethon==1.45.0 aiohttp==3.14.5 qrcode==8.2 py-tgcalls==3.0.1 ntgcalls==3.0.7
COPY bridge.py calls.py /app/
RUN install -d -m 0700 -o 10001 -g 10001 /state
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python", "/app/bridge.py"]
CMD ["serve"]
