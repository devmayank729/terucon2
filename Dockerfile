# Terucon on Render: Express serves the site; it starts the Python model service as a child process.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python packages first (cached unless requirements change). Express finds /app/.venv on its own.
COPY model/requirements.txt model/requirements.txt
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r model/requirements.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Render sets PORT; HOST must be 0.0.0.0 for its router to reach us.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    MODEL_SERVICE=auto

EXPOSE 8080
CMD ["node", "app.js"]
