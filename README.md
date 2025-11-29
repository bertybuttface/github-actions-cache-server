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

Test upload/download performance with statistical analysis:

```bash
# Start the server
pnpm dev

# In another terminal, run benchmark (default: 10 iterations)
pnpm benchmark

# Quick test with single iteration
ITERATIONS=1 pnpm benchmark

# Custom parameters
CACHE_SIZE_MB=500 CHUNK_SIZE_MB=64 ITERATIONS=20 pnpm benchmark

# Test against remote server
API_BASE_URL=https://your-server.com pnpm benchmark
```

The benchmark runs multiple iterations (default: 10) and reports statistical metrics including mean, median, standard deviation, min, and max throughput.

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
