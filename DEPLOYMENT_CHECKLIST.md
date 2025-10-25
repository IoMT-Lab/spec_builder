# Deployment Checklist

Here's everything you need to do before someone can deploy this app:

## ✅ Pre-Deployment Verification

### 1. API Key Configuration
- [x] Removed hardcoded `OPENAI_API_KEY` from Dockerfile
- [x] Created `.env.example` template
- [x] `.env` file is in `.gitignore` (secrets won't leak to GitHub)
- [x] Backend reads from `process.env.OPENAI_API_KEY`
- [x] docker-compose passes env var to container

### 2. Port Configuration
- [x] Backend: Uses `process.env.PORT || 4000` (configurable)
- [x] Frontend: Vite dev server runs on 5173 (default)
- [x] docker-compose exposes both ports
- [x] No hardcoded ports in code

### 3. Documentation
- [x] README.md exists with architecture overview
- [x] DOCKER_DEPLOYMENT.md created with step-by-step instructions
- [x] .env.example shows required configuration
- [x] This checklist file

### 4. Environment Variables Needed
Users must provide when deploying:
- `OPENAI_API_KEY` - Required for LLM functionality
- `PORT` - Optional (defaults to 4000)

Additional optional vars (already configured in backend):
- `GEMINI_API_KEY` - Optional, for Gemini support
- `UI_DEFAULT_LLM` - Optional, LLM model selection
- `CODE_MAX_CHARS_PER_FILE` - Optional (default: 40000)
- `CODE_MAX_SELECTED_FILES` - Optional (default: 6)
- `CODE_TEST_STRICT_MODE` - Optional (default: 0)

### 5. Dockerfile & Docker Compose
- [x] Dockerfile builds correctly
- [x] docker-compose.yml configured for easy deployment
- [x] `.dockerignore` excludes unnecessary files
- [x] Volumes mounted for sessions and documents persistence
- [x] Restart policy set to `unless-stopped`

### 6. File Structure
Required directories (created at runtime or persist as volumes):
- `/app/sessions/` - Session data storage
- `/app/Documents/` - PRD documents storage
- `/app/code_jobs/` - Code generation job outputs (created by backend)

## 🚀 Deployment Instructions for End User

```bash
# 1. Clone repository
git clone <your-repo-url>
cd spec_builder

# 2. Create .env file with API key
cp .env.example .env
nano .env  # Add your OPENAI_API_KEY

# 3. Run with Docker Compose
docker-compose up

# 4. Access the app
# Frontend: http://localhost:5173
# Backend: http://localhost:4000
```

## 🔍 Common Deployment Issues & Solutions

### Issue: "API key not found" or LLM requests fail
**Solution:** 
```bash
# Verify .env file exists and has OPENAI_API_KEY
cat .env

# Restart containers
docker-compose restart
```

### Issue: Port 4000 or 5173 already in use
**Solution:** Edit docker-compose.yml:
```yaml
ports:
  - "8000:4000"  # Change first number to available port
  - "3000:5173"  # Change first number to available port
```

### Issue: Sessions/Documents lost after container restart
**Solution:** Already handled! Volumes are mounted:
```yaml
volumes:
  - ./sessions:/app/sessions
  - ./Documents:/app/Documents
```

### Issue: Container won't start
**Solution:** Check logs:
```bash
docker-compose logs -f
```

## 📋 Pre-Production Considerations

> ⚠️ **Note:** The README mentions: *"There are no production-grade security controls by default. Do not run this on a public server without adding proper authentication, path sanitization, and other hardening."*

Before exposing to the internet, consider:

1. **Authentication** - Add login/authentication layer
2. **HTTPS** - Use Let's Encrypt or similar
3. **Input Validation** - Sanitize file paths and user inputs
4. **Rate Limiting** - Prevent API abuse
5. **Secrets Management** - Use AWS Secrets Manager, HashiCorp Vault, etc. instead of .env files
6. **Logging & Monitoring** - Add comprehensive logging for debugging
7. **Backups** - Backup sessions and documents regularly

## ✨ What's Ready

✅ **Deployment Ready:**
- Docker image builds cleanly
- Environment variables properly configured
- Secrets not hardcoded
- Documentation provided
- Port configuration flexible
- Data persistence configured

✅ **Secure for Local/Private Deployment:**
- API key never in image or git
- Configuration externalized
- All sensitive files gitignored

⚠️ **NOT Ready for Public Internet Without:**
- Authentication layer
- HTTPS/TLS
- Security hardening (see Pre-Production Considerations above)
- Proper secrets management

## 📞 Troubleshooting Commands

```bash
# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f app

# Rebuild image
docker-compose up --build

# Remove everything and start fresh
docker-compose down -v
docker-compose up

# Check if ports are accessible
curl http://localhost:4000/api/health
curl http://localhost:5173

# Execute command in running container
docker-compose exec app sh

# View environment inside container
docker-compose exec app env
```

## 🎯 Summary: You're Ready!

Everything needed for deployment is in place:
1. API key configuration ✓
2. Docker setup ✓
3. Environment variables ✓
4. Documentation ✓
5. Persistence layer ✓
6. Flexible ports ✓

**Next step:** Share this repo with someone and have them follow the instructions in DOCKER_DEPLOYMENT.md!
