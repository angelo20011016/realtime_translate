FROM python:3.13-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 443

CMD ["gunicorn", "--worker-class", "geventwebsocket.gunicorn.workers.GeventWebSocketWorker", "-b", "0.0.0.0:443", "app:app", "--certfile", "/certs/fullchain.pem", "--keyfile", "/certs/privkey.pem"]
