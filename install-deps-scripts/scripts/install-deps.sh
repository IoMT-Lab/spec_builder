#!/usr/bin/env bash

set -euo pipefail

MIN_NODE_MAJOR=18
MIN_PYTHON_MAJOR=3
MIN_PYTHON_MINOR=10

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() {
    echo ""
    echo "==> $*"
}

have_modern_node() {
    if command -v node >/dev/null 2>&1; then
        local version
        version="$(node -v | sed 's/^v//')"
        local major="${version%%.*}"
        if [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )); then
            return 0
        fi
    fi
    return 1
}

have_modern_python() {
    if command -v python3 >/dev/null 2>&1; then
        if python3 -c "import sys; sys.exit(0 if sys.version_info >= (${MIN_PYTHON_MAJOR}, ${MIN_PYTHON_MINOR}) else 1)"; then
            return 0
        fi
    fi
    return 1
}

install_python_packages() {
    log "Ensuring pip is available"
    python3 -m ensurepip --upgrade >/dev/null 2>&1 || true

    log "Installing Python packages (user scope)"
    python3 -m pip install --user --upgrade pip
    python3 -m pip install --user --upgrade "openai>=1.60.0"
}

npm_install_if_present() {
    local target="$1"
    local label="$2"
    if [[ -f "${target}/package.json" ]]; then
        log "Installing Node dependencies in ${label}"
        (cd "${target}" && npm install)
    else
        log "Skipping ${label} (no package.json found)"
    fi
}

install_project_packages() {
    npm_install_if_present "${REPO_ROOT}" "repo root"
    npm_install_if_present "${REPO_ROOT}/backend" "backend"
    npm_install_if_present "${REPO_ROOT}/frontend" "frontend"
}

ensure_env_file() {
    local target="$1"
    local label="$2"
    if [[ -f "${target}" ]]; then
        log ".env for ${label} already exists; skipping"
    else
        log "Creating ${label} .env file at ${target}"
        cat <<EOF > "${target}"
# Environment variables for ${label}
OPENAI_API_KEY=
GEMINI_API_KEY=
EOF
    fi
}

create_env_files() {
    ensure_env_file "${REPO_ROOT}/backend/.env" "backend"
}

# Function to install dependencies on macOS
install_macos() {
    log "Detected macOS. Installing dependencies…"
    if ! command -v brew >/dev/null 2>&1; then
        echo "Homebrew is required on macOS. Please install it first: https://brew.sh/"
        exit 1
    fi

    log "Updating Homebrew formulae"
    brew update

    if have_modern_node; then
        log "Node $(node -v) already satisfies version >= ${MIN_NODE_MAJOR}"
    else
        log "Installing Node.js (includes npm)"
        brew install node
    fi

    if have_modern_python; then
        log "Python $(python3 --version | awk '{print $2}') already satisfies version >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}"
    else
        log "Installing Python 3 via Homebrew"
        brew install python@3.11
        # shellcheck disable=SC1091
        if [[ -f "$(brew --prefix python@3.11)/bin/python3" ]]; then
            export PATH="$(brew --prefix python@3.11)/bin:${PATH}"
        fi
    fi

    install_python_packages
    install_project_packages
}

# Function to install dependencies on Ubuntu
install_ubuntu() {
    log "Detected Ubuntu. Installing dependencies…"
    if ! command -v sudo >/dev/null 2>&1; then
        echo "This script requires sudo privileges on Ubuntu."
        exit 1
    fi

    log "Updating apt repositories"
    sudo apt-get update

    log "Installing base packages"
    sudo apt-get install -y ca-certificates curl gnupg

    if have_modern_node; then
        log "Node $(node -v) already satisfies version >= ${MIN_NODE_MAJOR}"
    else
        log "Setting up NodeSource repo for Node.js 20.x"
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        log "Installing Node.js"
        sudo apt-get install -y nodejs
    fi

    log "Installing development tools and Python 3"
    sudo apt-get install -y build-essential git python3 python3-venv python3-pip

    if ! have_modern_python; then
        echo "Warning: Python $(python3 --version | awk '{print $2}') is older than ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}. Consider upgrading manually if you encounter issues."
    fi

    install_python_packages
    install_project_packages
}

# Check the operating system and install dependencies accordingly
if [[ "$OSTYPE" == "darwin"* ]]; then
    install_macos
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    install_ubuntu
else
    echo "Unsupported operating system: $OSTYPE"
    exit 1
fi

create_env_files

log "Dependencies installed successfully."
echo "Next steps:"
echo "- Set OPENAI_API_KEY (and GEMINI_API_KEY if applicable) in your environment."
echo "- Start the backend with: (cd backend && npm start)"
echo "- Start the frontend with: (cd frontend && npm run dev)"
