FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
