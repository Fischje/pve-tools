# pve-disk-tool als Container. Braucht nur Node und den SSH-Client.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY host-setup ./host-setup
ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
