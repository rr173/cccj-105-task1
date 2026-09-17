FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
VOLUME /app/data
CMD ["node", "src/index.js"]
