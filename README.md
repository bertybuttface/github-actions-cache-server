# 🚀 GitHub Actions Cache Server

This is a drop-in replacement for the official GitHub hosted cache server. It is compatible with the official `actions/cache` action, so there is no need to change your workflow files and it even works with packages that internally use `actions/cache`.

## Features

- 🔥 **Compatible with official `actions/cache` action**
- 📦 Supports multiple storage solutions and is easily extendable.
- 🔒 Secure and self-hosted, giving you full control over your cache data.
- 😎 Easy setup

```yaml
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://localhost:3000
    volumes:
      - cache-data:/app/.data

volumes:
  cache-data:
```

## Benchmarking

Test upload/download performance:

```bash
# Start the server
pnpm dev

# In another terminal, run benchmark
pnpm benchmark

# Custom cache size and chunk size
CACHE_SIZE_MB=500 CHUNK_SIZE_MB=64 pnpm benchmark

# Test against remote server
API_BASE_URL=https://your-server.com pnpm benchmark
```

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
