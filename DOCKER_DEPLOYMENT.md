# Docker Deployment Guide

## For Local Development

### 1. Set up environment file
```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
nano .env
```

### 2. Run with docker-compose
```bash
docker-compose up --build
```

Your app will be available at:
- Frontend: http://localhost:5173
- Backend: http://localhost:4000

## For Production Deployment

### 1. Create .env file with your API key
```bash
echo "OPENAI_API_KEY=sk-your-actual-key-here" > .env
```

### 2. Option A: Using docker-compose on server
```bash
# Pull your code from git
git clone <your-repo>
cd spec_builder

# Create .env with your API key
nano .env

# Run
docker-compose up -d
```

### 3. Option B: Using Docker directly
```bash
# Build the image
docker build -f docker/Dockerfile -t spec-builder:latest .

# Run with API key (never hardcode it!)
docker run -d \
  -e OPENAI_API_KEY=sk-your-actual-key-here \
  -p 80:4000 \
  -p 3000:5173 \
  --name spec-builder \
  spec-builder:latest
```

### 4. Option C: Push to registry (AWS, Docker Hub, etc.)
```bash
# Build
docker build -f docker/Dockerfile -t your-registry/spec-builder:latest .

# Login to registry
docker login

# Push
docker push your-registry/spec-builder:latest

# On server, pull and run
docker pull your-registry/spec-builder:latest
docker run -d \
  -e OPENAI_API_KEY=sk-your-actual-key-here \
  -p 80:4000 \
  your-registry/spec-builder:latest
```

## Security Best Practices

✅ **DO:**
- Keep `.env` file locally only (in `.gitignore`)
- Pass API key as environment variable at runtime
- Use secrets manager for production (AWS Secrets Manager, HashiCorp Vault, etc.)
- Never commit API keys to git

❌ **DON'T:**
- Hardcode API keys in Dockerfile
- Commit `.env` to git
- Share API keys in code or chat

## View Logs

```bash
# See container logs
docker-compose logs -f

# Or with docker directly
docker logs -f spec-builder
```

## Stop Container

```bash
docker-compose down
```
