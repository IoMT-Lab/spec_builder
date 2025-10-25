# Quick Start Guide - Docker Deployment

**TL;DR** - Get this running in 3 minutes:

## Step 1: Set Up Environment
```bash
cp .env.example .env
# Open .env and add your OpenAI API key
# Get one at: https://platform.openai.com/api-keys
nano .env
```

## Step 2: Start Everything
```bash
docker-compose up
```

## Step 3: Open in Browser
- **Frontend:** http://localhost:5173
- **Backend:** http://localhost:4000

---

## Troubleshooting

**Docker not installed?**
- Download from https://www.docker.com/products/docker-desktop

**API Key errors?**
- Check your `.env` file has `OPENAI_API_KEY=sk-...`
- Verify the key is valid at https://platform.openai.com/account/api-keys

**Port already in use?**
Edit `docker-compose.yml`:
```yaml
ports:
  - "8000:4000"  # Use 8000 instead of 4000
```

**Want to see logs?**
```bash
docker-compose logs -f
```

**Want to stop everything?**
```bash
docker-compose down
```

---

## Need More Details?
See `DOCKER_DEPLOYMENT.md` for full deployment guide  
See `DEPLOYMENT_CHECKLIST.md` for what's ready and what's not  
See `README.md` for architecture overview
