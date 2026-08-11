FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY data ./data
EXPOSE 8080
CMD ["npm", "start"]
