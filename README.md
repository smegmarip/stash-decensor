# Stash Decensor

A dockerized web service that uses **lada** to decensor (restore pixelated) videos, integrated with **Stash** via a JavaScript plugin.

## Features

- **AI-powered decensoring** using lada with NVIDIA GPU acceleration
- **Async job queue** with Redis for reliable processing
- **Real-time progress** via WebSocket updates
- **Stash integration** via JavaScript plugin
- **Job monitoring UI** for tracking processing status

## Architecture

```
┌──────────────┐    ┌─────────────────┐    ┌─────────────────┐
│    Stash     │◄───│  decensor-api   │◄───│ decensor-worker │
│   (9999)     │    │  (FastAPI:5030) │    │ (lada + A4000)  │
│  ┌────────┐  │    └────────┬────────┘    └─────────────────┘
│  │Plugin  │──┼────────────►│
│  └────────┘  │             │
└──────────────┘    ┌────────▼────────┐    ┌─────────────────┐
                    │     Redis       │    │   jobs-viewer   │
                    │    (6379)       │    │   (React:5031)  │
                    └─────────────────┘    └─────────────────┘
```

## Prerequisites

- Docker with NVIDIA runtime support
- NVIDIA GPU (tested with A4000, 16GB VRAM)
- Stash instance
- Shared media volume accessible by both Stash and this service

## Quick Start

1. **Clone and configure:**
   ```bash
   cp .env.example .env
   # Edit .env with your Stash URL, API key, and media path
   ```

2. **Start services:**
   ```bash
   docker-compose up -d
   ```

3. **Install Stash plugin:**
   - Copy the `stash-plugin` folder to your Stash plugins directory
   - Reload plugins in Stash Settings > Plugins

4. **Configure tags (optional):**
   - Create "censored" and "decensored" tags in Stash
   - Add their IDs to `.env` for automatic tag management

## Services

| Service | Port | Description |
|---------|------|-------------|
| decensor-api | 7030 | FastAPI job management service |
| jobs-viewer | 7031 | React job monitoring UI |
| redis | 6379 (internal) | Job queue and state storage |
| decensor-worker | - | Lada container for GPU processing |

Ports are customizable via `API_PORT` and `UI_PORT` environment variables.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/decensor/jobs` | Submit decensor job |
| GET | `/decensor/jobs/{job_id}/status` | Get job status |
| GET | `/decensor/jobs/{job_id}/results` | Get job results |
| GET | `/decensor/jobs` | List all jobs |
| DELETE | `/decensor/jobs/{job_id}` | Cancel/delete job |
| GET | `/decensor/health` | Health check |
| WS | `/decensor/ws` | WebSocket for real-time updates |

## Plugin Usage

1. Tag a scene with your "censored" tag
2. Open the scene page in Stash
3. Click the "Decensor" button in the toolbar
4. Monitor progress via toast notifications
5. On completion:
   - Decensored file is scanned and merged into the original scene
   - Tags are updated (censored removed, decensored added)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STASH_URL` | - | Stash server URL |
| `STASH_API_KEY` | - | Stash API key |
| `MEDIA_PATH` | - | Shared media volume path |
| `CENSORED_TAG_ID` | - | Stash tag ID for "censored" |
| `DECENSORED_TAG_ID` | - | Stash tag ID for "decensored" |
| `ENCODING_PRESET` | `hevc-nvidia-gpu-hq` | Lada encoding preset |
| `MAX_CLIP_LENGTH` | `180` | Max clip length for processing |
| `FP16` | `true` | Use FP16 for reduced VRAM |
| `JOB_TIMEOUT` | `7200` | Job timeout in seconds |
| `CACHE_TTL` | `86400` | Job retention in seconds |
| `API_PORT` | `7030` | External port for API service |
| `UI_PORT` | `7031` | External port for jobs viewer UI |

### Lada Encoding Presets

- `hevc-nvidia-gpu-hq` - High quality HEVC via NVENC (recommended)
- `hevc-nvidia-gpu` - Standard quality HEVC
- `h264-nvidia-gpu-hq` - High quality H.264
- `h264-nvidia-gpu` - Standard quality H.264

## Troubleshooting

### GPU not detected
Ensure NVIDIA runtime is configured:
```bash
docker run --rm --gpus all nvidia/cuda:11.0-base nvidia-smi
```

### Job stuck in processing
Check worker logs:
```bash
docker-compose logs -f decensor-worker
docker-compose logs -f decensor-api
```

### Plugin not appearing
- Verify plugin files are in the correct directory
- Check Stash logs for JavaScript errors
- Reload plugins in Stash settings

## License

MIT
