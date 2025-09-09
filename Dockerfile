FROM python:3.13-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN echo "build_trigger_$(date +%s)"
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD bash -c 'PYTHONPATH=. gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker -b 0.0.0.0:$PORT app:app'


