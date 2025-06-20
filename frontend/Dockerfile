FROM node:latest

ADD . /app
WORKDIR /app

RUN npm install --legacy-peer-deps
RUN npm run build && \
    npm install -g serve

EXPOSE 3000
CMD ["serve", "-s", "build"]
