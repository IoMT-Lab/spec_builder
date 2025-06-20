FROM node:latest

ADD . /app
WORKDIR /app
RUN npm install

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip && \
    rm -rf /var/lib/apt/lists/*
RUN pip3 install openai --break-system-packages

EXPOSE 4000
CMD ["npm", "start"]