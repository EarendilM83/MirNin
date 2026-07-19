FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=4000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 4000
HEALTHCHECK --interval=60s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:4000/api/healthz || exit 1
CMD ["node", "server.js"]
