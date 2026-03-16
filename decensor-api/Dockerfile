FROM python:3.12-slim

WORKDIR /app

# Install Docker CLI from official binaries
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-24.0.7.tgz | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && apt-get remove -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 5030

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5030"]
