# Robot Data Platform

A browser-based platform for managing robot learning datasets. It runs as a single Docker container that you access from any browser on your network.

## Features

### Data Conversion
- Convert HDF5 robot datasets to [LeRobot](https://github.com/huggingface/lerobot) format (Parquet + MP4)
- Auto-detect HDF5 field structure and suggest field mappings
- Manually configure field mappings (sensor data → `observation.state`, `action`, etc.)
- Incremental mode: append new episodes to an existing LeRobot dataset without overwriting
- Real-time conversion progress via WebSocket

### File Transfer
- Connect to a remote server over SSH and browse its filesystem
- Upload local files to the remote server with a progress bar
- Remote file management: create directories, rename files, delete files/directories
- Connection state persists across page navigation

### Data Visualization
- Visualize HDF5 and LeRobot datasets
- Display all camera streams simultaneously in a responsive grid, with the field name shown below each image
- Frame-by-frame playback with adjustable FPS, play/pause, and a scrubber
- Time-series charts for sensor and action data with per-field toggle
- Inline data editing: modify any numeric field value and write it back to the source file

## Architecture

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI + Python 3.11 + uvicorn |
| Frontend | React 18 + TypeScript + Vite + Ant Design 5 |
| Data I/O | h5py, pandas, pyarrow (Parquet), OpenCV (MP4) |
| Transfer | paramiko (SSH/SCP) |
| Real-time | WebSocket (FastAPI built-in) |
| Deployment | Multi-stage Docker build (Node → Python) |

The frontend is compiled into static files during the Docker build and served directly by uvicorn — no separate web server required.

## Requirements

- Docker 20.10+
- A directory on the host containing your robot data (HDF5 files, LeRobot datasets, etc.)

## Quick Start

### Option 1 — Docker Compose (recommended)

```bash
# Clone the repository
git clone <repo-url>
cd data_platform

# Start the container, mounting your data directory
DATA_DIR=/path/to/your/robot/data docker compose up -d
```

Then open `http://<host-ip>:8000` in your browser.

To stop:
```bash
docker compose down
```

### Option 2 — docker run

```bash
docker run -d \
  --name robot-data-platform \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /path/to/your/robot/data:/data \
  data-platform:latest
```

## Building the Image

```bash
# Build from source
docker build -t data-platform:latest .
```

The build has two stages:

1. **Node 20 Alpine** — installs npm dependencies and compiles the React frontend (`npm run build`)
2. **Python 3.11 Slim** — installs Python dependencies, copies the backend source, and copies the compiled frontend into `./static`

The final image is ~400 MB.

## Transferring the Image to Another Server

If the target server has no internet access, export the image and copy it manually:

```bash
# On the build machine: export
docker save data-platform:latest -o data-platform.tar

# Copy to the remote server (enter password when prompted)
scp data-platform.tar user@<remote-ip>:~/

# On the remote server: import and run
ssh user@<remote-ip>
docker load < ~/data-platform.tar
docker run -d --name robot-data-platform --restart unless-stopped \
  -p 8000:8000 -v /your/data:/data data-platform:latest
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `DATA_ROOT` | `/data` | Absolute path inside the container where data is mounted |
| `DATA_DIR` | `./data` | Host path to mount (docker-compose only, via `.env` or inline) |

All file paths in the UI are relative to `DATA_ROOT`. The container enforces that no path can escape this root (HTTP 403 for path traversal attempts).

## Data Format Reference

### HDF5 Input

The converter accepts any HDF5 file where the first dimension of each dataset is the time/frame axis. Image fields must have shape `(T, H, W)` or `(T, H, W, C)` with `dtype=uint8`.

### LeRobot Output Layout

```
<dataset>/
├── meta/
│   ├── info.json          # dataset metadata (fps, total_episodes, features, ...)
│   └── episodes.jsonl     # per-episode start/end frame indices
└── data/
    └── chunk-000/
        ├── episode_000000.parquet   # numeric fields (state, action, timestamp, ...)
        └── videos/
            └── <cam_key>/
                └── episode_000000.mp4
```

## Development

### Backend (FastAPI)

```bash
cd backend
pip install -r requirements.txt
DATA_ROOT=./test_data uvicorn app.main:app --reload
# API docs available at http://localhost:8000/docs
```

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
# Dev server at http://localhost:5173, proxies /api to http://localhost:8000
```
