FROM node:24-slim
WORKDIR /app
COPY --chown=node:node package.json cloud.mjs ringer.mjs live.mjs dialing.mjs telegram-call.mjs relay-client.mjs ./
USER node
EXPOSE 8080
CMD ["node", "cloud.mjs"]
