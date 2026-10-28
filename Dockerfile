# Terucon on Render: one Node process serves the website and the Design Studio (swatchroom/).
# The studio's local scan models (Python) run as their own service, see render.yaml.
FROM node:22-bookworm-slim

WORKDIR /app

# Packages first (cached unless they change). The Design Studio is an npm workspace, so its package.json has to be here too.
COPY package.json package-lock.json ./
COPY swatchroom/package.json swatchroom/package.json
RUN npm ci --omit=dev

COPY . .

# Render sets PORT; HOST must be 0.0.0.0 for its router to reach us.
ENV NODE_ENV=production \
    HOST=0.0.0.0

EXPOSE 8080
CMD ["node", "app.js"]
