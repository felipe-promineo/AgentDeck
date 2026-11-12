FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=8787 DATA_FILE=/data/relay-data.json
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
