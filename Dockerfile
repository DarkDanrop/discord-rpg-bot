FROM node:20-bullseye

WORKDIR /app

COPY package*.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && ln -sf python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=python3

RUN npm install --omit=dev --legacy-peer-deps

COPY . .

CMD ["npm", "start"]
