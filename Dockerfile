# Terucon on Render: one Node process serves the website and the Design Studio (swatchroom/).
# The studio's local scan models (Python) run as their own service, see render.yaml.
FROM node:22-bookworm-slim

WORKDIR /app

# Packages first (cached unless they change). The Design Studio is an npm workspace, so its package.json has to be here too.
COPY package.json package-lock.json ./
COPY swatchroom/package.json swatchroom/package.json
RUN npm ci --omit=dev

# Python for the inspiration import (gallery-dl, python/requirements.txt), in the virtual environment the website looks for
# (python/.venv; .dockerignore keeps a local one out of the image). Before the code is copied, so it is cached until the
# requirements change. Without it the import still answers, with "not set up", for the sites that need gallery-dl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY python/requirements.txt python/requirements.txt
RUN python3 -m venv python/.venv && python/.venv/bin/pip install --no-cache-dir -r python/requirements.txt

COPY . .

# Render sets PORT; HOST must be 0.0.0.0 for its router to reach us.
ENV NODE_ENV=production \
    HOST=0.0.0.0

EXPOSE 8080
CMD ["node", "app.js"]
