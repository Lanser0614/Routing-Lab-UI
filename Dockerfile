FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node ["server.js", "support.js", "leaflet-map.js", "Routing Lab.dc.html", "./"]
COPY --chown=node:node src ./src
COPY --chown=node:node test/fixtures ./test/fixtures
COPY --chown=node:node .env.example ./config/.env.default
COPY --chown=node:node docker ./docker
RUN mkdir -p /app/data && chown node:node /app /app/data \
    && chmod +x /app/docker/entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node --import dotenv/config -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server.js"]
