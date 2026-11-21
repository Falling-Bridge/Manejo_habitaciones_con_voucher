FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache sqlite
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 3003
CMD ["node", "src/index.js"]