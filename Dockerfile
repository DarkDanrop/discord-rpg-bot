FROM node:20-alpine

WORKDIR /app
COPY package*.json ./

RUN apk add --no-cache python3 make g++ \
    && ln -sf python3 /usr/bin/python
ENV PYTHON=python3
RUN npm install --omit=dev --legacy-peer-deps

COPY . .

CMD ["npm", "start"]
