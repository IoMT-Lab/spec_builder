FROM node:latest

RUN apt-get update && apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    git \
    gnupg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install openai --break-system-packages

COPY backend/ /app/backend/
COPY demos/ /app/demos/
COPY frontend/ /app/frontend/
COPY llm/ /app/llm/
COPY scenarios/ /app/scenarios/
COPY scripts/ /app/scripts/
COPY package.json /app/
COPY package-lock.json /app/

WORKDIR /app
RUN cd /app/frontend && npm install
RUN cd /app/backend && npm install
RUN cd /app && npm install

ENV OPENAI_API_KEY=""

COPY docker/docker-entrypoint.sh /
ENTRYPOINT ["/docker-entrypoint.sh"]